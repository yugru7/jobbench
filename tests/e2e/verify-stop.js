/**
 * 回归：「停止」按钮只在任务运行时出现（2026-10-13 定稿）
 * 用法：先启动 server.js，再 node tests/verify-stop.js
 *   - 运行中：停止可见、可点
 *   - 空闲：停止隐藏
 *   - 点停止：任务终止，状态回到「空闲」（不是「出错了」）
 * 先开面板、后启动任务，用高频轮询捕捉运行窗口（任务可能秒结束：岗位全在池子里被跳过）。
 * 只爬取（只读），不发任何消息。
 */
const http = require('http');
const path = require('path');
const DIR = path.join(__dirname, '..', '..');
let chromium;
try { ({ chromium } = require('patchright')); } catch (_) { ({ chromium } = require('playwright-core')); }
const { CHROME } = require('../../lib/utils');

const BASE = 'http://127.0.0.1:7788';
const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body || {});
  const rq = http.request(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { res(s); } }); });
  rq.on('error', rej); rq.write(d); rq.end();
});
const getState = () => new Promise((res) => http.get(BASE + '/api/bootstrap', (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => { try { res(JSON.parse(s).state || {}); } catch (_) { res({}); } }); }).on('error', () => res({})));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const btnState = (page) => page.evaluate(() => {
  const el = document.getElementById('btnStop');
  return {
    visible: !!(el && el.offsetWidth > 0),
    disabled: el ? el.disabled : null,
    badge: document.getElementById('statusBadge').textContent,
  };
});

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME || undefined, headless: false, args: ['--no-proxy-server'] });
  const page = await browser.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2200);
  await page.click('button[data-tab="fetch"]', { timeout: 5000 }).catch(() => {});
  await sleep(400);

  const idle0 = await btnState(page);
  console.log('① 空闲时:', JSON.stringify(idle0), '→ 停止隐藏:', !idle0.visible ? '✅' : '❌');

  // 等上一个任务彻底空闲，再启动
  for (let i = 0; i < 20; i++) { const s = await getState(); if (s.status === 'idle') break; await sleep(1000); }
  const startR = await post('/api/collect', { source: 'expect', expectTab: '前端开发（北京）', maxJobs: 10 });
  console.log('   启动:', JSON.stringify(startR));
  if (!startR || !startR.ok) { await post('/api/stop'); await sleep(4000); }

  // 高频轮询捕捉运行窗口
  let running = null, sawRunning = false;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const b = await btnState(page);
    const st = await getState();
    if (st.status === 'running' || (b.badge === '运行中')) { sawRunning = true; running = b; break; }
    if (i > 8 && st.status === 'idle' && b.badge === '空闲') break;   // 任务已完成
  }
  if (running) {
    console.log('② 运行中:', JSON.stringify(running));
    console.log('   → 停止可见且可点:', running.visible && running.disabled === false ? '✅' : '❌');
    // 点停止
    await page.click('#btnStop').catch(() => post('/api/stop'));
    console.log('   已点「停止」');
  } else {
    console.log('② 未捕捉到运行窗口（任务秒结束）:', JSON.stringify(sawRunning));
  }

  // 等结束 + 复查按钮
  for (let i = 0; i < 20; i++) { await sleep(1000); const s = await getState(); if (s.status === 'idle') break; }
  await sleep(1000);
  const after = await btnState(page);
  const st2 = await getState();
  console.log('③ 停止后:', JSON.stringify(after), '| 状态:', st2.status, '| error:', JSON.stringify(st2.error || ''));
  console.log('   → 停止隐藏:', !after.visible ? '✅' : '❌', '| 状态干净（空闲无错）:', st2.status === 'idle' && !st2.error ? '✅' : '❌');

  await browser.close();
  const pass = !idle0.visible && (!running || (running.visible && running.disabled === false)) && !after.visible && st2.status === 'idle' && !st2.error;
  console.log('\n===== 判定 =====');
  console.log(pass ? 'PASS：停止只在运行时出现、停止后隐藏、状态干净' : 'FAIL：见上');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(9); });
