/**
 * 回归：重复岗位不占新增配额、自动补位（2026-10-13 已定）
 * 用法：先启动 server.js，再 node tests/verify-collect-refill.js
 * 场景：结果里遇到池子已有的（重复）就跳过不占名额，继续往后读直到补齐。
 *
 * 验证：重复岗位不占新增配额，自动往后补位（2026-10-13 已定）
 * 场景：目标新增 3 个；搜索结果里遇到已在池子里的（重复）就跳过不占名额，
 *       继续往后读，直到补齐 3 个或候选卡片读完。
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
  if (st0.state && st0.state.status !== 'idle') { console.log('有任务在跑，先等它结束…'); process.exit(1); }
  const poolBefore = ((st0.lastCollect && st0.lastCollect.jobs) || []).length;
  console.log('池子现状:', poolBefore, '个');

  const before = new Set(fs.readdirSync(path.join(DIR, 'logs')).filter((f) => /^run-/.test(f)));

  console.log('启动爬取（方向：前端开发（北京），目标新增 3 个）…');
  const r = await post('/api/collect', { source: 'expect', expectTab: '前端开发（北京）', maxJobs: 3 });
  console.log('→', JSON.stringify(r));
  if (!r.ok) process.exit(1);

  // 等任务结束（最多 150 秒）
  for (let i = 0; i < 75; i++) {
    await sleep(2000);
    const st = await get('/api/bootstrap');
    if (st.state && st.state.status === 'idle') { console.log(`任务结束（${(i + 1) * 2}s）`); break; }
    if (i === 74) console.log('超时未结束');
  }

  const after = fs.readdirSync(path.join(DIR, 'logs')).filter((f) => /^run-/.test(f) && !before.has(f));
  const newest = after.length ? after[after.length - 1] : null;
  if (!newest) { console.log('没找到新日志'); process.exit(2); }
  const txt = fs.readFileSync(path.join(DIR, 'logs', newest), 'utf8');
  console.log('\n=== ' + newest + '（关键行）===');
  txt.split('\n').forEach((l) => {
    if (/已在池子里|新增 \d+\/|收集完成|候选卡片|跳过/.test(l)) console.log(l);
  });

  // ---- 判定 ----
  const skipLines = (txt.match(/已在池子里，跳过（继续补位，还差/g) || []).length;
  const doneLine = (txt.match(/收集完成：.*/) || [''])[0];
  const newOk = (doneLine.match(/新增 (\d+) \/ 目标 (\d+)/) || []);
  const exhausted = /候选卡片已读完/.test(doneLine);

  console.log('\n===== 判定 =====');
  console.log('跳过重复的行数:', skipLines);
  console.log('完成行:', doneLine || '(没找到)');
  const ok = skipLines > 0 ? (newOk[1] === newOk[2] || exhausted) : null;
  if (skipLines === 0) {
    console.log('⚠ 本轮没遇到重复岗位（无法验证补位）—— 换个方向再跑一次，或看下面输出');
  } else if (newOk[1] === newOk[2]) {
    console.log(`PASS：遇到 ${skipLines} 个重复被跳过，新增仍补齐到 ${newOk[1]}/${newOk[2]} ✅`);
  } else if (exhausted) {
    console.log(`PASS(部分)：遇到 ${skipLines} 个重复，新增 ${newOk[1]}/${newOk[2]}，候选卡片已读完（预期内的"爬不到"）`);
  } else {
    console.log('FAIL：跳过重复后新增未达标，且不是卡片读完 —— 检查逻辑');
  }
})();
