/**
 * 端到端验证：设置页文案 + 单位换算（反馈"术语看不懂"）
 * 关键断言：界面显示「秒/百分数」，但 config 仍存「毫秒/0~1」——
 * 证明换算层有效，且脚本读到的单位没被改坏。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const DIR = path.join(__dirname, '..', '..');
const CFG0 = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'config.json'), 'utf8'));
let chromium;
try { ({ chromium } = require('patchright')); } catch (_) { ({ chromium } = require('playwright-core')); }
const { CHROME, sleep } = require('../../lib/utils');
const { killChromeUsingProfile } = require('../../lib/chrome-kill')(CFG0.profileDir, path.join(DIR, 'logs'));

const BASE = 'http://127.0.0.1:7788';
const post = (p, b) => new Promise((res) => {
  const d = JSON.stringify(b || {});
  const rq = http.request(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (r) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => { try { res(JSON.parse(s)); } catch (_) { res({}); } }); });
  rq.on('error', () => res({})); rq.write(d); rq.end();
});

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); } else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); } };

(async () => {
  const before = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'config.json'), 'utf8'));
  const browser = await chromium.launchPersistentContext(CFG0.profileDir, {
    executablePath: CHROME, headless: false, viewport: { width: 1400, height: 1100 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  // 手动保存语义：改完必须点「保存设置」才落盘
  const clickSaveBar = () => page.evaluate(() => { const b = document.getElementById('btnSaveSettings'); if (b) b.click(); });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2500);

  // 进设置页
  await page.evaluate(() => { const g = document.querySelector('.tab[data-tab="settings"]'); g && g.click(); });
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const a = await page.evaluate(() => { const p = document.getElementById('pageSettings'); return !!(p && p.classList.contains('on')); });
    if (a) break;
  }
  await sleep(1000);

  console.log('===== ① 文案说人话 =====');
  const txt = await page.evaluate(() => {
    const page = document.getElementById('pageSettings');
    return {
      full: page.innerText,
      secs: [...page.querySelectorAll('.absec')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
      keys: [...page.querySelectorAll('.setk')].map((e) => e.textContent.trim()),
    };
  });
  const jargon = ['长尾', '普通间隔', '点击前停留', '阅读停顿', '阅读滚动距离', '行为防护', '毫秒'];
  const stillThere = jargon.filter((w) => txt.full.includes(w));
  ok(stillThere.length === 0, '内部术语已全部清除', stillThere.length ? '仍有: ' + stillThere.join(',') : '');
  ok(txt.keys.includes('大多数时候') && txt.keys.includes('偶尔慢一点'), '「长尾」改成「偶尔慢一点」');
  ok(txt.keys.includes('沟通前在 JD 页面停留'), '「点击前停留」改成动作描述');
  ok(txt.keys.includes('在 JD 页面停留'), '「阅读停顿」改成动作描述');
  ok(txt.keys.includes('停留时滚轮滑动'), '「阅读滚动距离」改成动作描述');
  ok(!/毫秒/.test(txt.full), '不再出现「毫秒」');
  console.log('     分组: ' + txt.secs.join(' / '));

  console.log('\n===== ② 界面显示单位（秒 / %）=====');
  const view = await page.evaluate(() => {
    const g = (id) => (document.getElementById(id) || {}).value;
    return { cpMax: g('setClickPauseMaxSec'), rpMin: g('setReadPauseMinSec'), rpMax: g('setReadPauseMaxSec'),
      ratio: g('setDelayTailRatio'), cratio: g('setCollectDelayTailRatio') };
  });
  ok(view.cpMax === '2', '点击前停留上限显示 2（秒），不是 2000', '实际 ' + view.cpMax);
  ok(view.rpMin === '1' && view.rpMax === '2', '阅读停顿显示 1~2（秒）', `实际 ${view.rpMin}~${view.rpMax}`);
  ok(view.ratio === '25', '发送「偶尔慢一点」显示 25（%），不是 0.25', '实际 ' + view.ratio);
  ok(view.cratio === '25', '爬取「偶尔慢一点」显示 25（%）', '实际 ' + view.cratio);

  console.log('\n===== ③ 改界面值 → config 存对单位 =====');
  // 界面填 3 秒 → config 应存 3000ms
  await page.evaluate(() => { const e = document.getElementById('setClickPauseMaxSec'); e.value = '3'; e.dispatchEvent(new Event('input')); });
  await clickSaveBar();
  await sleep(1600);   // 等落盘 + 回填
  let disk = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'config.json'), 'utf8'));
  ok(disk.clickPauseMaxMs === 3000, '界面填 3 秒 → config 存 3000ms', '实际 ' + disk.clickPauseMaxMs);

  // 界面填 40% → config 应存 0.4
  await page.evaluate(() => { const e = document.getElementById('setDelayTailRatio'); e.value = '40'; e.dispatchEvent(new Event('input')); });
  await clickSaveBar();
  await sleep(1600);   // 等落盘 + 回填
  disk = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'config.json'), 'utf8'));
  ok(disk.delayTailRatio === 0.4, '界面填 40% → config 存 0.4', '实际 ' + disk.delayTailRatio);

  console.log('\n===== ④ 回显仍是对的单位（不重复换算）=====');
  const back = await page.evaluate(() => ({
    cp: document.getElementById('setClickPauseMaxSec').value,
    r: document.getElementById('setDelayTailRatio').value,
  }));
  ok(back.cp === '3', 'config 3000ms → 界面回显 3 秒', '实际 ' + back.cp);
  ok(back.r === '40', 'config 0.4 → 界面回显 40%', '实际 ' + back.r);

  console.log('\n===== ⑤ 脚本读到的仍是毫秒 =====');
  const pace = await page.evaluate(() => {
    // 复刻 greet.js 的 paceRand：直接读 config
    return fetch('/api/config').then((r) => r.json()).then((d) => d.config);
  });
  ok(pace.clickPauseMaxMs === 3000, '接口返回毫秒（脚本侧单位未被污染）', '实际 ' + pace.clickPauseMaxMs);
  ok(Math.abs(pace.delayTailRatio - 0.4) < 1e-9, '接口返回 0~1 小数', '实际 ' + pace.delayTailRatio);

  console.log('\n===== ⑥ 恢复默认也走同一换算 =====');
  page.once('dialog', (d) => d.accept());
  await page.evaluate(() => { document.getElementById('btnResetSettings').click(); });
  await sleep(1800);
  const afterReset = await page.evaluate(() => ({
    cp: document.getElementById('setClickPauseMaxSec').value,
    r: document.getElementById('setDelayTailRatio').value,
  }));
  disk = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'config.json'), 'utf8'));
  ok(afterReset.cp === '2' && disk.clickPauseMaxMs === 2000, '重置后界面 2 秒 / config 2000ms', JSON.stringify(afterReset) + ' cfg=' + disk.clickPauseMaxMs);
  ok(afterReset.r === '25' && disk.delayTailRatio === 0.25, '重置后界面 25% / config 0.25', JSON.stringify(afterReset) + ' cfg=' + disk.delayTailRatio);

  await page.screenshot({ path: path.join(DIR, 'logs', 'settings-shot.png'), fullPage: true });

  console.log('\n===== 汇总 =====');
  console.log('PASS ' + pass + ' / FAIL ' + fail);

  for (const k of Object.keys(before)) {
    if (/^(maxJobsPerRun|dailyCollectCap|dailyCap|delay|collectDelay|clickPause|readPause|readScroll)/.test(k)) await post('/api/config', { [k]: before[k] });
  }
  const now = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'config.json'), 'utf8'));
  const drift = Object.keys(before).filter((k) => /^(maxJobsPerRun|dailyCollectCap|dailyCap|delay|collectDelay|clickPause|readPause|readScroll)/.test(k) && now[k] !== before[k]);
  console.log('参数还原: ' + (drift.length ? '⚠️ ' + drift.map((k) => k + '=' + now[k]).join(',') : '✅ 与测试前一致'));

  await browser.close();
  await killChromeUsingProfile();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('异常:', e.message); try { await killChromeUsingProfile(); } catch (_) {} process.exit(1); });