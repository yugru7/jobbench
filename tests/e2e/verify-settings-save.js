/**
 * 回归：设置页「手动保存 + 离开拦截」
 * 用法：先启动 server.js，再 node tests/verify-settings-save.js
 *
 * 覆盖：
 *   ① 改动不再自动生效（config 不变）→ 保存按钮点亮
 *   ② 点「保存设置」→ 落盘 + 按钮回到置灰
 *   ③ 「撤销改动」→ 回到上次保存的值
 *   ④ 改完不保存直接切页签 → 弹窗确认（取消=留下，确定=走），且未落盘
 *   ⑤ 恢复默认仍立即生效（明确破坏性操作，不等保存）
 *   ⑥ 提示词：按钮 → 屏幕中间大输入框（取消=还原，完成=保留改动，落盘仍归「保存设置」）
 *   ⑦ 本页刷新：未保存改动不丢（sessionStorage 草稿恢复；已去掉原生刷新弹窗）
 *
 * 注意：Patchright 隔离执行上下文 —— evaluate 里拿不到 window.switchTab，
 *       所以一律走 DOM 事件触发 inline onclick；confirm 用原生 dialog 事件模拟
 *       （dismiss≈用户点「取消」，accept≈点「确定」）。
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
const cfgNow = () => JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'config.json'), 'utf8'));

(async () => {
  // 基线：把每日爬取上限固定成 80，让断言可预期
  await post('/api/config', { dailyCollectCap: 80 });
  const before = cfgNow();

  const browser = await chromium.launchPersistentContext(CFG0.profileDir, {
    executablePath: CHROME, headless: false, viewport: { width: 1400, height: 1100 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();

  const enterSettings = async () => {
    await page.evaluate(() => { const g = document.querySelector('.tab[data-tab="settings"]'); if (g) g.click(); });
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const a = await page.evaluate(() => { const p = document.getElementById('pageSettings'); return !!(p && p.classList.contains('on')); });
      if (a) break;
    }
    await sleep(900);
  };
  const clickTab = (tab) => page.evaluate((t) => {
    const el = document.querySelector('.tabs .tab[data-tab="' + t + '"]');
    if (el) el.click();
  }, tab);
  const onPage = () => page.evaluate(() => (document.querySelector('.page.on') || {}).id);
  const saveBtnEnabled = () => page.evaluate(() => { const b = document.getElementById('btnSaveSettings'); return !!(b && !b.disabled); });
  const setField = async (id, val) => {
    // Patchright 的 evaluate 只接受 1 个参数，多参数要包成对象
    await page.evaluate(({ i, v }) => { const e = document.getElementById(i); e.value = String(v); e.dispatchEvent(new Event('input')); }, { i: id, v: val });
    await sleep(700);
  };
  const clickBar = (pattern) => page.evaluate((pat) => {
    const b = [...document.querySelectorAll('.setfoot button')].find((x) => new RegExp(pat).test(x.textContent));
    if (b) b.click();
  }, pattern);
  // 自定义弹窗自动应答（core.js askBox，不用原生 confirm）：
//   'yes' → 点「保存」（先落盘再离开）  'no' → 点「不保存」（放弃改动直接走）
  //   null  → 只观察不点（验证"弹窗确实出现"）
  let asks = [];
  const useAsk = (answer) => {
    asks = [];
    if (page.__askTimer) { clearInterval(page.__askTimer); page.__askTimer = null; }
    page.__askTimer = setInterval(async () => {
      try {
        const shown = await page.evaluate(() => !document.getElementById('askBox').hidden);
        if (!shown) return;
        const msg = await page.evaluate(() => document.getElementById('askMsg').textContent);
        asks.push(msg);
        if (answer) {
          await page.evaluate((a) => {
            const b = document.getElementById(a === 'yes' ? 'askYes' : 'askNo');
            if (b) b.click();
          }, answer);
        }
        clearInterval(page.__askTimer); page.__askTimer = null;
      } catch (_) {}
    }, 200);
  };

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2500);
  await enterSettings();

  console.log('===== ① 改动不自动生效，保存条出现 =====');
  ok(!(await saveBtnEnabled()), '初始：保存按钮置灰（无改动不可点）');
  await setField('setDailyCollectCap', 77);
  let disk = cfgNow();
  ok(disk.dailyCollectCap === 80, '改完不点保存 → config 没变（不自动生效）', 'config=' + disk.dailyCollectCap);
  ok(await saveBtnEnabled(), '有改动 → 保存按钮点亮');

  console.log('\n===== ② 点「保存设置」→ 落盘 =====');
  await clickBar('保存设置');
  await sleep(1800);
  disk = cfgNow();
  ok(disk.dailyCollectCap === 77, '点保存 → config 落盘 77', '实际 ' + disk.dailyCollectCap);
  ok(!(await saveBtnEnabled()), '保存后按钮回到置灰');

  console.log('\n===== ③ 撤销改动 =====');
  await setField('setDailyCollectCap', 88);
  ok(await saveBtnEnabled(), '改动后按钮点亮');
  await clickBar('撤销');
  await sleep(1600);
  const undoVal = await page.evaluate(() => document.getElementById('setDailyCollectCap').value);
  ok(undoVal === '77', '撤销后回到上次保存的值（77）', '实际 ' + undoVal);
  ok(!(await saveBtnEnabled()), '撤销后按钮回到置灰');

  console.log('\n===== ④ 未保存就切页签 → 弹「保存 / 不保存」=====');
  await setField('setDailyCollectCap', 99);
  // 先只观察不点 → 验证弹窗出现、且切页被拦住
  useAsk(null);
  await clickTab('fetch');
  await sleep(1200);
  ok(asks.length >= 1, '切页签时弹出自定义弹窗', asks.length + ' 次');
  ok(asks[0] ? /还没保存/.test(asks[0]) : false, '弹窗内容是「还没保存」提示', JSON.stringify(asks[0] || '').slice(0, 70));
  const btnTexts = await page.evaluate(() => ({
    no: (document.getElementById('askNo') || {}).textContent,
    yes: (document.getElementById('askYes') || {}).textContent,
  }));
  ok(btnTexts.no === '不保存' && btnTexts.yes === '保存', '按钮是「不保存 / 保存」', JSON.stringify(btnTexts));
  ok((await onPage()) === 'pageSettings', '弹窗未点掉前切不过去（仍留在设置页）', '当前 ' + await onPage());
  disk = cfgNow();
  ok(disk.dailyCollectCap === 77, '弹窗期间 config 未变（99 未落盘）', '实际 ' + disk.dailyCollectCap);
  // ESC = 放弃操作 → 也留在设置页
  await page.keyboard.press('Escape');
  await sleep(700);
  ok((await onPage()) === 'pageSettings', 'ESC 关闭弹窗 → 留在设置页', '当前 ' + await onPage());

  // 点「不保存」→ 放弃改动直接走
  useAsk('no');
  await clickTab('fetch');
  await sleep(1400);
  ok((await onPage()) === 'pageFetch', '点「不保存」→ 直接离开', '当前 ' + await onPage());
  disk = cfgNow();
  ok(disk.dailyCollectCap === 77, '不保存 → 99 未落盘（config 仍是 77）', '实际 ' + disk.dailyCollectCap);

  // 再进设置页改一次 → 点「保存」→ 应落盘并离开
  await enterSettings();
  await setField('setDailyCollectCap', 66);
  useAsk('yes');
  await clickTab('fetch');
  await sleep(2400);
  disk = cfgNow();
  ok(disk.dailyCollectCap === 66, '点「保存」→ 66 已落盘', '实际 ' + disk.dailyCollectCap);
  ok((await onPage()) === 'pageFetch', '保存后确实离开了设置页', '当前 ' + await onPage());

  console.log('\n===== ⑤ 恢复默认仍立即生效 =====');
  // 「恢复默认」仍用原生 confirm（这次没改它），Patchright 会自动 dismiss → 需手动 accept
  page.once('dialog', (d) => d.accept().catch(() => {}));
  await page.evaluate(() => { document.getElementById('btnResetSettings').click(); });
  await sleep(1800);
  disk = cfgNow();
  ok(disk.dailyCollectCap === 80, '恢复默认立即落盘（80），不等点保存', '实际 ' + disk.dailyCollectCap);
  ok(!(await saveBtnEnabled()), '恢复默认后按钮置灰（视为已保存）');

  console.log('\n===== ⑥ 提示词：按钮 → 屏幕中间大输入框 =====');
  const promptBefore = (await (await fetch(BASE + '/api/prompt')).json()).text;
  // ⑤ 结束时停在「获取岗位」页，先回设置页（提示词按钮在设置页里，隐藏页点不到）
  await clickTab('settings');
  await sleep(1500);
  const pt0 = await page.evaluate(() => {
    const box = document.getElementById('promptBox');
    const cnt = document.getElementById('pageSettings');
    const btn = document.querySelector('#promptBox button');
    return {
      btn: !!btn,
      btnText: btn ? btn.textContent.trim() : '',
      inSettings: !!(box && cnt && cnt.contains(box)),
      segGone: !document.querySelector('#promptSeg'),
      modalHidden: document.getElementById('promptModal').hidden,
      hasTa: !!document.getElementById('promptText'),
    };
  });
  ok(pt0.btn && pt0.inSettings && pt0.hasTa, '设置页有一个提示词按钮');
  ok(pt0.btnText === '修改招呼语提示词', '按钮文案「修改招呼语提示词」', pt0.btnText);
  ok(pt0.segGone, '「默认 / 自定义」分段已去掉');
  ok(pt0.modalHidden, '弹窗默认不显示');

  // 点按钮 → 弹窗出现在屏幕中间，输入框够大
  await page.click('#promptBox button');
  await sleep(400);
  const modal = await page.evaluate(() => {
    const m = document.getElementById('promptModal');
    const ta = document.getElementById('promptText');
    const card = m.querySelector('.askcard').getBoundingClientRect();
    const r = ta.getBoundingClientRect();
    return {
      shown: !m.hidden, w: Math.round(r.width), h: Math.round(r.height),
      cx: Math.round(card.left + card.width / 2), cy: Math.round(card.top + card.height / 2),
      vw: window.innerWidth, vh: window.innerHeight, len: ta.value.length,
      st: ta.scrollTop, selStart: ta.selectionStart,
    };
  });
  ok(modal.shown, '点按钮后弹窗出现');
  ok(modal.w >= 600 && modal.h >= 300, '输入框够大', `${modal.w}×${modal.h}`);
  ok(Math.abs(modal.cx - modal.vw / 2) <= 2 && Math.abs(modal.cy - modal.vh / 2) <= 2,
    '弹窗在屏幕中间', `中心 ${modal.cx},${modal.cy}／视口 ${modal.vw},${modal.vh}`);
  ok(modal.len === promptBefore.length && modal.len > 0, '打开时载入当前提示词', modal.len + ' 字');
  ok(modal.st === 0, '打开时滚动条在最上面（不是底部）', 'scrollTop=' + modal.st);
  ok(modal.selStart === 0, '打开时光标在开头', 'selStart=' + modal.selStart);
  await page.screenshot({ path: path.join(DIR, 'logs', 'prompt-modal.png') });

  // 「取消」= 还原，不算改动
  await page.fill('#promptText', '取消测试-这段不该留下');
  await page.click('.askcard.wide .askbtns button:nth-child(2)');
  await sleep(300);
  const pCancel = await page.evaluate(() => ({
    hidden: document.getElementById('promptModal').hidden,
    val: document.getElementById('promptText').value,
  }));
  ok(pCancel.hidden, '点「取消」后弹窗关闭');
  ok(pCancel.val === promptBefore, '「取消」还原成打开时的内容');

  // 「恢复默认」= 只把出厂版填进输入框，不写文件（落盘仍归「保存设置」）
  page.once('dialog', (d) => d.accept().catch(() => {}));
  await page.click('#promptBox button');
  await sleep(300);
  await page.click('.askcard.wide .askbtns button:nth-child(1)');
  await sleep(900);
  const pReset = await page.evaluate(() => document.getElementById('promptText').value);
  const defLen = (await (await fetch(BASE + '/api/prompt')).json()).defaultText.length;
  ok(defLen > 0 && pReset.length === defLen, '「恢复默认」把出厂版填进输入框', pReset.length + ' 字');
  await page.click('.askcard.wide .askbtns button:nth-child(2)');   // 取消 → 还原
  await sleep(300);

  // 「完成」= 保留改动 + 标脏（真正落盘仍归「保存设置」）
  await page.click('#promptBox button');
  await sleep(300);
  await page.fill('#promptText', promptBefore + '\n完成测试');
  await page.click('.askcard.wide .askbtns button:nth-child(3)');
  await sleep(400);
  const pDone = await page.evaluate(() => ({
    hidden: document.getElementById('promptModal').hidden,
    len: document.getElementById('promptText').value.length,
    saveEnabled: !document.getElementById('btnSaveSettings').disabled,
    dirty: (document.getElementById('setDirtyHint') || {}).textContent || '',
  }));
  ok(pDone.hidden, '点「完成」后弹窗关闭');
  ok(pDone.len > promptBefore.length, '「完成」保留编辑内容', pDone.len + ' 字');
  ok(pDone.saveEnabled, '编辑后「保存设置」点亮（跟设置页一起保存）', pDone.dirty);

  // 截图：设置页顶部（提示词按钮 + 其余设置项）
  await page.screenshot({ path: path.join(DIR, 'logs', 'settings-save-bar.png'), fullPage: true });
  // 不点保存 —— 提示词文件不该被测试动过
  const promptAfter = (await (await fetch(BASE + '/api/prompt')).json()).text;
  ok(promptAfter === promptBefore, '测试没写 prompts/greeting.md（改动还挂在设置页待保存）');

  // ===== ⑦ 本页刷新：未保存改动不丢（取代原生刷新弹窗）=====
  console.log('\n===== ⑦ 本页刷新：未保存改动不丢 =====');
  // 先用「撤销改动」把 ⑥ 遗留的提示词改动丢掉，回到干净起点（顺带验证撤销会清草稿，不写文件）
  await clickBar('撤销');
  await sleep(1800);
  ok(!(await saveBtnEnabled()), '撤销后回到已保存状态（干净起点）');

  await setField('setDailyCollectCap', 55);
  disk = cfgNow();
  ok(disk.dailyCollectCap === 80, '改 55 未点保存 → 未落盘', '实际 ' + disk.dailyCollectCap);
  ok(await saveBtnEnabled(), '按钮点亮（未保存）');

  // 同一标签页刷新 → sessionStorage 草稿应把 55 原样带回，且仍标记未保存
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2500);
  if ((await onPage()) !== 'pageSettings') { await enterSettings(); } else { await sleep(900); }
  await sleep(400);
  const afterReload = await page.evaluate(() => ({
    val: document.getElementById('setDailyCollectCap').value,
    dirty: !document.getElementById('btnSaveSettings').disabled,
  }));
  ok(afterReload.val === '55', '刷新后仍是未保存的值 55（草稿恢复）', '实际 ' + afterReload.val);
  ok(afterReload.dirty, '刷新后仍标记为「未保存」');

  // 收尾：撤销改动 → 草稿清掉、回到已保存的 80（保证段末干净）
  await clickBar('撤销');
  await sleep(1600);
  ok((await page.evaluate(() => document.getElementById('setDailyCollectCap').value)) === '80', '撤销后回到已保存的 80');

  console.log('\n===== 汇总 =====');
  console.log('PASS ' + pass + ' / FAIL ' + fail);

  for (const k of Object.keys(before)) {
    if (/^(maxJobsPerRun|dailyCollectCap|dailyCap|delay|collectDelay|clickPause|readPause|readScroll)/.test(k)) await post('/api/config', { [k]: before[k] });
  }
  const now = cfgNow();
  const drift = Object.keys(before).filter((k) => /^(maxJobsPerRun|dailyCollectCap|dailyCap|delay|collectDelay|clickPause|readPause|readScroll)/.test(k) && now[k] !== before[k]);
  console.log('参数还原: ' + (drift.length ? '⚠️ ' + drift.map((k) => k + '=' + now[k]).join(',') : '✅ 与测试前一致'));

  await browser.close();
  await killChromeUsingProfile();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('异常:', e.message); try { await killChromeUsingProfile(); } catch (_) {} process.exit(1); });