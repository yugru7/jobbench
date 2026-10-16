/**
 * 回归：知识库「边写边存」（2026-10-13 已定，方案 B：去掉保存按钮，改动自动落盘）
 * 用法：先启动 server.js，再 node tests/verify-kb-autosave.js
 *
 * 覆盖：
 *   ① 知识库页不再有「保存知识库」按钮
 *   ② 改「我是谁」→ 停手约 0.9s → knowledge.json 真的更新（防抖自动保存）
 *   ③ 未到防抖时间就切页签 → 立刻冲盘（kbFlush），不等 0.9s
 *   ④ 新增经历 + 填内容 → 自动落盘
 * 收尾：把测试前的 knowledge.json 原样写回（用 /api/knowledge，文件与内存一致）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const DIR = path.join(__dirname, '..', '..');
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const KNOW = path.join(DIR, 'knowledge.json');
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

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✅ ' + name + (extra ? '  ' + extra : '')); } else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); } };
const diskKnow = () => { try { return JSON.parse(fs.readFileSync(KNOW, 'utf8')); } catch (_) { return {}; } };

(async () => {
  const had = fs.existsSync(KNOW);
  const origRaw = had ? fs.readFileSync(KNOW, 'utf8') : '';
  const origObj = had ? JSON.parse(origRaw) : null;
  const marker = 'AUTOSAVE-TEST-' + Date.now();

  console.log('===== ① 打开知识库页 =====');
  try { killChromeUsingProfile(); } catch (_) {}
  await sleep(600);
  const browser = await chromium.launchPersistentContext(CFG.profileDir, {
    executablePath: CHROME, headless: false, viewport: { width: 1400, height: 1000 },
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(2500);
  await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="kb"]'); t && t.click(); });
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const on = await page.evaluate(() => { const p = document.getElementById('pageKb'); return !!(p && p.classList.contains('on')); });
    if (on) break;
  }
  await sleep(600);
  const hasSaveBtn = await page.evaluate(() => !!document.querySelector('#pageKb button[onclick*="saveKnowledge"]'));
  ok(!hasSaveBtn, '知识库页已无「保存知识库」按钮');

  console.log('\n===== ② 改字 → 防抖自动落盘 =====');
  await page.fill('#kIdentity', marker);
  await sleep(200);
  const early = (diskKnow().profile || {}).identity;
  ok(early !== marker, '刚打完字还没到点 → 尚未落盘', '现在=' + early);
  await sleep(1400);
  const after = (diskKnow().profile || {}).identity;
  ok(after === marker, '停手约 0.9s 后 → knowledge.json 已更新', '现在=' + after);

  console.log('\n===== ③ 未到点就切页签 → 立刻冲盘 =====');
  const marker2 = marker + 'B';
  await page.fill('#kIdentity', marker2);
  await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="dir"]'); t && t.click(); });
  await sleep(500);   // 500ms < 900ms 防抖，若落盘则说明是 kbFlush 干的
  const flushed = (diskKnow().profile || {}).identity;
  ok(flushed === marker2, '切走后立即落盘（不等防抖）', '现在=' + flushed);

  console.log('\n===== ④ 新增经历 → 自动落盘 =====');
  await page.evaluate(() => { const t = document.querySelector('.tab[data-tab="kb"]'); t && t.click(); });
  await sleep(700);
  const entryTitle = 'AUTOSAVE-ENTRY-' + Date.now();
  await page.evaluate(() => { const b = document.querySelector('#pageKb button[onclick="addEntry()"]'); b && b.click(); });
  await sleep(300);
  await page.evaluate((t) => {
    const ins = document.querySelectorAll('#entries input[type="text"]');
    const el = ins[ins.length - 1];
    if (el) { el.value = t; el.dispatchEvent(new Event('input')); }
  }, entryTitle);
  await sleep(1400);
  const ents = diskKnow().entries || [];
  ok(ents.some((e) => e.title === entryTitle), '新增经历已落盘');

  console.log('\n===== 收尾：还原 knowledge.json =====');
  await browser.close();
  await sleep(400);
  if (origObj) {
    const r = await post('/api/knowledge', origObj);
    ok(r.ok === true, '已把测试前的知识库写回');
  } else {
    console.log('  (原本没有 knowledge.json，跳过还原)');
  }
  const back = diskKnow();
  const same = origObj ? JSON.stringify(back) === JSON.stringify(origObj) : true;
  ok(same, 'knowledge.json 与测试前一致');

  console.log('\n===== 汇总 =====');
  console.log(`PASS ${pass} / FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('脚本异常: ' + (e && e.message)); process.exit(1); });
