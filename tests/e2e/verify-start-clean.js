/**
 * 回归：收旧进程后新任务状态正确显示「运行中」
 * 用法：先启动 server.js，并保证有一个「保持浏览器」的子进程（跑一个任务等它自然结束），
 *       再 node tests/verify-start-clean.js
 *
 * 验证：「收旧进程导致状态覆盖」修复
 * 场景：任务结束后浏览器保持开着（子进程存活），此时启动新任务 ——
 *       服务会先收掉旧进程，旧进程的 exit 回调曾把新任务的 running 覆盖成 idle
 *       （新任务 startedAt 与 finishedAt 同一秒，界面显示空闲但任务在跑）。
 * 预期（修复后）：收旧过程中的瞬时覆盖可容忍，但新进程就位后状态必须为 running。
 * 前提：当前应存在一个「保持浏览器」的子进程（先跑一个任务让它自然结束即可）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '..');

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body || {});
  const rq = http.request('http://127.0.0.1:7788' + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { res(s); } }); });
  rq.on('error', rej); rq.write(d); rq.end();
});
const get = (p) => new Promise((res) => http.get('http://127.0.0.1:7788' + p, (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => { try { res(JSON.parse(s)); } catch (_) { res({}); } }); }).on('error', () => res({})));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const st0 = await get('/api/bootstrap');
  console.log('启动前状态:', st0.state.status, '| browserOpen:', st0.state.browserOpen);
  if (!st0.state.browserOpen) {
    console.log('⚠ 当前没有「保持浏览器」的旧子进程，场景不成立 —— 但继续跑（顶多验证不到收旧进程路径）');
  } else {
    console.log('✓ 存在保持浏览器的旧子进程 —— 正好触发「收旧进程」路径');
  }

  console.log('\n启动新任务（目标新增 1 个，会先收掉旧进程）…');
  const r = await post('/api/collect', { source: 'expect', expectTab: '前端开发（北京）', maxJobs: 1 });
  console.log('→', JSON.stringify(r));
  if (!r.ok) process.exit(1);

  // 高频轮询状态 15 秒，记录变化序列
  const seq = [];
  let last = '';
  let statusAt5s = null;
  for (let i = 0; i < 50; i++) {
    const st = await get('/api/bootstrap');
    const s = st.state ? st.state.status : '?';
    if (s !== last) { seq.push(`${(i * 0.3).toFixed(1)}s=${s}`); last = s; }
    if (i === 16) statusAt5s = s;   // ~5.1 秒快照：任务在跑，状态应为 running
    await sleep(300);
  }
  console.log('状态变化序列:', seq.join(' → '));

  // 关键断言：5 秒时任务正在跑，状态应为 running（修复前是 idle）
  const ok5 = statusAt5s === 'running';
  console.log('\n===== 判定 =====');
  console.log('5 秒时状态:', statusAt5s, ok5 ? '✅ 正确（任务在跑）' : '❌ 错误（任务在跑但状态不是 running）');

  // 等任务结束，收尾
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await get('/api/bootstrap');
    if (st.state && st.state.status === 'idle') { console.log(`任务结束（${(i + 1) * 2}s）`); break; }
    if (i === 59) { console.log('超时（仍在跑，手动看日志）'); }
  }

  console.log('\n【最终判定】', ok5 ? 'PASS：收旧进程后新任务状态正确显示「运行中」' : 'FAIL：状态被覆盖的问题仍存在');
  process.exit(ok5 ? 0 : 2);
})();
