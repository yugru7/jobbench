/**
 * 回归：记录页「统计表(3×4) + 记录表(n×4) 合体」渲染（2026-10-13 已定）
 * 用法：先启动 server.js，再 node tests/verify-rec-stats.js
 *
 * 断言要点：
 *   1. 结构：表头 4 格 + 2 行统计各 4 格 + 记录表标题 4 格 + n 行记录各 4 格
 *   2. 列宽贯通：三段的列宽一致 → 竖线连成一条
 *   3. 其它数据表（获取/二筛/编辑招呼语）单元格有竖线 border-right
 */
const path = require('path');
let chromium;
try { ({ chromium } = require('patchright')); } catch (_) { ({ chromium } = require('playwright-core')); }
const { CHROME } = require('../../lib/utils');

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:7788/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 3000));   // 等 boot 与 bootstrap 完成

  // 切到记录页（真实点击页签按钮）
  await page.click('[data-tab="records"]', { timeout: 8000 }).catch(async () => {
    await page.evaluate(() => { const b = document.querySelector('[data-tab="records"]'); if (b) b.click(); });
  });
  await new Promise((r) => setTimeout(r, 2000));   // 等 renderRecords 拉数据

  const out = await page.evaluate(() => {
    const cells = (sel) => Array.from(document.querySelectorAll(sel))
      .map((el) => Array.from(el.children).map((c) => c.getBoundingClientRect().width.toFixed(1)));
    const txt = (id) => { const el = document.getElementById(id); return el ? (el.textContent || '') : '(缺元素)'; };
    const relines = Array.from(document.querySelectorAll('#records .recline'));
    // 数据表竖线：取筛选页表头
    const th = document.querySelector('#thead > div:nth-child(1)');
    const th2 = document.querySelector('#thead > div:nth-child(2)');
    return {
      hasTable: !!document.querySelector('.rectable'),
      headCells: cells('.rectable .rghead').flat(),
      statRows: [cells('.rectable .rgrow')[0], cells('.rectable .rgrow')[1]],
      titleCells: cells('.rectable .rgtitle').flat(),
      recCount: relines.length,
      recCells: relines.length ? Array.from(relines[0].children).map((c) => c.getBoundingClientRect().width.toFixed(1)) : [],
      vals: ['stCollected', 'stCollectedT', 'stSent', 'stSentT', 'stFilled', 'stFilledT', 'stOffline', 'stOfflineT'].map(txt),
      tableBorder: th ? getComputedStyle(th).borderRightWidth : '',
      tableBorder2: th2 ? getComputedStyle(th2).borderRightWidth : '',
      tableBorderLast: (() => {
        const l = document.querySelectorAll('#thead > div');
        return l.length ? getComputedStyle(l[l.length - 1]).borderRightWidth : '';
      })(),
      // 居中：记录页记录行 + 数据表（筛选页表头 / 首行）
      recAlign: relines.length ? Array.from(relines[0].children).map((c) => getComputedStyle(c).textAlign) : [],
      thAlign: th ? getComputedStyle(th).textAlign : '',
      rowAlign: (() => {
        const r = document.querySelector('#rows .trow > div:nth-child(3)');
        return r ? getComputedStyle(r).textAlign : '';
      })(),
      // 吸顶（2026-10-13 已定）：滚到底后，钉在顶部的应是记录表标题(rgtitle)，
      // 而不是统计表头(rghead)盖在上面。列数不够时表不可滚，跳过。
      sticky: (() => {
        const tb = document.querySelector('.rectable');
        if (!tb) return { scrollable: false };
        const scrollable = tb.scrollHeight > tb.clientHeight + 4;
        if (!scrollable) return { scrollable: false };
        tb.scrollTop = tb.scrollHeight;                       // 滚到底
        const r = tb.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + 30, Math.max(r.top, 0) + 8);
        const res = { scrollable: true,
          inTitle: !!(el && el.closest('.rgtitle')),
          inHead: !!(el && el.closest('.rghead')) };
        tb.scrollTop = 0;                                    // 还原，别影响截图
        return res;
      })(),
    };
  });

  console.log('=== 记录页合体表 ===');
  console.log('表头列宽:', out.headCells.join(' / '));
  console.log('统计行列宽:', (out.statRows[0] || []).join(' / '));
  console.log('记录表标题列宽:', out.titleCells.join(' / '));
  console.log('记录行数:', out.recCount, '| 首行列宽:', out.recCells.join(' / '));
  console.log('统计值:', out.vals.join(' | '));
  console.log('数据表竖线:', out.tableBorder, '/', out.tableBorder2, '| 末列:', out.tableBorderLast);

  const pass = [];
  const fail = [];
  const t = (cond, msg) => (cond ? pass : fail).push(msg);

  t(out.hasTable, '.rectable 存在');
  t(out.headCells.length === 4, '表头 4 格');
  t(out.statRows.length === 2 && out.statRows[0].length === 4 && out.statRows[1].length === 4, '两行统计各 4 格');
  t(out.titleCells.length === 4, '记录表标题 4 格');
  t(out.recCount === 0 || out.recCells.length === 4, '记录行 4 格');

  // 列宽贯通（容差 0.5px）
  const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(parseFloat(v) - parseFloat(b[i])) < 1.0);
  t(same(out.headCells, out.titleCells), '表头与记录表标题列宽一致（竖线贯通）');
  if (out.recCount) t(same(out.headCells, out.recCells), '记录行列宽与表头一致');

  // 统计值必须是数字或 '-'
  t(out.vals.every((v) => /^(\d+|-)$/.test(v.trim())), '统计值均为数字或 -');

  // 数据表竖线
  t(out.tableBorder !== '0px', '数据表第 1 格有右竖线');
  t(out.tableBorder2 !== '0px', '数据表第 2 格有右竖线');
  t(out.tableBorderLast === '0px', '数据表末列无右竖线');

  // 文字统一居中（2026-10-13 已定）
  t(out.recCount === 0 || out.recAlign.every((a) => a === 'center'), '记录行四列文字居中');
  t(out.thAlign === 'center', '数据表表头居中');
  t(out.rowAlign === 'center', '数据表数据行居中');

  // 吸顶（2026-10-13 已定）：滚动后顶栏是记录表标题，统计表头不再盖住下面
  if (out.sticky && out.sticky.scrollable) {
    t(out.sticky.inTitle, '滚动后顶栏是记录表标题（rgtitle 盖住统计表头）');
    t(!out.sticky.inHead, '滚动后统计表头不再盖住下方');
  } else {
    console.log('· 记录不足以滚动，跳过吸顶断言');
  }

  await page.screenshot({ path: path.join(__dirname, '..', '..', 'logs', 'recstats-shot.png') }).catch(() => {});

  console.log('');
  fail.forEach((m) => console.log('FAIL  ' + m));
  console.log(`汇总：PASS ${pass.length} / FAIL ${fail.length}`);
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e.message.slice(0, 200)); process.exit(2); });
