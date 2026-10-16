/**
 * 命令行参数解析
 * ----------------------------------------------------------------------------
 * 同时支持两种写法：--mode collect  和  --mode=collect
 * （踩过的坑：只支持空格分隔时，--mode=collect 会被静默忽略，然后按默认模式跑）
 */
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argOf = (f) => {
  const i = argv.indexOf(f);
  if (i >= 0) return argv[i + 1];
  const p = f + '=';
  const hit = argv.find(a => a.startsWith(p));
  return hit ? hit.slice(p.length) : null;
};

const DRY_RUN = hasFlag('--dry-run');
// 【默认改成自己的启动模式】Patchright 自己管理 Chrome 比 CDP 连接更安全：
//   Patchright 会自动加 --disable-blink-features=AutomationControlled，
//   而实测这个 flag 在「CDP 连接模式」下反而会被 BOSS 判为自动化（喂空页），
//   但在「launch 模式」下由 Patchright 统一管理参数，工作正常。
// 所以 CDP 只作为备选，需要显式 --use-cdp 才启用。
const USE_CDP = hasFlag('--use-cdp');
const CDP_PORT = parseInt(argOf('--cdp-port') || '9222', 10);
const FORCE_MAX = parseInt(argOf('-n') || '0', 10);

// 关键词来源：-k 传中文会被 PowerShell 的编码搞坏（实测"前端开发实习"→乱码）。
// 所以支持 -k 直接传中文（在 bash/直接调用时可用），
// 也支持 --kw-index 1 按 config.json 里的序号选，绝对稳妥。
const KW_INDEX = parseInt(argOf('--kw-index') || '0', 10);
const FORCE_KEYWORD = argOf('-k');
// 界面传参用：--keywords "a,b,c"（Node spawn 直接传数组，不经 shell，中文不会乱码）
const FORCE_KEYWORDS = (argOf('--keywords') || '').split(',').map(s => s.trim()).filter(Boolean);
// 界面传参用：临时覆盖城市，不改 config.json（在 greet.js 里写回 CFG）
const FORCE_CITY_CODE = argOf('--city-code');
const FORCE_CITY_NAME = argOf('--city-name');
// 界面传参用：--source=recommend 走「推荐」流；--source=expect 爬「意向岗位页签」
// （用户在 BOSS 勾选的求职方向，页签是前端路由，需模拟点击切换列表）
const SOURCE = argOf('--source') === 'recommend' ? 'recommend'
  : argOf('--source') === 'expect' ? 'expect' : 'search';
// 界面传参用：--expect-tab "测试（北京）" 只爬选中的这一个意向页签（两步流程的第二步）
const EXPECT_TAB = argOf('--expect-tab') || '';

// ---------- 运行模式 ----------
//   auto（默认）  搜岗位 → 逐个打招呼，一条龙（命令行用法）
//   collect       搜岗位 → 逐个读 JD + 招聘者活跃度 → 生成招呼语 → 推送列表，不发消息
//   send          按界面给的清单逐个发送（清单从 --send-list 指定的 json 文件读）
const MODE = (argOf('--mode') || 'auto').toLowerCase();
const SEND_LIST_FILE = argOf('--send-list');
// 逐个确认模式：每发一个之前把招呼语填进输入框，然后停下等指令（SEND 继续发 / SKIP 跳过）
const CONFIRM_EACH = hasFlag('--confirm-each');
// 【只填不发】把招呼语填进输入框后就结束，绝不点发送按钮。
// 用途：① 验证"能不能填进去"（这才是真正的难点）② 你想自己在浏览器里点发送
// 这是测试和自用的安全开关 —— 用它绝不会消耗投递机会。
const FILL_ONLY = hasFlag('--fill-only');
// 【浏览器保活】默认：任务结束后不关浏览器，保持打开让你查看/手动发送。
// 为什么必须这样：招呼语是「页面状态」，浏览器一关就没了（它不存在于 profile 里）。
// 实测确认：Node 进程退出会把 launchPersistentContext 启动的浏览器一起带走。
// 所以这里改成保持进程存活，等界面发 CLOSE 指令（或超时）才真正关闭。
const CLOSE_BROWSER = hasFlag('--close-browser');
const KEEP_OPEN_MAX_MS = 60 * 60 * 1000;   // 最多保持 1 小时，兜底防止挂死

module.exports = {
  argv, hasFlag, argOf,
  DRY_RUN, USE_CDP, CDP_PORT, FORCE_MAX,
  KW_INDEX, FORCE_KEYWORD, FORCE_KEYWORDS, FORCE_CITY_CODE, FORCE_CITY_NAME,
  SOURCE, EXPECT_TAB,
  MODE, SEND_LIST_FILE, CONFIRM_EACH, FILL_ONLY, CLOSE_BROWSER, KEEP_OPEN_MAX_MS,
};
