/**
 * BOSS直聘 自动打招呼
 * ----------------------------------------------------------------------------
 * 做的事：搜岗位 -> 逐个点进职位 -> 点"立即沟通" -> 填招呼语 -> 发送
 * 不做：投简历、传附件（简历你在平台上挂好，打招呼时 HR 能看到在线简历）
 *
 * 两种运行模式：
 *
 *   [推荐] CDP 模式 —— 连接你自己开着的 Chrome
 *     真实浏览器、真实登录态、真实指纹，最不容易被风控盯上。
 *     先用 启动Chrome调试.bat 启动 Chrome，再跑本脚本。
 *
 *   [备用] 独立模式 —— 脚本自己起一个 Chrome
 *     首次要扫码登录。会被风控更严地对待。
 *
 * 用法：
 *   node greet.js --dry-run          只搜岗位不打，看看能捞到啥
 *   node greet.js                    正式跑
 *   node greet.js -k 运维 -n 10       单关键词，最多 10 个
 *   node greet.js --no-cdp           用独立模式（自己起浏览器）
 *
 * 重构：主流程按功能拆进 lib/（ipc / browser-session / login-guard /
 * collect / send / pool），本文件只留「参数 + 单实例锁 + main() 编排」。零逻辑改动。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------- 浏览器驱动选型（关键）----------
// 用 Patchright（Playwright 的官方反检测分支），而不是原生 Playwright。
//
// A/B 实测对照（同一台机器、同样启动参数、同一个 URL，唯一变量是驱动）：
//   原生 Playwright → 36 秒内被 BOSS 踢了 52 次，最后卡片 0 个
//   Patchright      → 36 秒内只导航 6 次，卡片稳定 17 个
//
// 原因：原生 Playwright 连接时会发 CDP 的 Runtime.enable，这会在页面上下文里
// 留下可被检测的痕迹，BOSS 的风控就是靠这个认出自动化的。Patchright 从驱动层面
// 消除了这个泄露 —— 不是"伪装得更像人"，而是根本不留下自动化痕迹。
// 这也是账号安全的根本保障：不触发风控，就不会被限流或标记。
//
// API 完全一致，属于 drop-in replacement，所以下面的代码一个字都不用改。
// （加载与回退逻辑在上面"引擎名"那一段，已完成）

const { DIR, DATA_DIR } = require('./lib/data-dir');   // 用户数据统一放 data/（加载时自动迁移老文件）
const CFG = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
// profileDir 允许写相对路径（相对项目目录）—— 开源默认用项目内的 .chrome-profile，
// 别人 clone 下来不用改路径；写绝对路径也照常生效。
if (!CFG.profileDir || !path.isAbsolute(CFG.profileDir)) {
  CFG.profileDir = path.resolve(DIR, CFG.profileDir || '.chrome-profile');
}
const LOG_DIR = path.join(DIR, 'logs');
const SENT_FILE = path.join(LOG_DIR, '已打招呼记录.txt');
const SKIP_FILE = path.join(LOG_DIR, '黑名单.txt');   // 反复失败的岗位，不再尝试

// ---------- 独立子系统（lib/）----------
// 重构：自包含子系统迁出 lib/，同名解构 = main 调用点零修改。
// 依赖注入方式见各文件头部注释。
const {
  DRY_RUN, USE_CDP, CDP_PORT, FORCE_MAX, KW_INDEX, FORCE_KEYWORD, FORCE_KEYWORDS,
  FORCE_CITY_CODE, FORCE_CITY_NAME, SOURCE, EXPECT_TAB,
  MODE, SEND_LIST_FILE, CONFIRM_EACH, FILL_ONLY, CLOSE_BROWSER, KEEP_OPEN_MAX_MS, hasFlag,
} = require('./lib/args');
const { acquireLock, releaseLock } = require('./lib/lock')(CFG.profileDir);
const { loadSkipList, saveSkipList, markFail } = require('./lib/blacklist')(SKIP_FILE);
const { sleep, rnd, stamp, withoutProxy, localDate, localDateTime, CHROME,
        cyan, yellow, green, red, gray, white } = require('./lib/utils');
const { KNOWLEDGE, KNOWLEDGE_FILE, normalizeEntries } = require('./lib/knowledge')(DATA_DIR);
const { buildGreeting, isGuardUrl } = require('./lib/greeting');
const { searchUrl, favUrl, readExpectTabs, clickExpectTab } = require('./lib/search')(CFG, SOURCE);
const { clickByText, clickGreetButton, clickSendButton, fillGreeting, humanWheelScroll, confirmChangeJobDialog } = require('./lib/page-helpers');
const { killChromeUsingProfile } = require('./lib/chrome-kill')(CFG.profileDir, LOG_DIR);

// 长尾两段间隔的通用实现：
//   75% 走主段（干脆利落），25% 走尾段（像被别的事拖了一下）。
// 为什么不用单段均匀：均匀分布每个值等概率，本身就是机器特征；真人的间隔
// 是长尾的（多数短、偶尔长）。两段平均不变、只是形态自然得多。
function tailDelay(mainMin, mainMax, tailRatio, tailMin, tailMax) {
  return Math.random() < tailRatio ? rnd(tailMin, tailMax) : rnd(mainMin, mainMax);
}

// 发送间隔（岗位之间）：4~6 秒为主，偶尔 6~12 秒，平均约 6 秒
function nextDelaySec() {
  return tailDelay(
    CFG.delayMinSec || 4, CFG.delayMaxSec || 6,
    CFG.delayTailRatio != null ? CFG.delayTailRatio : 0.25,
    CFG.delayTailMinSec || 6, CFG.delayTailMaxSec || 12
  );
}

// 爬取间隔（读 JD 之间）：4~7 秒为主，偶尔 7~11 秒，平均约 6.4 秒
// （原来是 4~9 秒均匀、平均 6.5 秒 —— 量级不变，只把上限抬 2 秒用于分长尾）
function nextCollectDelaySec() {
  return tailDelay(
    CFG.collectDelayMinSec || 4, CFG.collectDelayMaxSec || 7,
    CFG.collectDelayTailRatio != null ? CFG.collectDelayTailRatio : 0.25,
    CFG.collectDelayTailMinSec || 7, CFG.collectDelayTailMaxSec || 11
  );
}

// 详情页的 referer：补上「列表页 → 详情页」的跳转链。
// 真人的 referer 是搜索/推荐列表页；我们直接 goto 时要么不带（换新标签之后），
// 要么带的是上一个详情页（连续导航）—— 这是服务端可见的爬虫特征。
// 用「推荐流」列表页 URL（不带 query，真人最常见的浏览入口）。
// 惰性求值：FORCE_CITY_CODE 覆盖 CFG.cityCode 之后调用也拿得到最新值。
const listReferer = () => {
  const exp = CFG.experience ? `&experience=${CFG.experience}` : '';
  return `https://www.zhipin.com/web/geek/job?city=${CFG.cityCode || ''}${exp}`;
};
if (FORCE_CITY_CODE) CFG.cityCode = FORCE_CITY_CODE;   // 界面临时覆盖城市（不改 config.json）
if (FORCE_CITY_NAME) CFG.cityName = FORCE_CITY_NAME;
process.on('exit', releaseLock);


// 引擎名：patchright 装了就用它（反检测），否则退回 playwright-core（会被风控识别）
let chromium;
let ENGINE_NAME = 'Playwright(未装patchright!)';
try {
  ({ chromium } = require('patchright'));
  ENGINE_NAME = 'Patchright';
} catch (_) {
  ({ chromium } = require('playwright-core'));
  console.error('');
  console.error('  [警告] 没找到 patchright，已退回原生 Playwright。');
  console.error('         原生 Playwright 会被 BOSS 风控识别，请执行： npm install patchright');
  console.error('');
}


if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });


// ---------- GUI 模式（IPC）----------
// server.js 用子进程驱动本脚本时加 --ipc：
//   事件 → stdout（前缀 @@IPC@@ + JSON 一行），界面实时显示
//   指令 ← stdin（PAUSE / RESUME / STOP），界面上的按钮
// 不加这个参数时，脚本行为和以前完全一致（纯命令行）。
const IPC = hasFlag('--ipc');
const ipc = require('./lib/ipc')({ ipc: IPC, sleep });
const { ipcEmit, waitForCmd, waitForCmdWithin, checkpoint, StoppedError, isStopped, hasCmdWaiter } = ipc;

// --no-pause：跳过所有"按回车继续"。自动化/无人值守跑的时候必须加，
// 否则脚本干完活会一直挂在等待输入的提示上（表现为"卡了半天"）。
// GUI 模式天然不需要暂停（界面上的按钮才是控制方式）。
const NO_PAUSE = hasFlag('--no-pause') || IPC;


const logLines = [];
// 日志文件：实时追加，这样中途退出也能看到进展
const RUN_LOG = path.join(LOG_DIR, `run-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.log`);
function log(msg, tag = '') {
  const line = `[${stamp()}]${tag ? ' ' + tag : ''} ${msg}`;
  console.log(line);
  logLines.push(line);
  try { fs.appendFileSync(RUN_LOG, line + '\n', 'utf8'); } catch (_) {}
  // 同步推给界面（GUI 模式下才有订阅方）
  ipcEmit({ t: 'log', tag, msg, ts: stamp() });
}


function todayCount() {
  if (!fs.existsSync(SENT_FILE)) return 0;
  const today = localDate();
  // 只数「已发送」的行（记录里还有「已填入到输入框」的过渡态；旧格式无状态段=已发送）
  return fs.readFileSync(SENT_FILE, 'utf8').split('\n')
    .filter(l => l.startsWith(today) && !l.includes('已填入到输入框')).length;
}

async function waitEnter() {
  // --no-pause 或非交互环境（管道/重定向）直接跳过，绝不挂死
  if (NO_PAUSE || !process.stdin.isTTY) { await sleep(300); return; }
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  try {
    // 【兜底】最多等 3 分钟。之前出现过"用户以为跑完了、脚本还在等回车"的情况，
    // 结果进程挂几十分钟不退出。加个超时，到点自动走。
    await Promise.race([
      new Promise(res => rl.question('', res)),
      sleep(3 * 60 * 1000),
    ]);
  } finally {
    try { rl.close(); } catch (_) {}
  }
}


// 节奏参数（设置页可调）：从 config 读一对 min/max（毫秒/像素）。
// 缺值用默认兜底；用户把 min/max 填反了也能自动排序（天然容错）
function paceRand(minKey, maxKey, dMin, dMax) {
  let a = Number(CFG[minKey]);
  let b = Number(CFG[maxKey]);
  if (!Number.isFinite(a)) a = dMin;
  if (!Number.isFinite(b)) b = dMax;
  return rnd(Math.min(a, b), Math.max(a, b));
}


// ---------- 子系统接线 ----------
// 运行时会话状态：browser / ctx(浏览器上下文) / page / closer —— connectBrowser 填充，各模块共享。
const rt = { browser: null, ctx: null, page: null, closer: null };

const { connectBrowser } = require('./lib/browser-session')({
  rt, CFG, USE_CDP, CDP_PORT, ENGINE_NAME, chromium, killChromeUsingProfile,
  CLOSE_BROWSER, KEEP_OPEN_MAX_MS, log, ipcEmit, checkpoint, waitForCmdWithin,
});

const guard = require('./lib/login-guard')({
  rt, log, ipcEmit, isGuardUrl, StoppedError, isStopped,
});
const { ensureLogin, passGuard, realUrl, isSecurityPage, isKickedToLogin, gotoWithGuard, sec, SECURITY_STOP_AT } = guard;

const { poolKey, loadPoolKeys, mergeIntoPool } = require('./lib/pool')({ LOG_DIR });

const collect = require('./lib/collect')({
  rt, CFG, SOURCE, EXPECT_TAB, FORCE_MAX,
  log, ipcEmit, checkpoint, StoppedError, sec, SECURITY_STOP_AT,
  buildGreeting, isGuardUrl, searchUrl, favUrl, readExpectTabs, clickExpectTab,
  humanWheelScroll, gotoWithGuard, passGuard, realUrl, isSecurityPage, isKickedToLogin,
  listReferer, paceRand, nextCollectDelaySec, waitEnter,
  poolKey, loadPoolKeys, mergeIntoPool,
});

const send = require('./lib/send')({
  rt, CFG, SENT_FILE, SEND_LIST_FILE, CONFIRM_EACH, FILL_ONLY,
  log, ipcEmit, checkpoint, StoppedError, isStopped, waitForCmd, hasCmdWaiter,
  buildGreeting, listReferer, paceRand, nextDelaySec, todayCount, waitEnter,
  clickGreetButton, clickSendButton, fillGreeting, confirmChangeJobDialog,
  gotoWithGuard, realUrl, loadSkipList, markFail, sec, SECURITY_STOP_AT,
});

// 「打开 BOSS」模式：只把浏览器带到 BOSS 首页，不跑任何任务（见 lib/open-browser.js）
const openBrowser = require('./lib/open-browser')({ rt, log });


// ============================================================================

async function main() {
  // ---------- 单实例检查 ----------
  // 有别的实例还活着就立刻退，绝不跟它抢浏览器。
  const lk = acquireLock();
  if (!lk.ok) {
    log(`另一个任务正在跑（pid ${lk.pid}），本次不重复启动`, 'WARN');
    ipcEmit({ t: 'error', msg: `已有任务在跑（pid ${lk.pid}），重复启动被拦截 —— 如果界面卡住，先点「停止」再开始` });
    await sleep(500);
    process.exit(0);
  }

  let keywords = FORCE_KEYWORDS.length
    ? FORCE_KEYWORDS
    : (FORCE_KEYWORD ? [FORCE_KEYWORD] : CFG.keywords);
  // --kw-index N：按 config 序号选一个关键词（绕开命令行中文编码问题）
  if (KW_INDEX > 0) {
    const k = CFG.keywords[KW_INDEX - 1];
    if (k) keywords = [k];
    else { console.error(`--kw-index ${KW_INDEX} 超出范围，config 里共 ${CFG.keywords.length} 个关键词`); process.exit(1); }
  }
  // 推荐 / 收藏模式：不需要关键词，循环只跑一轮（kw 只用于 log 显示）
  if (SOURCE === 'recommend') keywords = ['系统推荐'];
  else if (SOURCE === 'fav') keywords = ['我的收藏'];
  const maxJobs = FORCE_MAX || CFG.maxJobsPerRun;
  const done = todayCount();

  console.log('');
  console.log(cyan('==========================================='));
  console.log(cyan('  BOSS 自动打招呼'));
  console.log(cyan('==========================================='));
  log(`模式: ${DRY_RUN ? '演练(不打招呼)' : '正式投递'} / ${USE_CDP ? 'CDP连接' : '独立浏览器'}`);
  log(SOURCE === 'recommend'
    ? `来源: 系统推荐流（按你勾选的意向岗位）/ 城市: ${CFG.cityName || ''}`
    : SOURCE === 'fav'
      ? '来源: 我的收藏（你在 BOSS 收藏的岗位，不套城市 / 筛选）'
      : `关键词: ${keywords.join('、')}`);
  log(`今日已打招呼: ${done} / 上限 ${CFG.dailyCap}`);
  console.log('');
  ipcEmit({
    t: 'start', dryRun: DRY_RUN, keywords, maxJobs,
    city: CFG.cityName || '', cityCode: CFG.cityCode,
    dailyUsed: done, dailyCap: CFG.dailyCap,
  });

  // ---------- 连接浏览器 + 预热 ----------
  await connectBrowser();
  // 【保活不占锁】closer() 里是"保持浏览器开着等指令"的保活等待（最长 1 小时）。
  // 单实例锁只保护"任务正在跑"的阶段；进入保活 = 活已经干完了，必须先把锁放掉。
  // 否则一个几秒就完的只读任务（如 --mode=expects）会把锁占着直到保活超时 ——
  // 表现为新任务被拦下报"已有任务在跑（pid xxx）"。releaseLock 幂等，
  // 末尾 process.on('exit', releaseLock) 那次再调只是安全的空操作。
  {
    const innerCloser = rt.closer;
    rt.closer = async () => { releaseLock(); await innerCloser(); };
  }
  await checkpoint();   // 预热结束后再查一次，避免带着停止指令继续访问 BOSS

  // ---------- 模式：只打开浏览器（供你自己上 BOSS 用，不跑任何任务）----------
  // 放在「确认登录」之前：这一步纯粹是把浏览器开起来，不替你做登录判定。
  // 收尾走 rt.closer()（已被包成 releaseLock + 广播「浏览器保持开着」）；
  // CDP 模式下 Chrome 是 detached 起的，本进程退出它不会跟着关。
  if (MODE === 'open') { await openBrowser.runOpenMode(); await rt.closer(); return; }

  // ---------- 先确认登录，再干活 ----------
  // 没登录就跑 = 白跑一趟还浪费机会。这一步必须挡在最前面。
  if (!await ensureLogin()) {
    await rt.closer();
    return;
  }

  // ---------- 模式：只读意向岗位页签（来源「意向页签」第一步，几秒就完）----------
  // 【注意】必须放在搜索流程之前 —— 下面有个 jobs.length===0 的退出守卫，
  // expects 模式不搜索，走不到那里就会先被弹掉。
  if (MODE === 'expects') { await collect.runExpectsMode(); return; }

  // ---------- 模式：按清单发送（清单由界面生成）----------
  // 到这里已经连上浏览器了。不搜索，直接按清单逐个发。
  if (MODE === 'send') { await send.runSendMode(); return; }

  // ---------- 收集岗位 ----------
  const jobs = [];
  await collect.collectJobs(jobs, keywords);
  console.log('');

  if (jobs.length === 0) {
    console.log(yellow('  一个都没捞到。可能：被风控拦 / 关键词太窄 / 页面改版。'));
    console.log('');
    ipcEmit({ t: 'done', sent: 0, total: 0, reason: 'no-candidates' });
    await waitEnter();
    await rt.closer();
    return;
  }

  console.log(white('  候选清单：'));
  log('---- 候选清单 ----');
  console.log(gray('  ------------------------------------------------------------'));
  jobs.slice(0, 60).forEach((j, i) => {
    const flag = DRY_RUN ? '[演练]' : '[待投]';
    const area = (j.area || '').padEnd(12).slice(0, 12);
    console.log(gray(`  ${String(i + 1).padStart(2)}. ${j.job.padEnd(18).slice(0, 18)} | ${area} | ${(j.company || '').padEnd(14).slice(0, 14)} ${flag}`));
    log(`${String(i + 1).padStart(2)}. ${j.job} | ${j.area || ''} | ${j.company || ''}`);
  });
  console.log(gray('  ------------------------------------------------------------'));
  console.log('');

  // ---------- 模式：只收集（读 JD + 生成招呼语，一条消息都不发）----------
  // 界面工作台用这个模式：先让你看到每个岗位的 JD、招聘者活跃度、以及定制好的招呼语，
  // 你自己勾选、编辑，然后再调 send 模式发送。这样账号最安全 —— 发出去之前你都看过。
  if (MODE === 'collect') { await collect.runCollectMode(jobs); return; }

  if (DRY_RUN) {
    console.log(cyan('  演练结束，没打招呼。'));
    console.log('');
    ipcEmit({ t: 'done', sent: 0, total: jobs.length, dryRun: true });
    await waitEnter();
    await rt.closer();
    return;
  }

  if (done >= CFG.dailyCap) {
    console.log(yellow(`  今日已达上限 ${CFG.dailyCap}，明天再跑。`));
    console.log('');
    ipcEmit({ t: 'done', sent: 0, total: jobs.length, reason: 'daily-cap' });
    await waitEnter();
    await rt.closer();
    return;
  }

  // ---------- 逐个打招呼 ----------
  const sent = await send.autoGreetAll(jobs, maxJobs, done);

  // ---------- 收尾 ----------
  const logFile = RUN_LOG;

  console.log('');
  console.log(cyan('  ============================================================'));
  console.log(cyan(`   完成！成功发招呼语 ${sent} 个`));
  console.log(gray('  ------------------------------------------------------------'));
  console.log(gray(`   记录: ${path.relative(DIR, SENT_FILE)}`));
  console.log(gray(`   日志: ${path.relative(DIR, logFile)}`));
  console.log(gray('  ------------------------------------------------------------'));
  console.log(cyan('   去 BOSS 消息中心看 HR 回应'));
  console.log(cyan('  ============================================================'));
  console.log('');
  console.log(gray('  注：Chrome 会保持开着，方便你看结果。下次跑会自动复用。'));
  console.log('');
  await waitEnter();
  await rt.closer();

  // 【兜底】CDP 的 WebSocket 连接会让 node 的事件循环一直活着，
  // 干完活也不退出（进程赖着不走 = 你看到的"卡住"）。这里强制退出。
  process.exit(0);
}


// ============================================================================

// 只有"直接运行"时才跑主流程；被 require（测试/服务）时只导出函数，不启动浏览器。
if (require.main === module) {
  main()
    // 【兜底】CDP 的 WebSocket 连接会让 node 事件循环一直存活，
    // main 跑完了进程也可能不退出。这里显式退出，保证"干完就走"。
    .then(() => process.exit(0))
    .catch(async (e) => {
      // 界面上点了"停止" → 属于正常结束，不是报错
      if (e && e.name === 'StoppedError') {
        ipcEmit({ t: 'done', sent: 0, reason: 'stopped' });
        console.log('');
        console.log(yellow('  已停止。'));
        process.exit(0);
      }
      console.error('');
      console.error(red('  出错了：' + e.message));
      console.error(gray(e.stack || ''));
      ipcEmit({ t: 'error', msg: e.message });
      process.exit(1);
    });
}

module.exports = { buildGreeting, CFG, KNOWLEDGE, KNOWLEDGE_FILE };
