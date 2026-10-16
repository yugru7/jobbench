/**
 * 回归：设置页布局（2026-10-13 反馈）
 *   ① 「保存设置的按钮还是没有」→ 之前做成"改了才出现"，等于没有按钮
 *   ② 「这两句中间间隔太大了」→ .setu 写了 flex:1 1 240px 撑开整行
 * 定稿方案：不做底部悬浮栏，保存 / 撤销 按钮并入「恢复默认设置」那一行，
 *          常驻可见；无改动时置灰，有改动时点亮。
 * 用法：先启动 server.js，再 node tests/verify-settings-layout.js
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '..');
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
let chromium;
try { ({ chromium } = require('patchright')); } catch (_) { ({ chromium } = require('playwright-core')); }
const { CHROME, sleep } = require('../../lib/utils');
const { killChromeUsingProfile } = require('../../lib/chrome-kill')(CFG.profileDir, path.join(DIR, 'logs'));

let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { pass++; console.log('  ✅ ' + n + (e ? '  ' + e : '')); } else { fail++; console.log('  ❌ ' + n + (e ? '  ' + e : '')); } };

(async () => {
  const before = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
  const browser = await chromium.launchPersistentContext(CFG.profileDir, {
    executablePath: CHROME, headless: false, viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:7788/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2500);
  await page.evaluate(() => { const g = document.querySelector('.tab[data-tab="settings"]'); if (g) g.click(); });
  for (let i = 0; i < 20; i++) { await sleep(300); const a = await page.evaluate(() => !!(document.querySelector('#pageSettings.on'))); if (a) break; }
  await sleep(900);

  console.log('===== ① 设置行间距（原来 .setu 的 flex 撑开一大段空白）=====');
  const gaps = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#pageSettings .setrow').forEach((row) => {
      const kids = [...row.children];
      let maxGap = 0, prevRight = null;
      for (const k of kids) {
        const r = k.getBoundingClientRect();
        if (r.width === 0) continue;
        if (prevRight !== null) maxGap = Math.max(maxGap, Math.round(r.left - prevRight));
        prevRight = r.right;
      }
      out.push(maxGap);
    });
    return out;
  });
  const worst = gaps.length ? Math.max(...gaps) : 999;
  console.log('     各行最大空档:', gaps.join(', '));
  ok(worst <= 40, '无超过 40px 的异常空档', '最大 ' + worst + 'px');

  console.log('\n===== ② 保存 / 撤销 按钮常驻可见（不需先改任何东西）=====');
  const idle = await page.evaluate(() => {
    const sv = document.getElementById('btnSaveSettings');
    const rv = document.getElementById('btnRevertSettings');
    const reset = document.getElementById('btnResetSettings');
    const foot = document.querySelector('.setfoot');
    const fr = foot ? foot.getBoundingClientRect() : null;
    const sr = sv ? sv.getBoundingClientRect() : null;
    return {
      footShown: foot ? (foot.offsetWidth > 0 && foot.offsetHeight > 0) : false,
      saveExists: !!sv, revertExists: !!rv, resetExists: !!reset,
      saveDisabled: sv ? sv.disabled : null,
      revertDisabled: rv ? rv.disabled : null,
      sameRow: sr && reset ? Math.abs(sr.top - reset.getBoundingClientRect().top) < 20 : false,
      inViewport: fr ? (fr.bottom <= window.innerHeight + 1) : false,
      footBottom: fr ? Math.round(fr.bottom) : null,
      vh: window.innerHeight,
      hint: (document.getElementById('setDirtyHint') || {}).textContent,
    };
  });
  console.log('     ' + JSON.stringify(idle));
  ok(idle.footShown, '底部操作行存在且可见');
  ok(idle.saveExists && idle.revertExists, '保存 / 撤销 两个按钮都在');
  ok(idle.sameRow, '「保存设置」与「恢复默认设置」在同一行');
  // 设置页不在 .wp 列表里（不锁高），内容可滚动是设计如此：
  // 按钮在内容流末尾，滚动到底必须能看到、且点得到
  const reach = await page.evaluate(() => {
    const foot = document.querySelector('.setfoot');
    foot.scrollIntoView({ block: 'end' });
    const sv = document.getElementById('btnSaveSettings');
    const r = sv.getBoundingClientRect();
    return {
      visible: sv.offsetWidth > 0 && sv.offsetHeight > 0,
      inViewport: r.bottom <= window.innerHeight + 1 && r.top >= 0,
      top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight,
    };
  });
  ok(reach.visible, '滚动到底后「保存设置」按钮存在且可见');
  ok(reach.inViewport, '滚动到底后按钮完整落在视口内（点得到）', 'bottom=' + reach.bottom + ' 视口=' + reach.vh);
  ok(idle.saveDisabled && idle.revertDisabled, '无改动时两个按钮都置灰');
  ok(idle.hint === '当前设置已保存', '提示为「当前设置已保存」', idle.hint);

  console.log('\n===== ③ 改了值 → 按钮点亮 =====');
  await page.evaluate(() => { const e = document.getElementById('setDailyCollectCap'); e.value = '75'; e.dispatchEvent(new Event('input')); });
  await sleep(700);
  const dirty = await page.evaluate(() => ({
    saveDisabled: document.getElementById('btnSaveSettings').disabled,
    revertDisabled: document.getElementById('btnRevertSettings').disabled,
    hint: (document.getElementById('setDirtyHint') || {}).textContent,
  }));
  console.log('     ' + JSON.stringify(dirty));
  ok(!dirty.saveDisabled, '有改动 → 「保存设置」可用');
  ok(!dirty.revertDisabled, '有改动 → 「撤销改动」可用');
  ok(dirty.hint === '有改动还没保存', '提示变为「有改动还没保存」', dirty.hint);

  console.log('\n===== ④ 保存 → 落盘并回到置灰 =====');
  await page.evaluate(() => { document.getElementById('btnSaveSettings').click(); });
  await sleep(1800);
  const disk = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
  const saved = await page.evaluate(() => ({
    saveDisabled: document.getElementById('btnSaveSettings').disabled,
    hint: (document.getElementById('setDirtyHint') || {}).textContent,
    stillShown: (() => { const f = document.querySelector('.setfoot'); return f ? f.offsetWidth > 0 : false; })(),
  }));
  console.log('     ' + JSON.stringify(saved) + ' | config=' + disk.dailyCollectCap);
  ok(disk.dailyCollectCap === 75, '点保存 → config 落盘 75', '实际 ' + disk.dailyCollectCap);
  ok(saved.saveDisabled, '保存后按钮回到置灰');
  ok(saved.hint === '当前设置已保存', '提示回到「当前设置已保存」', saved.hint);
  ok(saved.stillShown, '保存后按钮仍在（不消失）');

  console.log('\n===== ⑤ 离开设置页 → 不残留在别的页面 =====');
  await page.evaluate(() => { const e = document.getElementById('setDailyCollectCap'); e.value = '88'; e.dispatchEvent(new Event('input')); });
  await sleep(600);
  // 自定义弹窗（core.js askBox）：轮询到弹窗就点「不保存」
  let sawAsk = false;
  const askTimer = setInterval(async () => {
    try {
      const shown = await page.evaluate(() => !document.getElementById('askBox').hidden);
      if (!shown) return;
      sawAsk = true;
      await page.evaluate(() => { const b = document.getElementById('askNo'); if (b) b.click(); });
      clearInterval(askTimer);
    } catch (_) {}
  }, 200);
  await page.evaluate(() => { const t = document.querySelector('.tabs .tab[data-tab="records"]'); if (t) t.click(); });
  await sleep(1600);
  clearInterval(askTimer);
  const left = await page.evaluate(() => {
    const f = document.querySelector('.setfoot');
    return { w: f ? f.offsetWidth : -1, on: (document.querySelector('.page.on') || {}).id };
  });
  ok(sawAsk, '离开时弹出自定义弹窗');
  ok(left.on === 'pageRecords', '已离开设置页', '当前 ' + left.on);
  ok(left.w === 0, '离开后操作行不可见（不飘到别的页面）', '宽=' + left.w);

  await page.evaluate(() => { const g = document.querySelector('.tab[data-tab="settings"]'); if (g) g.click(); });
  for (let i = 0; i < 20; i++) { await sleep(300); const a = await page.evaluate(() => !!(document.querySelector('#pageSettings.on'))); if (a) break; }
  await sleep(900);
  await page.evaluate(() => { const e = document.getElementById('setDailyCollectCap'); e.value = '70'; e.dispatchEvent(new Event('input')); });
  await sleep(600);
  // 只截底部操作行 + 上面两行设置（看按钮同排与间距）
  await page.evaluate(() => { const f = document.querySelector('.setfoot'); f.scrollIntoView({ block: 'center' }); });
  await sleep(500);
  await page.screenshot({ path: path.join(DIR, 'logs', 'settings-layout.png') });

  console.log('\n===== 汇总 =====');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(before, null, 2), 'utf8');
  console.log('配置已还原');
  await browser.close();
  await killChromeUsingProfile();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('异常:', e.message); try { await killChromeUsingProfile(); } catch (_) {} process.exit(1); });