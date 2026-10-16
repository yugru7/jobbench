/**
 * 回归：界面习惯记忆（2026-10-13 已定：刷新 / 重启后保持当前状态）
 * 用法：先启动 server.js，再 node tests/verify-ui-prefs.js
 *
 * 覆盖：
 *   ① 改「来源」→ 刷新后仍是改后的值
 *   ② 改「发送方式」→ 刷新后按钮仍选中
 *   ③ 意向方向（记住的方向列表 + 挑中的方向）→ 刷新后直接渲染、自动选回，
 *      且启动恢复不真读 BOSS（不发 /api/expects 请求，避免一开页面就弹浏览器）
 * 收尾：把测试前的 localStorage['boss-ui'] 原样还原
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '..');
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
let chromium;
try { ({ chromium } = require('patchright')); } catch (_) { ({ chromium } = require('playwright-core')); }
const { CHROME, sleep } = require('../../lib/utils');
const { killChromeUsingProfile } = require('../../lib/chrome-kill')(CFG.profileDir, path.join(DIR, 'logs'));

const BASE = 'http://127.0.0.1:7788';
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); } else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); } };
const prefs = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('boss-ui') || '{}'); } catch (_) { return {}; } });

(async () => {
  try { killChromeUsingProfile(); } catch (_) {}
  await sleep(600);
  const browser = await chromium.launchPersistentContext(CFG.profileDir, {
    executablePath: CHROME, headless: false, viewport: { width: 1400, height: 1000 },
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2500);
  // 记住页签偏好也一并还原（点击页签会写 localStorage['tab']）；先切到「岗位初筛」保证控件可见
  const origUI = await page.evaluate(() => localStorage.getItem('boss-ui'));
  const origTab = await page.evaluate(() => localStorage.getItem('tab'));
  await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="dir"]'); t && t.click(); });
  await sleep(600);

  console.log('===== ① 来源 + 发送方式 → 刷新后不变 =====');
  await page.evaluate(() => localStorage.removeItem('boss-ui'));
  await page.selectOption('#collectSource', 'recommend');
  await page.evaluate(() => { const b = document.querySelector('#modes button[data-mode="auto"]'); b && b.click(); });
  await sleep(300);
  const saved = await prefs(page);
  ok(saved.source === 'recommend', '来源已写入 boss-ui', 'source=' + saved.source);
  ok(saved.sendMode === 'auto', '发送方式已写入 boss-ui', 'sendMode=' + saved.sendMode);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const after1 = await page.evaluate(() => ({
    source: document.getElementById('collectSource').value,
    modeOn: (() => { const b = document.querySelector('#modes button.on'); return b ? b.dataset.mode : ''; })(),
  }));
  ok(after1.source === 'recommend', '刷新后来源仍是 recommend', '实际 ' + after1.source);
  ok(after1.modeOn === 'auto', '刷新后发送方式按钮仍是 auto 选中', '实际 ' + after1.modeOn);

  console.log('\n===== ② 意向方向 → 刷新后直接渲染并选回（不读 BOSS）=====');
  await page.evaluate(() => localStorage.setItem('boss-ui', JSON.stringify(
    { source: 'expect', sendMode: 'auto', expectTabs: ['T-A', 'T-B'], expectTab: 'T-B' })));
  let expectsReq = 0;
  page.on('request', (r) => { if (r.url().includes('/api/expects')) expectsReq++; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2800);
  const after2 = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('#expectChips .chip')].map((c) => ({ t: c.textContent, on: c.classList.contains('on') }));
    const er = document.getElementById('expectRow');
    return {
      source: document.getElementById('collectSource').value,
      expectRowVisible: !!(er && er.style.display !== 'none'),
      chips,
    };
  });
  ok(after2.source === 'expect', '刷新后来源仍是 expect', '实际 ' + after2.source);
  ok(after2.expectRowVisible, '意向方向那一行显示出来了');
  ok(after2.chips.length === 2 && after2.chips[0].t === 'T-A' && after2.chips[1].t === 'T-B',
    '方向列表直接用记住的渲染', JSON.stringify(after2.chips.map((c) => c.t)));
  ok(after2.chips.some((c) => c.t === 'T-B' && c.on), '上次挑中的方向 T-B 自动选回');
  ok(expectsReq === 0, '启动恢复没有发 /api/expects（不会一开页面就弹浏览器）', '请求数=' + expectsReq);

  console.log('\n===== 收尾：还原 boss-ui / tab =====');
  await page.evaluate((v) => { if (v === null) localStorage.removeItem('boss-ui'); else localStorage.setItem('boss-ui', v); }, origUI);
  await page.evaluate((v) => { if (v === null) localStorage.removeItem('tab'); else localStorage.setItem('tab', v); }, origTab);
  const back = await page.evaluate(() => ({ ui: localStorage.getItem('boss-ui'), tab: localStorage.getItem('tab') }));
  ok(back.ui === origUI && back.tab === origTab, 'localStorage 已还原（boss-ui / tab）');

  await browser.close();
  console.log('\n===== 汇总 =====');
  console.log(`PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('脚本异常: ' + (e && e.message)); process.exit(1); });
