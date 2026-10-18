/**
 * 回归：爬取节奏（预热随机站 + 阅读停顿）
 * 用法：先启动 server.js，再 node tests/verify-pace.js
 * 判定：预热站不在 [example.com]；就绪→JD 间隔 ≥2 秒（阅读停顿生效）
 *
 * 验证：安全性节奏加固
 *   ① 预热随机站（不再固定 example.com）
 *   ② 阅读节奏（滚 1~2 次 + 停顿 1~2 秒，长 JD 多滚一次）
 * 跑一次爬取（2 个岗位），检查日志：预热站随机、就绪→JD 的间隔变大、JD 正常读取。
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
  if (st0.state && st0.state.status !== 'idle') { console.log('有任务在跑'); process.exit(1); }

  const before = new Set(fs.readdirSync(path.join(DIR, 'logs')).filter((f) => /^run-/.test(f)));
  console.log('启动爬取（前端开发（北京），2 个）…');
  const r = await post('/api/collect', { source: 'expect', expectTab: '前端开发（北京）', maxJobs: 2 });
  console.log('→', JSON.stringify(r));
  if (!r.ok) process.exit(1);

  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await get('/api/bootstrap');
    if (st.state && st.state.status === 'idle') { console.log(`任务结束（${(i + 1) * 2}s）`); break; }
    if (i === 59) console.log('超时');
  }

  const files = fs.readdirSync(path.join(DIR, 'logs')).filter((f) => /^run-/.test(f) && !before.has(f));
  if (!files.length) { console.log('没找到新日志'); process.exit(2); }
  const txt = fs.readFileSync(path.join(DIR, 'logs', files[files.length - 1]), 'utf8');
  console.log('\n=== ' + files[files.length - 1] + '（关键行 + 时间戳）===');
  txt.split('\n').forEach((l) => {
    if (/预热|就绪|JD \d+ 字|收集完成|跳过|已确认/.test(l)) console.log(l);
  });

  // 间隔分析：就绪 → JD 的间隔（应 ≥1.5s，即阅读节奏生效）
  const lines = txt.split('\n');
  console.log('\n=== 就绪 → JD 间隔分析 ===');
  let lastReady = null;
  for (const l of lines) {
    const m1 = l.match(/\[(\d{2}:\d{2}:\d{2})\].*就绪/);
    const m2 = l.match(/\[(\d{2}:\d{2}:\d{2})\].*JD (\d+) 字/);
    if (m1) lastReady = m1[1];
    if (m2 && lastReady) {
      const sec = (t) => { const [h, mi, s] = t.split(':').map(Number); return h * 3600 + mi * 60 + s; };
      const gap = sec(m2[1]) - sec(lastReady);
      console.log(`  ${lastReady} 就绪 → ${m2[1]} JD(${m2[2]}字) = ${gap} 秒`);
      lastReady = null;
    }
  }
  const warm = (txt.match(/预热浏览器（([^）]+)）/m) || [])[1] || '未找到';
  console.log('');
  console.log('预热站:', warm, warm === 'example.com' ? '❌ 仍是固定站' : (['www.baidu.com', 'cn.bing.com', 'www.163.com'].includes(warm) ? '✅ 随机站' : '?'));
})();
