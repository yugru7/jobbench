/**
 * 回归：设置页（2026-10-13 已定：限额/间隔/防护参数开放给用户 + 提示词迁移）
 * 用法：先启动 server.js，再 node tests/verify-settings.js
 *
 * 覆盖：
 *   ① 设置页签（文字，排最右）、进设置页正常渲染 19 个参数 + 提示词
 *   ② 改参数 → 落盘 config.json → 刷新页面仍是新值（真的持久化）
 *   ③ 填超范围 → 服务端钳制 → 界面回填的是钳制后的值（界面 = 生效值）
 *   ④ 「恢复默认设置」把数值参数还原，且不碰提示词/城市/知识库
 *   ⑤ 设置 maxJobsPerRun 后，获取岗位页的输入框 max/value 跟着走
 *   ⑥ 每日爬取上限真的生效（爬满后 /api/collect 拒绝）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const DIR = path.join(__dirname, '..', '..');
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
let chromium;
try { ({ chromium } = require('patchright')); } catch (_) { ({ chromium } = require('playwright-core')); }
const { CHROME, sleep } = require('../../lib/utils');
const { killChromeUsingProfile } = require('../../lib/chrome-kill')(CFG.profileDir, path.join(DIR, 'logs'));

const BASE = 'http://127.0.0.1:7788';

const get = (p) => new Promise((res) => {
  http.get(BASE + p, (r) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => { try { res(JSON.parse(s)); } catch (_) { res({}); } }); }).on('error', () => res({}));
});
const post = (p, b) => new Promise((res) => {
  const d = JSON.stringify(b || {});
  const rq = http.request(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (r) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => { try { res(JSON.parse(s)); } catch (_) { res({}); } }); });
  rq.on('error', () => res({})); rq.write(d); rq.end();
});

const FIELDS = ['maxJobsPerRun', 'dailyCollectCap', 'dailyCap',
  'delayMinSec', 'delayMaxSec', 'delayTailRatio', 'delayTailMinSec', 'delayTailMaxSec',
  'collectDelayMinSec', 'collectDelayMaxSec', 'collectDelayTailRatio',
  'collectDelayTailMinSec', 'collectDelayTailMaxSec',
  'clickPauseMinMs', 'clickPauseMaxMs', 'readPauseMinMs', 'readPauseMaxMs',
  'readScrollMinPx', 'readScrollMaxPx'];
// 界面 id 用的键：毫秒字段在界面上是「秒」，所以 id 叫 ...Sec（2026-10-13 文案改版）
const UIKEY = { clickPauseMinMs: 'clickPauseMinSec', clickPauseMaxMs: 'clickPauseMaxSec',
  readPauseMinMs: 'readPauseMinSec', readPauseMaxMs: 'readPauseMaxSec' };
// 界面显示值（config→界面）：毫秒→秒、0~1→0~100
const toView = (k, v) => {
  if (v === undefined || v === null || v === '') return v;
  if (k.endsWith('Ms')) return Math.round(Number(v) / 100) / 10;
  if (k.endsWith('Ratio')) return Math.round(Number(v) * 1000) / 10;
  return v;
};

let pass = 0, fail = 0;

const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); } else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); } };

(async () => {
  // 先记下原始值，最后一定还原
  const before = (await get('/api/config')).config || {};
  const promptBefore = fs.readFileSync(path.join(DIR, 'prompts', 'greeting.md'), 'utf8');
  const cityBefore = CFG.cityCode;

  console.log('===== ① 设置页渲染 =====');
  const browser = await chromium.launchPersistentContext(CFG.profileDir, {
    executablePath: CHROME, headless: false, viewport: { width: 1400, height: 1000 },
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  // 手动保存语义（2026-10-13）：改完必须点「保存设置」才落盘
  const clickSaveBar = () => page.evaluate(() => { const b = document.getElementById('btnSaveSettings'); if (b) b.click(); });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2500);

  // 设置页签：普通文字页签，排在「记录」后面（2026-10-13 弃用齿轮）
  const settingsTab = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.tabs .tab')];
    const g = tabs.find((t) => t.getAttribute('data-tab') === 'settings');
    if (!g) return { found: false };
    const last = tabs[tabs.length - 1];
    return { found: true, isLast: g === last, others: tabs.length, text: (g.textContent || '').trim() };
  });
  ok(settingsTab.found, '设置页签存在');
  ok(settingsTab.isLast, '设置页签在最右边', '页签共 ' + settingsTab.others + ' 个');
  ok(settingsTab.text === '设置', '设置页签是文字（不是齿轮图标）', '文案=' + settingsTab.text);

  // 点进设置页（等 class="on" 真的出现再继续，避免读到切换中的瞬间 → 假失败）
  await page.evaluate(() => { const g = document.querySelector('.tab[data-tab="settings"]'); g && g.click(); });
  let active = false;
  for (let i = 0; i < 20 && !active; i++) {
    await sleep(300);
    active = await page.evaluate(() => {
      const p = document.getElementById('pageSettings');
      return !!(p && p.classList.contains('on'));
    });
  }
  await sleep(900);   // 等 loadSettings 拉完 /api/config 回填表单

  // 注意：page.evaluate 在浏览器侧执行，读不到 Node 作用域的 UIKEY，
  // 所以必须作为参数显式传进去（Patchright 同源隔离的坑）
  const view = await page.evaluate(({ fields, uikey }) => {
    const page = document.getElementById('pageSettings');
    const on = page && page.classList.contains('on');
    const vals = {};
    let missing = [];
    for (const k of fields) {
      const uk = uikey[k] || k;
      const id = 'set' + uk.charAt(0).toUpperCase() + uk.slice(1);
      const el = document.getElementById(id);
      if (!el) { missing.push(k); continue; }
      vals[k] = el.value;      // 界面值（秒 / %），比对时用 toView 换算
    }
    const pt = document.getElementById('promptText');
    return {
      on, vals, missing,
      prompt: pt ? pt.value.length : -1,
      resetBtn: !!document.getElementById('btnResetSettings'),
      sections: [...document.querySelectorAll('#pageSettings .absec')].map((e) => e.textContent.trim()),
    };
  }, { fields: FIELDS, uikey: UIKEY });
  ok(view.on, '设置页已激活');
  ok(view.missing.length === 0, '19 个参数全部渲染', view.missing.length ? '缺: ' + view.missing.join(',') : '');
  ok(view.prompt > 200, '招呼语提示词已迁入设置页', view.prompt + ' 字');
  ok(view.resetBtn, '重置按钮存在');
  console.log('     分组: ' + view.sections.join(' / '));

  // 首屏值 = 当前 config 值
  const mismatch = FIELDS.filter((k) => String(view.vals[k]) !== String(toView(k, before[k])));
  ok(mismatch.length === 0, '默认显示当前数据', mismatch.length ? '不符: ' + mismatch.map((k) => k + '(' + view.vals[k] + '≠' + before[k] + ')').join(',') : '');

  console.log('\n===== ② 改参数 → 持久化 =====');
  // 改三个代表：单次爬取上限、发送间隔、点击前停留
  await page.evaluate(() => { const e = document.getElementById('setMaxJobsPerRun'); e.value = '7'; e.dispatchEvent(new Event('input')); });
  await clickSaveBar();
  await sleep(1600);   // 等落盘 + 回填
  await page.evaluate(() => { const e = document.getElementById('setDelayMinSec'); e.value = '5'; e.dispatchEvent(new Event('input')); });
  await clickSaveBar();
  await sleep(1600);   // 等落盘 + 回填
  // 界面填「秒」（0.3 秒），落盘应为 300 毫秒
  await page.evaluate(() => { const e = document.getElementById('setClickPauseMinSec'); e.value = '0.3'; e.dispatchEvent(new Event('input')); });
  await clickSaveBar();
  await sleep(1600);   // 等落盘 + 回填

  const disk = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
  ok(disk.maxJobsPerRun === 7, 'maxJobsPerRun 已落盘 = 7', '实际 ' + disk.maxJobsPerRun);
  ok(disk.delayMinSec === 5, 'delayMinSec 已落盘 = 5', '实际 ' + disk.delayMinSec);
  ok(disk.clickPauseMinMs === 300, '界面填 0.3 秒 → config 落盘 300ms', '实际 ' + disk.clickPauseMinMs);

  // 刷新页面仍是新值（真持久化，不是内存态）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await page.evaluate(() => { const g = document.querySelector('.tab[data-tab="settings"]'); g && g.click(); });
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const a2 = await page.evaluate(() => {
      const p = document.getElementById('pageSettings');
      return !!(p && p.classList.contains('on'));
    });
    if (a2) break;
  }
  await sleep(900);
  const after = await page.evaluate(() => ({
    mj: document.getElementById('setMaxJobsPerRun').value,
    dm: document.getElementById('setDelayMinSec').value,
    cp: document.getElementById('setClickPauseMinSec').value,
  }));
  ok(after.mj === '7' && after.dm === '5' && after.cp === '0.3', '刷新后仍是新值（界面单位）', JSON.stringify(after));

  console.log('\n===== ③ 前端预校验：越界拦下不落盘 / 合法值正常保存 =====');
  // 2026-10-13 已定：越界值前端当场拦（toast + 不提交），不再走「服务端钳制后回填」。
  // 只要有一个字段越界，整个保存就被拦下，所以下面每步都先把越界项收回合法值。
  const setField = (id, v) => page.evaluate(([i, val]) => {
    const e = document.getElementById(i); e.value = val; e.dispatchEvent(new Event('input'));
  }, [id, v]);
  const fieldVal = (id) => page.evaluate((i) => document.getElementById(i).value, id);
  const cfgNow = () => JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
  const cfg0 = cfgNow();

  await setField('setDailyCollectCap', '9999');
  await clickSaveBar();
  await sleep(1200);
  ok(cfgNow().dailyCollectCap === cfg0.dailyCollectCap,
    '填 9999 被前端拦下，不落盘', 'config 仍 ' + cfgNow().dailyCollectCap);
  ok((await fieldVal('setDailyCollectCap')) === '9999', '越界值留在输入框里等用户改');

  await setField('setDelayTailRatio', '999');
  await clickSaveBar();
  await sleep(1200);
  ok(cfgNow().delayTailRatio === cfg0.delayTailRatio,
    '比例填 999% 被前端拦下，不落盘', 'config 仍 ' + cfgNow().delayTailRatio);

  // 合法值：先把越界项收回原始值，再存；比例界面是百分数
  await setField('setDailyCollectCap', String(cfg0.dailyCollectCap));
  await setField('setDelayTailRatio', String(Math.round(cfg0.delayTailRatio * 1000) / 10));
  await setField('setDelayMinSec', '5');
  await clickSaveBar();
  await sleep(1200);
  ok(cfgNow().delayMinSec === 5, '合法值正常落盘（5 秒 → 5000ms）', 'delayMinMs=' + cfgNow().delayMinMs);

  // 0 是合法值（沟通前在 JD 页面停留可为 0），不能被吞成默认
  await setField('setClickPauseMinSec', '0');
  await clickSaveBar();
  await sleep(1200);
  const zero = cfgNow().clickPauseMinMs;
  ok(zero === 0, '填 0 秒被正确保存为 0ms（0 是合法值，不吞成默认）', '实际 ' + zero);

  console.log('\n===== ④ 恢复默认 =====');
  page.once('dialog', (d) => d.accept());
  await page.evaluate(() => { document.getElementById('btnResetSettings').click(); });
  await sleep(1800);
  const resetDisk = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
  const expected = { maxJobsPerRun: 10, dailyCollectCap: 80, dailyCap: 60, delayMinSec: 4, delayMaxSec: 6,
    delayTailRatio: 0.25, delayTailMinSec: 6, delayTailMaxSec: 12, clickPauseMinMs: 0, clickPauseMaxMs: 2000,
    readPauseMinMs: 1000, readPauseMaxMs: 2000, readScrollMinPx: 300, readScrollMaxPx: 700 };
  const badReset = Object.keys(expected).filter((k) => resetDisk[k] !== expected[k]);
  ok(badReset.length === 0, '数值参数全部还原默认', badReset.length ? '不符: ' + badReset.map((k) => k + '=' + resetDisk[k]).join(',') : '');
  ok(resetDisk.cityCode === cityBefore, '城市未被重置影响', resetDisk.cityCode);
  const promptAfter = fs.readFileSync(path.join(DIR, 'prompts', 'greeting.md'), 'utf8');
  ok(promptAfter === promptBefore, '招呼语提示词未被重置影响');
  const uiReset = await page.evaluate(() => ({ mj: document.getElementById('setMaxJobsPerRun').value, dc: document.getElementById('setDailyCollectCap').value }));
  ok(uiReset.mj === '10' && uiReset.dc === '80', '界面回填默认值', JSON.stringify(uiReset));

  console.log('\n===== ⑤ 单次爬取上限联动 =====');
  await page.evaluate(() => { const e = document.getElementById('setMaxJobsPerRun'); e.value = '20'; e.dispatchEvent(new Event('input')); });
  await clickSaveBar();
  await sleep(1600);   // 等落盘 + 回填
  await page.evaluate(() => { document.querySelector('.tabs .tab[data-tab="fetch"]').click(); });
  await sleep(900);
  const mjBox = await page.evaluate(() => { const e = document.getElementById('maxJobs'); return { max: e.max, val: e.value }; });
  ok(mjBox.max === '20', '获取岗位页输入框 max 跟随设置 = 20', '实际 ' + mjBox.max);

  // 回到默认
  await page.evaluate(() => { const e = document.getElementById('setMaxJobsPerRun'); e.value = '10'; e.dispatchEvent(new Event('input')); });
  await clickSaveBar();
  await sleep(1600);   // 等落盘 + 回填

  console.log('\n===== ⑥ 每日爬取上限生效 =====');
  // 临时把上限设成「今日已爬」的值 → 应拒绝
  const stats = JSON.parse(fs.readFileSync(path.join(DIR, 'logs', 'stats.json'), 'utf8'));
  const today = new Date();
  const dk = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const todayN = (stats.collect && stats.collect.daily && stats.collect.daily[dk]) || 0;
  await post('/api/config', { dailyCollectCap: Math.max(todayN, 1) });
  const rejected = await post('/api/collect', { source: 'expect', expectTab: '前端开发（北京）', maxJobs: 1 });
  ok(rejected.ok === false && /今日爬取已达上限/.test(rejected.error || ''), '爬满后被拒绝', rejected.error || '(没拒绝)');
  await post('/api/config', { dailyCollectCap: 80 });

  console.log('\n===== 汇总 =====');
  console.log('PASS ' + pass + ' / FAIL ' + fail);

  // 还原现场
  for (const k of Object.keys(before)) if (/^(maxJobsPerRun|dailyCollectCap|dailyCap|delay|collectDelay|clickPause|readPause|readScroll)/.test(k)) {
    await post('/api/config', { [k]: before[k] });
  }
  const restored = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
  const notRestored = Object.keys(before).filter((k) => /^(maxJobsPerRun|dailyCollectCap|dailyCap|delay|collectDelay|clickPause|readPause|readScroll)/.test(k) && restored[k] !== before[k]);
  console.log('参数还原: ' + (notRestored.length ? '⚠️ ' + notRestored.join(',') : '✅ 与测试前一致'));

  await browser.close();
  await killChromeUsingProfile();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('验证脚本异常:', e.message);
  try { await killChromeUsingProfile(); } catch (_) {}
  process.exit(1);
});