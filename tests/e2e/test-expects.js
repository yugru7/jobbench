// 意向方向缓存测试：A 真读（无缓存）→ 写缓存；B 再调 → 秒出；C force → 真读刷新
// 用法：重启 server.js 后运行 node test-expects.js（A/C 会开浏览器真读，约各 15~40 秒）
const http = require('http');
const fs = require('fs');
const path = require('path');

const CACHE = path.join(__dirname, '..', '..', 'logs', 'expects-cache.json');

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: 7788, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 300000,
    }, res => {
      let s = '';
      res.on('data', c => (s += c));
      res.on('end', () => { try { resolve({ code: res.statusCode, body: JSON.parse(s) }); } catch (_) { resolve({ code: res.statusCode, body: s }); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function readCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (_) { return null; } }

(async () => {
  const out = [];
  const now = () => Date.now();

  // A. 清缓存 → 真读（开浏览器），等缓存写入
  try { fs.unlinkSync(CACHE); } catch (_) {}
  let t = now();
  const a = await post('/api/expects', {});
  out.push(`A 真读启动: HTTP ${a.code} | fromCache=${a.body && (a.body.fromCache || false)} | ${now() - t}ms`);
  let saved = null;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    saved = readCache();
    if (saved && saved.tabs && saved.tabs.length) {
      out.push(`A 缓存写入: PASS（${saved.tabs.length} 个方向，等待 ${(i + 1) * 2}s）— ${saved.tabs.join('、')}`);
      break;
    }
  }
  if (!saved || !saved.tabs || !saved.tabs.length) out.push('A 缓存写入: FAIL（90s 内没等到）');

  // B. 再调（不 force）→ 秒出缓存
  if (saved && saved.tabs && saved.tabs.length) {
    t = now();
    const b = await post('/api/expects', {});
    const bMs = now() - t;
    out.push(`B 缓存秒出: HTTP ${b.code} | ${bMs}ms | fromCache=${b.body && b.body.fromCache} count=${b.body && b.body.count} ${b.body && b.body.fromCache && bMs < 3000 ? 'PASS' : 'FAIL'}`);
  }

  // C. force → 真读并覆盖缓存（cachedAt 应变新）
  if (saved && saved.tabs && saved.tabs.length) {
    const oldAt = saved.at;
    t = now();
    const c = await post('/api/expects', { force: true });
    out.push(`C 强制刷新启动: HTTP ${c.code} | fromCache=${c.body && (c.body.fromCache || false)} ${c.body && c.body.ok && !c.body.fromCache ? 'PASS（走真读）' : 'FAIL'}`);
    let refreshed = false;
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      const cur = readCache();
      if (cur && cur.at && cur.at !== oldAt) { refreshed = true; out.push(`C 缓存刷新: PASS（${(i + 1) * 2}s 后 cachedAt 更新）`); break; }
    }
    if (!refreshed) out.push('C 缓存刷新: FAIL（90s 内没更新）');
  }

  console.log(out.join('\n'));
})().catch(e => { console.log('测试脚本异常: ' + e.message); process.exit(1); });
