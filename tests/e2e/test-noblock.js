// 验证：开始新任务时收旧 keep-alive 子进程不再阻塞事件循环
// 判据：第二个 /api/collect 请求期间，/api/records 仍能秒回（旧代码会冻结 8~11 秒）
const BASE = 'http://127.0.0.1:7788';
const fs = require('fs');
const lines = [];
const P = (s) => { lines.push(s); console.log(s); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function timed(path, opts) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, opts);
  const j = await r.json().catch(() => ({}));
  return { ms: Date.now() - t0, status: r.status, j };
}

(async () => {
  // 1. 收尾：把可能留着的旧浏览器关掉，从干净状态开始
  P('[0] 清场：关闭遗留浏览器');
  await timed('/api/close-browser', { method: 'POST' });
  await sleep(2500);

  // 2. 第一次 collect → 跑完会进入 keep-alive（子进程活着）
  P('[1] 第一次 collect（1 个岗位，约 15~25 秒）');
  let r = await timed('/api/collect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords: ['前端开发实习'], maxJobs: 1, cityCode: 101010100, cityName: '北京' }),
  });
  P(`    HTTP ${r.status} ${r.ms}ms ok=${r.j.ok}`);
  if (!r.j.ok) { P('FAIL: 第一次 collect 没起来'); return finish(1); }

  // 等 collect-done / browser-kept（子进程进入保持状态）
  let kept = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const st = await (await fetch(BASE + '/api/bootstrap')).json();
    if (st.state.status === 'idle') { kept = true; P(`    ${i + 1}s 后任务完成，子进程进入保持状态`); break; }
  }
  if (!kept) { P('WARN: 25 秒内没等到任务完成，继续测试'); }

  // 3. 关键测试：第二次 collect（会触发收旧子进程）发起后，
  //    立刻打 /api/records —— 旧代码下它会卡到收尾结束才响应
  P('[2] 第二次 collect（触发收旧），同时探测 /api/records 是否仍响应');
  const second = timed('/api/collect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords: ['前端开发实习'], maxJobs: 1, cityCode: 101010100, cityName: '北京' }),
  });
  await sleep(80);   // 让第二个请求先到达服务端
  const probe = await timed('/api/records');
  P(`    records 探测: HTTP ${probe.status} 耗时 ${probe.ms}ms ${probe.ms < 2000 ? '✅ 未被阻塞' : '❌ 被阻塞了'}`);
  const s2 = await second;
  P(`    第二次 collect: HTTP ${s2.status} ${s2.ms}ms ok=${s2.j.ok}`);

  // 4. 收尾：停任务 + 关浏览器
  P('[3] 收尾：停止 + 关浏览器');
  await timed('/api/stop', { method: 'POST' });
  await sleep(3000);
  await timed('/api/close-browser', { method: 'POST' });
  await sleep(2000);

  const ok = probe.ms < 2000;
  P(ok ? '=== PASS ===' : '=== FAIL ===');
  finish(ok ? 0 : 1);

  function finish(code) {
    try { fs.writeFileSync(__dirname + '\\..\\..\\logs\\test-noblock.txt', lines.join('\n'), 'utf8'); } catch (_) {}
    process.exit(code);
  }
})().catch(e => { P('ERR ' + e.message); try { fs.writeFileSync(__dirname + '\\..\\..\\logs\\test-noblock.txt', lines.join('\n'), 'utf8'); } catch (_) {} process.exit(1); });
