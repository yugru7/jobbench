/**
 * 真实环境诊断脚本：招呼语填充（只填不发，不产生任何真实投递）
 * ----------------------------------------------------------------------------
 * 用途：换填充方案 / 改 fillGreeting 后，在真实 BOSS 页面上验证三件事：
 *   1) 聊天输入框类型（实测是 DIV.chat-input contenteditable）
 *   2) 填充内容是否与目标严格一致（分块粘贴最容易错的就是这里）
 *   3) 填完后发送按钮是否可用（BOSS 空内容时 btn-send 带 disabled 类）
 * 用法：node tests/verify-fill-boss.js   （需要浏览器已有登录态；跑 3 轮）
 * 安全：全程不点发送按钮，跑完直接关浏览器，输入框内容不会发出。
 * 前置：池子里要有可沟通/继续沟通的岗位（logs/last-collect.json）
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '..');

let chromium;
try { ({ chromium } = require('patchright')); } catch (_) { ({ chromium } = require('playwright-core')); }
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const { CHROME, sleep } = require('../../lib/utils');
const { clickGreetButton, fillGreeting } = require('../../lib/page-helpers');
const { killChromeUsingProfile } = require('../../lib/chrome-kill')(CFG.profileDir, path.join(DIR, 'logs'));

const TEST_TEXT = '【测试文案请忽略】熟练掌握Java与Spring Boot，独立做过电影票务系统的后端开发。熟悉Vue3与Element Plus，可稳定实习6个月每周5天。期待进一步交流。';

const HARD_TIMEOUT = setTimeout(() => { console.error('!! 硬超时，强制退出'); process.exit(8); }, 150000);
HARD_TIMEOUT.unref?.();

(async () => {
  const coll = JSON.parse(fs.readFileSync(path.join(DIR, 'logs/last-collect.json'), 'utf8'));
  // 未发送的优先；没有就用已发送的走「继续沟通」路径（聊天框完全相同，零副作用）
  const fresh = coll.jobs.filter((j) => j.url && !j.sent);
  const sent = coll.jobs.filter((j) => j.url && j.sent);
  const cands = [...fresh, ...sent].slice(0, 8);
  console.log('候选岗位', cands.length, '个（未发送', fresh.length, '+ 已发送', sent.length, '），逐个找可沟通的…');

  const killed = killChromeUsingProfile();
  if (killed > 0) { console.log('关闭遗留浏览器进程', killed, '个，等待退出…'); await sleep(3200); }

  const ctx = await chromium.launchPersistentContext(CFG.profileDir, {
    executablePath: CHROME,
    headless: false,
    viewport: null,
    args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  let page = ctx.pages()[0] || await ctx.newPage();

  // --- 找一个有沟通按钮的岗位 ---
  let job = null;
  for (const c of cands) {
    await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(4000);
    const diag = await page.evaluate(() => {
      const hasCls = !!document.querySelector('a.btn-startchat, div.btn-startchat-wrap, a[class*="startchat"]');
      const hasTxt = Array.from(document.querySelectorAll('a,button,div,span'))
        .some((el) => /^\s*(立即沟通|打招呼|继续沟通)\s*$/.test((el.textContent || '').trim()) && (el.offsetWidth || el.offsetHeight));
      return { hasCls, hasTxt, url: location.href.slice(0, 70), head: (document.body ? document.body.innerText : '').slice(0, 80).replace(/\s+/g, ' ') };
    });
    console.log(`  ${c.job} | 按钮(类名/文案): ${diag.hasCls}/${diag.hasTxt} | ${diag.url}`);
    if (diag.hasCls || diag.hasTxt) { job = c; break; }
    console.log('     跳过，页首文本:', diag.head);
  }
  if (!job) { console.log('没找到可沟通岗位，放弃'); await ctx.close(); process.exit(1); }
  console.log('\n选定:', job.job, '@', job.company);

  // --- 点开沟通面板 ---
  const before = ctx.pages().length;
  const clicked = await clickGreetButton(page);
  console.log('点沟通按钮:', clicked);
  if (!clicked) { await ctx.close(); process.exit(2); }
  await sleep(2000);
  if (ctx.pages().length > before) { page = ctx.pages()[ctx.pages().length - 1]; console.log('切到新标签页'); }

  // --- 等输入框出现 ---
  let boxInfo = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    boxInfo = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"], input[type="text"]'));
      for (const e of els) {
        if (!(e.offsetWidth || e.offsetHeight)) continue;
        const ph = e.getAttribute('placeholder') || '';
        if (/搜索|搜职位/.test(ph)) continue;
        const cls = (e.className || '').toString();
        const isChat = /描述|问题|打招呼|消息/.test(ph) || /chat|edit|send|message/i.test(cls) || e.tagName === 'TEXTAREA';
        if (isChat) return { tag: e.tagName, cls: cls.slice(0, 90), ph: ph.slice(0, 40), editable: e.isContentEditable, value: (e.value != null ? e.value : e.innerText || '').slice(0, 30) };
      }
      return null;
    });
    if (boxInfo) break;
  }
  console.log('\n[1] 输入框:', JSON.stringify(boxInfo));
  if (!boxInfo) { console.log('没等到输入框，放弃'); await ctx.close(); process.exit(3); }

  const sendInfo = () => page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('button, div, span, a'))
      .filter((el) => /^\s*发送\s*$/.test((el.textContent || '').trim()) && (el.offsetWidth || el.offsetHeight));
    return cands.map((el) => ({
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 70),
      disabled: el.disabled === true,
      ariaDisabled: el.getAttribute('aria-disabled') || null,
      pe: getComputedStyle(el).pointerEvents,
    }));
  });
  console.log('[2] 填字前 发送按钮:', JSON.stringify(await sendInfo()));

  // 挂事件监听：计数写进 DOM 属性（跨执行上下文可读，绕过 Patchright 下
  // evaluate 读不到页面变量的问题）
  await page.evaluate(() => {
    const r = document.documentElement;
    const bump = (k) => r.setAttribute('data-ev-' + k, String((+(r.getAttribute('data-ev-' + k) || 0)) + 1));
    const isEd = (t) => t && (t.tagName === 'TEXTAREA' || t.isContentEditable || t.tagName === 'INPUT');
    document.addEventListener('keydown', (e) => { if (isEd(e.target)) bump('keydown'); }, true);
    document.addEventListener('paste', (e) => { if (isEd(e.target)) bump('paste'); }, true);
    document.addEventListener('input', (e) => { if (isEd(e.target)) bump('input'); }, true);
    document.addEventListener('beforeinput', (e) => { if (!isEd(e.target)) return; bump('beforeinput'); bump('bi_' + e.inputType); }, true);
  });
  const readEv = () => page.evaluate(() => {
    const r = document.documentElement;
    const out = {};
    for (const a of Array.from(r.attributes)) { if (a.name.startsWith('data-ev-')) out[a.name.slice(8)] = +a.value; }
    return out;
  });
  console.log('[2b] 监听已挂载，基线事件:', JSON.stringify(await readEv()));

  // --- 填充（hybrid）跑 3 轮，覆盖随机分块 + 修饰路径 ---
  for (let round = 1; round <= 3; round++) {
    // 清空输入框（直接改 DOM，不影响测试）
    await page.evaluate(() => {
      const el = document.querySelector('[data-greet-box="1"]');
      if (el) { if (el.value != null) el.value = ''; else el.innerHTML = ''; }
    }).catch(() => {});
    await sleep(500);

    const ev0 = await readEv();
    const t0 = Date.now();
    const ok = await fillGreeting(page, TEST_TEXT, { mode: 'hybrid' });
    const ms = Date.now() - t0;
    const ev1 = await readEv();
    const diff = {};
    for (const k of new Set([...Object.keys(ev0), ...Object.keys(ev1)])) {
      const d = (ev1[k] || 0) - (ev0[k] || 0);
      if (d) diff[k] = d;
    }

    const after = await page.evaluate(() => {
      const el = document.querySelector('[data-greet-box="1"]');
      if (!el) return { found: false };
      const v = el.value != null ? el.value : (el.innerText || '');
      return { found: true, tag: el.tagName, len: v.length, text: v };
    });

    console.log(`\n[第${round}轮] fillGreeting(hybrid) 返回: ${ok} 耗时 ${ms}ms | 事件增量: ${JSON.stringify(diff)}`);
    console.log(`  内容长度: ${after.len} / 期望 ${TEST_TEXT.length} | 完全一致: ${after.text === TEST_TEXT}`);
    if (after.text !== TEST_TEXT) console.log('    实际:', JSON.stringify(after.text));
    console.log('  发送按钮:', JSON.stringify(await sendInfo()));
  }

  console.log('\n===== 未发送任何消息，3 秒后关闭浏览器 =====');
  await sleep(3000);
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(9); });
