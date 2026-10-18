/**
 * 回归：设置页四项微调
 *   ① 输入框离标签太远 → gap/min-width 收紧
 *   ② 删掉底部那两行小字
 *   ③ 句号前的说明文字与标签字号统一（12px → 13px）
 *   ④ 离开设置页的弹窗按钮改成「保存 / 不保存」（原生 confirm 文案改不了 → 自定义 askBox）
 *      并验证：点「保存」会先落盘再离开
 * 用法：先启动 server.js，再 node tests/verify-settings-polish.js
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '..');
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'config.json'), 'utf8'));
let chromium;
try { ({ chromium } = require('patchright')); } catch (_) { ({ chromium } = require('playwright-core')); }
const { CHROME, sleep } = require('../../lib/utils');
const { killChromeUsingProfile } = require('../../lib/chrome-kill')(CFG.profileDir, path.join(DIR, 'logs'));

let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { pass++; console.log('  ✅ ' + n + (e ? '  ' + e : '')); } else { fail++; console.log('  ❌ ' + n + (e ? '  ' + e : '')); } };
const cfgNow = () => JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'config.json'), 'utf8'));

(async () => {
  const before = cfgNow();
  await new Promise((r) => setTimeout(r, 0));
  const browser = await chromium.launchPersistentContext(CFG.profileDir, {
    executablePath: CHROME, headless: false, viewport: { width: 1400, height: 950 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:7788/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2500);
  await page.evaluate(() => { const g = document.querySelector('.tab[data-tab="settings"]'); if (g) g.click(); });
  for (let i = 0; i < 20; i++) { await sleep(300); const a = await page.evaluate(() => !!(document.querySelector('#pageSettings.on'))); if (a) break; }
  await sleep(900);

  console.log('===== ① 输入框与标签的间距 =====');
  const gaps = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#pageSettings .setrow').forEach((row) => {
      const k = row.querySelector('.setk');
      const firstInput = row.querySelector('input[type="number"]');
      if (!k || !firstInput) return;
      out.push({
        label: k.textContent.trim(),
        gap: Math.round(firstInput.getBoundingClientRect().left - k.getBoundingClientRect().right),
      });
    });
    return out;
  });
  gaps.forEach((g) => console.log('     ' + g.label + ' → ' + g.gap + 'px'));
  const maxGap = gaps.length ? Math.max(...gaps.map((g) => g.gap)) : 999;
  ok(maxGap <= 12, '标签到输入框间距 ≤12px（不再有远空档）', '最大 ' + maxGap + 'px');

  console.log('\n===== ② 底部小字已删 =====');
  const foot = await page.evaluate(() => {
    const f = document.querySelector('.setfoot');
    const wrap = document.querySelector('.setwrap');
    // 按钮行之后不该再有别的说明段落
    const after = [];
    let n = f ? f.nextElementSibling : null;
    while (n) { after.push(n.tagName + '.' + (n.className || '')); n = n.nextElementSibling; }
    return { after, hasMiniAfter: !!document.querySelector('.setfoot ~ .mini') };
  });
  ok(!foot.hasMiniAfter, '操作行后面没有多出来的小字段落');
  console.log('     按钮行之后的节点:', foot.after.length ? foot.after.join(', ') : '(无)');

  console.log('\n===== ③ 说明文字字号与标签统一 =====');
  const fonts = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#pageSettings .setrow')];
    const withU = rows.filter((r) => r.querySelector('.setu'));
    if (!withU.length) return null;
    const kSize = parseFloat(getComputedStyle(withU[0].querySelector('.setk')).fontSize);
    const uSize = parseFloat(getComputedStyle(withU[0].querySelector('.setu')).fontSize);
    const rowSize = parseFloat(getComputedStyle(withU[0]).fontSize);
    return { kSize, uSize, rowSize, n: withU.length };
  });
  console.log('     ' + JSON.stringify(fonts));
  ok(fonts && fonts.uSize === fonts.kSize, '说明文字字号 = 标签字号', fonts ? fonts.uSize + ' vs ' + fonts.kSize : '');

  console.log('\n===== ④ 离开弹窗：按钮是「保存 / 不保存」=====');
  await page.evaluate(() => { const e = document.getElementById('setDailyCollectCap'); e.value = '66'; e.dispatchEvent(new Event('input')); });
  await sleep(600);
  await page.evaluate(() => { const t = document.querySelector('.tabs .tab[data-tab="records"]'); if (t) t.click(); });
  await sleep(900);
  const dlg = await page.evaluate(() => {
    const box = document.getElementById('askBox');
    return {
      shown: box ? !box.hidden : false,
      msg: (document.getElementById('askMsg') || {}).textContent,
      noText: (document.getElementById('askNo') || {}).textContent,
      okText: (document.getElementById('askYes') || {}).textContent,
    };
  });
  console.log('     ' + JSON.stringify(dlg));
  ok(dlg.shown, '弹窗已显示（自定义，不是原生 confirm）');
  ok(/不保存/.test(dlg.noText || ''), '第一个按钮是「不保存」', dlg.noText);
  ok(dlg.okText === '保存', '第二个按钮是「保存」（不是确定）', dlg.okText);
  ok(!/确定|取消/.test((dlg.noText || '') + (dlg.okText || '')), '没有「确定 / 取消」字样');

  console.log('\n----- 点「保存」→ 先落盘再离开 -----');
  await page.evaluate(() => { document.getElementById('askYes').click(); });
  await sleep(2200);
  const disk = cfgNow();
  const st = await page.evaluate(() => ({
    on: (document.querySelector('.page.on') || {}).id,
    boxHidden: document.getElementById('askBox').hidden,
  }));
  ok(disk.dailyCollectCap === 66, '点「保存」→ config 已落盘 66', '实际 ' + disk.dailyCollectCap);
  ok(st.on === 'pageRecords', '落盘后确实离开了设置页', '当前 ' + st.on);
  ok(st.boxHidden, '弹窗已关闭');

  console.log('\n----- 点「不保存」→ 放弃改动直接走 -----');
  await page.evaluate(() => { const g = document.querySelector('.tab[data-tab="settings"]'); if (g) g.click(); });
  for (let i = 0; i < 20; i++) { await sleep(300); const a = await page.evaluate(() => !!(document.querySelector('#pageSettings.on'))); if (a) break; }
  await sleep(900);
  await page.evaluate(() => { const e = document.getElementById('setDailyCollectCap'); e.value = '55'; e.dispatchEvent(new Event('input')); });
  await sleep(600);
  await page.evaluate(() => { const t = document.querySelector('.tabs .tab[data-tab="records"]'); if (t) t.click(); });
  await sleep(800);
  await page.evaluate(() => { document.getElementById('askNo').click(); });
  await sleep(1200);
  const st2 = await page.evaluate(() => ({ on: (document.querySelector('.page.on') || {}).id }));
  const disk2 = cfgNow();
  ok(st2.on === 'pageRecords', '点「不保存」→ 直接离开', '当前 ' + st2.on);
  ok(disk2.dailyCollectCap === 66, '改动 55 未落盘（真的没保存）', '实际 ' + disk2.dailyCollectCap);

  await page.evaluate(() => { const g = document.querySelector('.tab[data-tab="settings"]'); if (g) g.click(); });
  for (let i = 0; i < 20; i++) { await sleep(300); const a = await page.evaluate(() => !!(document.querySelector('#pageSettings.on'))); if (a) break; }
  await sleep(900);
  await page.screenshot({ path: path.join(DIR, 'logs', 'settings-polish.png'), fullPage: true });
  // 弹窗截图
  await page.evaluate(() => { const e = document.getElementById('setDailyCollectCap'); e.value = '77'; e.dispatchEvent(new Event('input')); });
  await sleep(400);
  await page.evaluate(() => { const t = document.querySelector('.tabs .tab[data-tab="records"]'); if (t) t.click(); });
  await sleep(900);
  await page.screenshot({ path: path.join(DIR, 'logs', 'ask-box.png') });

  console.log('\n===== 汇总 =====');
  console.log('PASS ' + pass + ' / FAIL ' + fail);

  for (const k of Object.keys(before)) {
    if (/^(maxJobsPerRun|dailyCollectCap|dailyCap|delay|collectDelay|clickPause|readPause|readScroll)/.test(k)) {
      const v = before[k];
      await new Promise((res) => {
        const d = JSON.stringify({ [k]: v });
        const rq = require('http').request('http://127.0.0.1:7788/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (r) => { r.resume(); r.on('end', res); });
        rq.on('error', res); rq.write(d); rq.end();
      });
    }
  }
  const now = cfgNow();
  const drift = Object.keys(before).filter((k) => /^(maxJobsPerRun|dailyCollectCap|dailyCap|delay|collectDelay|clickPause|readPause|readScroll)/.test(k) && now[k] !== before[k]);
  console.log('参数还原: ' + (drift.length ? '⚠️ ' + drift.map((k) => k + '=' + now[k]).join(',') : '✅ 与测试前一致'));

  await browser.close();
  await killChromeUsingProfile();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('异常:', e.message); try { await killChromeUsingProfile(); } catch (_) {} process.exit(1); });