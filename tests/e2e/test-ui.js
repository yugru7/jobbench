// UI 回归测试：无头打开本地面板，断言「五页签 / 各页关键元素 / 一屏 / 卡片同宽」并截图
// 用法：先起服务（node server.js），再 node test-ui.js
// 截图：ui-shot-dir/fetch/edit/kb.png（1440）· ui-shot.png（二次筛选 1440）· ui-shot-wide.png（1920）
// 有 FAIL 时退出码 1
const fs = require('fs');
const path = require('path');
const { chromium } = require('patchright');

const URL = 'http://127.0.0.1:7788/';
const LOGS = path.join(__dirname, '..', '..', 'logs');

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
];

(async () => {
  const chrome = CHROME_PATHS.find(p => p && fs.existsSync(p));
  if (!chrome) { console.log('SKIP: 找不到系统 Chrome，跳过 UI 回归'); process.exit(0); }

  const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-proxy-server'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);   // 等 bootstrap 渲染完

  const probe = () => page.evaluate(() => {
    const id = (x) => document.getElementById(x);
    const vis = (x) => { const el = id(x); return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); };
    const has = (pid, cid) => { const p = id(pid); return !!(p && id(cid) && p.contains(id(cid))); };
    const cardW = (pid) => { const p = id(pid); const c = p && p.querySelector('.card'); return c ? Math.round(c.getBoundingClientRect().width) : 0; };
    return {
      tabs: [...document.querySelectorAll('.tab')].map(e => e.textContent.trim()).join(','),
      visDir: vis('pageDir'), visFetch: vis('pageFetch'), visFilter: vis('pageFilter'),
      visEdit: vis('pageEdit'), visSend: vis('pageSend'), visRec: vis('pageRecords'), visKb: vis('pageKb'),
      dirHas: has('pageDir', 'collectSource') && has('pageDir', 'kwChips') && has('pageDir', 'expectChips') && !has('pageDir', 'btnCollect'),
      fetchHas: has('pageFetch', 'btnCollect') && has('pageFetch', 'btnStop') && has('pageFetch', 'fetchRows') && has('pageFetch', 'goDel') && !has('pageFetch', 'goClear') && !has('pageFetch', 'collectSource'),
      filterHas: has('pageFilter', 'fActive') && has('pageFilter', 'tableWrap') && has('pageFilter', 'selInfo') && !has('pageFilter', 'btnCollect'),
      greetGoneFromFilter: !document.querySelector('#rows textarea'),
      editHas: has('pageEdit', 'editWrap') && has('pageEdit', 'editRows') && has('pageEdit', 'editEmpty') && !has('pageEdit', 'btnSend') && !has('pageEdit', 'modes'),
      // 招呼语提示词从「编辑招呼语」页迁到「设置」页
      promptBox: has('pageSettings', 'promptBox') && !!id('promptText'),
      promptGoneFromEdit: !has('pageEdit', 'promptBox'),
      setHas: has('pageSettings', 'btnResetSettings') && has('pageSettings', 'setMaxJobsPerRun')
        && has('pageSettings', 'setDelayMinSec') && has('pageSettings', 'setClickPauseMinSec')
        && has('pageSettings', 'setDailyCollectCap'),
      // 文案改版：内部术语不得出现在用户可见文案里
      setPlainCopy: (() => {
        const t = (document.getElementById('pageSettings') || {}).innerText || '';
        return !/长尾|普通间隔|点击前停留|阅读停顿|阅读滚动距离|行为防护|毫秒/.test(t);
      })(),
      settingsLast: (() => {
        const tabs = [...document.querySelectorAll('.tabs .tab')];
        return tabs.length ? tabs[tabs.length - 1].getAttribute('data-tab') === 'settings' : false;
      })(),
      editEmptyOn: vis('editEmpty'),
      editHasRows: document.querySelectorAll('#editRows .trow').length,
      sendHas: has('pageSend', 'modes') && has('pageSend', 'btnSend') && has('pageSend', 'mCand') && !has('pageSend', 'editRows') && !has('pageSend', 'records'),
      recHas: has('pageRecords', 'records') && !has('pageRecords', 'btnSend') && !has('pageRecords', 'modes'),
      modeLabels: [...document.querySelectorAll('#modes button')].map(e => e.textContent.trim()).join(','),
      kbHas: has('pageKb', 'kIdentity') && has('pageKb', 'kSkills') && has('pageKb', 'entries'),
      steps: ['pageDir', 'pageFetch', 'pageFilter', 'pageEdit', 'pageSend', 'pageRecords'].map(p => {
        const s = id(p).querySelector('.step'); return s ? s.textContent.trim() : '?';
      }).join(','),
      logHidden: !!id('logBox') && !vis('logBox'),
      docH: document.documentElement.scrollHeight, viewH: window.innerHeight,
      rowCount: document.querySelectorAll('#rows .trow').length,
      fetchCount: document.querySelectorAll('#fetchRows .trow').length,
      gapKw: Math.round(id('kwNew').getBoundingClientRect().left - id('kwChips').getBoundingClientRect().right),
      cityOptions: document.querySelectorAll('#citySel option').length,
      provOptions: document.querySelectorAll('#provSel option').length,
      kwCount: document.querySelectorAll('#kwChips .chip').length,
      cityCustomGone: !id('cityCustomRow') && !id('cityCustomName'),
      cardW: cardW('pageDir') || cardW('pageFetch') || cardW('pageFilter') || cardW('pageEdit') || cardW('pageSend') || cardW('pageRecords'),
      kbCardW: cardW('pageKb'),
      // 可见文案 em-dash 统计：textContent 层面遍历、跳过 .jdcell（JD 摘要是
      // BOSS 原文，外部数据里的「——」不该算自家文案违规；
      // 曾有公司 JD 自带「——」被误报过一次）
      emDash: (() => {
        let n = 0;
        const walk = (el) => {
          for (const node of el.childNodes) {
            if (node.nodeType === 3) n += (node.textContent.match(/——/g) || []).length;
            else if (node.nodeType === 1) {
              const tag = node.tagName;
              // SCRIPT/STYLE（代码注释不算 UI 文案）、TEXTAREA（提示词长文档是
              // 用户可编辑内容，里面的「——」是用户的自由，不算文案违规）、
              // jdcell（JD 摘要是 BOSS 外部数据）、jobname/rjob（岗位名也是 BOSS
              // 外部数据 —— 含「——」的岗位名会被误报）
              if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA'
                || node.classList.contains('jdcell')
                || node.classList.contains('jobname')
                || node.classList.contains('rjob')) continue;
              walk(node);
            }
          }
        };
        walk(document.body);
        return n;
      })(),
    };
  });

  fs.mkdirSync(LOGS, { recursive: true });

  // 默认落在「岗位初筛」页
  await page.screenshot({ path: path.join(LOGS, 'ui-shot-dir.png') });
  const rDir = await probe();

  await page.click('.tab[data-tab="fetch"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(LOGS, 'ui-shot-fetch.png') });
  const rFetch = await probe();

  await page.click('.tab[data-tab="filter"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(LOGS, 'ui-shot.png') });
  const rFilter = await probe();

  await page.click('.tab[data-tab="edit"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(LOGS, 'ui-shot-edit.png') });
  const rEdit = await probe();

  await page.click('.tab[data-tab="send"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(LOGS, 'ui-shot-send.png') });
  const rSend = await probe();

  await page.click('.tab[data-tab="records"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(LOGS, 'ui-shot-records.png') });
  const rRec = await probe();

  await page.click('.tab[data-tab="kb"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(LOGS, 'ui-shot-kb.png') });
  const rKb = await probe();

  // 城市级联烟测：选「浙江」省 → 城市列表切过去 → 选「杭州」→ CITY 应更新；再切回北京
  // 注意：patchright 的 page.evaluate 读不到页面顶层 let（CITY/BOOT 都在隔离环境不可见），
  // 这条走原始 CDP（Runtime.evaluate 在主世界执行）
  const cdp = await page.context().newCDPSession(page);
  const citySwap = (await cdp.send('Runtime.evaluate', {
    expression: `(function () {
      const prov = document.getElementById('provSel');
      const csel = document.getElementById('citySel');
      const pick = (el, n) => Array.prototype.find.call(el.options, (o) => o.textContent === n);
      const p = pick(prov, '浙江');
      if (!p) return 'no-prov';
      prov.value = p.value; prov.dispatchEvent(new Event('change'));
      const hz = pick(csel, '杭州');
      if (!hz) return 'no-city';
      csel.value = hz.value; csel.dispatchEvent(new Event('change'));
      let hit = 'no-binding';
      try { hit = CITY.name; } catch (e) { hit = 'ERR:' + e.message; }
      const bj = pick(prov, '北京');
      if (bj) { prov.value = bj.value; prov.dispatchEvent(new Event('change')); }
      const bjc = pick(csel, '北京');
      if (bjc) { csel.value = bjc.value; csel.dispatchEvent(new Event('change')); }
      return hit;
    })()`,
    returnByValue: true,
  })).result.value;
  await cdp.detach();

  // 筛选条件记忆烟测：改两个筛选 → 刷新 → 值应还在（localStorage 持久化，要求）
  await page.evaluate(() => {
    const fsal = document.getElementById('fSal');
    fsal.value = '150'; fsal.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const memo = await page.evaluate(() => ({
    sal: document.getElementById('fSal').value,
  }));
  // 测完恢复默认并清掉存储，不污染用户界面
  await page.evaluate(() => {
    const fsal = document.getElementById('fSal');
    if (fsal) { fsal.value = ''; fsal.dispatchEvent(new Event('input')); }
    try { localStorage.removeItem('boss-filters'); } catch (_) {}
  });
  await page.waitForTimeout(200);

  // 宽屏：回二次筛选页（表格最吃宽度的一页）
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.click('.tab[data-tab="filter"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(LOGS, 'ui-shot-wide.png') });
  const rWide = await probe();

  await browser.close();

  const out = [];
  const ok = (name, cond, extra) => out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
  // 设置页签改成普通文字页签，排在「记录」后面
  ok('页签 = 项目介绍/如何使用/个人经历知识库/岗位初筛/获取岗位/二次筛选/编辑招呼语/发送/记录/设置，默认岗位初筛',
    rDir.tabs === '项目介绍,如何使用,个人经历知识库,岗位初筛,获取岗位,二次筛选,编辑招呼语,发送,记录,设置' && rDir.settingsLast
      && rDir.visDir && !rDir.visFetch && !rDir.visKb && !rDir.visEdit && !rDir.visSend && !rDir.visRec, rDir.tabs);
  ok('页1 岗位初筛：只有配置（来源/城市/方向），爬取按钮不在这页', rDir.dirHas);
  ok('页2 获取岗位：爬取按钮 + 停止 + 全量岗位表', rFetch.fetchHas);
  ok('页3 二次筛选：筛选器 + 勾选表，表格不带招呼语编辑框', rFilter.filterHas && rFilter.greetGoneFromFilter);
  ok('页4 编辑招呼语：表格结构（岗位/公司/JD/招呼语），没有发送按钮和方式选择', rEdit.editHas);
  ok('设置页：限额/间隔/防护参数 + 提示词 + 重置（提示词已从编辑页迁出）',
    rEdit.promptBox && rEdit.setHas && rEdit.promptGoneFromEdit);
  ok('设置页文案说人话（无「长尾/点击前停留/毫秒」等内部术语）', rEdit.setPlainCopy);
  ok('编辑区：没选岗位显示引导空态 / 选了岗位显示表格', rEdit.editEmptyOn || rEdit.editHasRows, rEdit.editEmptyOn ? '空态' : `表格 ${rEdit.editHasRows} 行`);
  ok('页5 发送：方式（放到输入框/直接发送）+ 发送按钮 + 指标，无编辑表格无记录', rSend.sendHas, rSend.modeLabels);
  ok('页6 记录：独立整页列表，无方式/发送按钮', rRec.recHas);
  ok('步骤编号 1,2,3,4,5,6', rDir.steps === '1,2,3,4,5,6', rDir.steps);
  ok('省份下拉 = BOSS 全量省份（>20 省）', rDir.provOptions > 20, `${rDir.provOptions} 省`);
  ok('城市下拉 = 省联动（未选省仅占位 ≤2 项 / 已选省 ≥5 城；联动由下一行选杭州验证）', rDir.cityOptions <= 2 || rDir.cityOptions >= 5, `${rDir.cityOptions} 城`);
  ok('「自定义城市」已移除', rDir.cityCustomGone);
  ok('投递方向最多一个（搜索一次只爬一个）', rDir.kwCount <= 1, `${rDir.kwCount} 个`);
  ok('城市切换（选杭州）生效，CITY 可更新', citySwap === '杭州', String(citySwap));
  ok('筛选条件记忆：刷新后保留（localStorage）', memo.sal === '150', `sal=${memo.sal}`);
  ok('知识库页含 我是谁/经历/技能 字段', rKb.kbHas);
  ok('运行日志：容器在但已隐藏', rDir.logHidden);
  ok('一屏 1440（六个工作台页都不出页面滚动）',
    [rDir, rFetch, rFilter, rEdit, rSend, rRec].every(r => r.docH <= r.viewH + 2),
    `dir=${rDir.docH} fetch=${rFetch.docH} filter=${rFilter.docH} edit=${rEdit.docH} send=${rSend.docH} rec=${rRec.docH} / ${rRec.viewH}px`);
  ok('一屏 1920（二次筛选）', rWide.docH <= rWide.viewH + 2, `${rWide.docH}/${rWide.viewH}px`);
  ok('七个页面卡片同宽（同一视口）',
    [rDir.cardW, rFetch.cardW, rFilter.cardW, rEdit.cardW, rSend.cardW, rRec.cardW, rKb.kbCardW]
      .every(w => Math.abs(w - rDir.cardW) <= 2 && w > 0),
    `dir=${rDir.cardW} fetch=${rFetch.cardW} filter=${rFilter.cardW} edit=${rEdit.cardW} send=${rSend.cardW} rec=${rRec.cardW} kb=${rKb.kbCardW}`);
  ok('投递方向行：输入框紧跟 chips（无大空档）', rDir.gapKw >= 0 && rDir.gapKw < 80, `gap=${rDir.gapKw}px`);
  ok('可见文案无 em-dash',
    [rDir, rFetch, rFilter, rEdit, rKb, rWide].every(r => r.emDash === 0),
    `dir=${rDir.emDash} kb=${rKb.emDash} wide=${rWide.emDash}`);
  out.push(`INFO  表格行数：筛选页=${rFilter.rowCount} · 获取页=${rFetch.fetchCount} | 截图 logs/ui-shot-*.png`);
  console.log(out.join('\n'));
  process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.log('测试异常: ' + e.message); process.exit(1); });
