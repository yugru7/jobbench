// 由 index.html 拆出（split-ui.js 自动生成）
// 经典脚本 + defer：三个文件共享全局作用域，加载顺序即 core → render → actions

// ========== 渲染与状态应用 ==========
async function boot() {
  // 量 header 占位（高度 + 下边距）→ #mainWrap 定高用（别把高度写死在 CSS 里）
  const hd = document.querySelector('header');
  document.documentElement.style.setProperty('--hd',
    Math.ceil(hd.getBoundingClientRect().height + (parseFloat(getComputedStyle(hd).marginBottom) || 0)) + 'px');
  // 纯 header 高度（不含下边距）→ sticky 页签定位用（--hd 含 14px 边距会留缝露内容）
  document.documentElement.style.setProperty('--hdr', Math.ceil(hd.getBoundingClientRect().height) + 'px');
  // 唯一「致命」的一步：bootstrap 拿不到 = 服务没起来（或面板被双击打开），
  // 这时界面确实没数据可用 → 打标记，交给上层显示整页引导卡片。
  // 其余初始化步骤出错都只在标题后红字提示，不整页崩。
  try {
    BOOT = await api('/api/bootstrap');
  } catch (e) {
    e.__bootFailed = true;
    throw e;
  }
  const cfg = BOOT.config || {};   // 防御：字段异常不让整页崩
  // 岗位初筛筛选 chips 的数据源与已选值（filters 缺失时 FILTERS_DATA=null，前端降级）
  FILTERS_DATA = BOOT.filters || null;
  SOURCE_FILTERS = JSON.parse(JSON.stringify(cfg.sourceFilters || {}));

  SELECTED = new Set(cfg.keywords || []);
  // 搜索模式一次只爬一个方向：老配置里存了多个的，只留第一个（写回配置）
  if (SELECTED.size > 1) {
    const keep = SELECTED.values().next().value;
    SELECTED = new Set([keep]);
    fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: [...SELECTED] }) });
    toast(`搜索一次只爬一个方向，只保留了「${keep}」`);
  }
  renderKeywords();
  // 单次爬取上限（设置页可调，硬顶 30）：输入框的 max/value 跟随设置
  const mjCap = Math.min(Math.max(parseInt(cfg.maxJobsPerRun, 10) || 10, 1), 30);
  $('maxJobs').max = mjCap;
  $('maxJobs').value = mjCap;
  refreshQuota();   // 记录页统计（爬取/发送/放入输入框）
  loadSettings();   // 设置页表单（actions.js；异步拉 /api/config）

  // 城市选择：省份 → 城市 两级（BOOT.cities.provinces 来自 cities.json，34 省 / 373 城）
  const cd = (BOOT.cities && !Array.isArray(BOOT.cities)) ? BOOT.cities : { hot: BOOT.cities || [], provinces: [] };
  const provs = cd.provinces || [];
  const provSel = $('provSel'), sel = $('citySel');
  provs.forEach(p => {
    const o = document.createElement('option'); o.value = String(p.code); o.textContent = p.name;
    provSel.appendChild(o);
  });
  // 配置里存的城市在哪个省，就默认选哪个省（找不到退第一个省）
  let curProv = provs.find(p => p.cities.some(c => String(c.code) === String(cfg.cityCode)))
    || provs.find(p => p.cities.some(c => c.name === cfg.cityName))
    || provs[0] || { code: '', name: '', cities: [] };
  if (curProv.code) provSel.value = String(curProv.code);
  const fillCities = (prov) => {
    sel.innerHTML = '';
    (prov.cities || []).forEach(c => {
      const o = document.createElement('option'); o.value = String(c.code); o.textContent = c.name;
      sel.appendChild(o);
    });
  };
  fillCities(curProv);
  CITY = { name: cfg.cityName, code: cfg.cityCode };
  // 配置里的城市不在当前省的列表里 → 补一个兜底选项，保证 value 能对上
  if (cfg.cityCode && !curProv.cities.some(c => String(c.code) === String(cfg.cityCode))) {
    const o = document.createElement('option'); o.value = String(cfg.cityCode);
    o.textContent = cfg.cityName || '未在列表'; sel.appendChild(o);
  }
  if (cfg.cityCode) sel.value = String(cfg.cityCode);
  // 城市持久化：以前只存内存，刷新/重启就丢回 config 旧值 ——
  // 用户选了北京却爬出上海岗（config 里还是旧城市）。选择即落 config，
  // collect 的 --city-code、boot 恢复、命令行默认全用同一份
  const saveCity = () => {
    fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cityCode: CITY.code, cityName: CITY.name }) }).catch(() => {});
  };
  provSel.onchange = () => {
    curProv = provs.find(x => String(x.code) === String(provSel.value)) || { cities: [] };
    fillCities(curProv);
    const c0 = curProv.cities[0];
    if (c0) { sel.value = String(c0.code); CITY = { name: c0.name, code: String(c0.code) }; }
    saveCity();
    renderFilterNav();   // 换省 → 区县变了，「工作区域」选项要跟着刷新
  };
  sel.onchange = () => {
    const c = (curProv.cities || []).find(x => String(x.code) === String(sel.value));
    if (c) CITY = { name: c.name, code: String(c.code) };
    saveCity();
    renderFilterNav();   // 换市 → 区县变了
  };

  // 经验档位（初筛页里的多选 chips，见 FILTER_GROUPS）：把 config 回填进 EXP_CODES
  EXP_CODES = String(cfg.experience || '').split(',').map(s => s.trim()).filter(Boolean);

  // 「多来源共有」的筛选项（求职类型/学历/规模/融资）全局一份：
  // 以「面板进入时选中的来源」的现有值为准，统一写进 search/recommend/expect —— 这样切来源时它不变。
  // 只在真有来源之间不一致时才写回配置（避免无谓改动）。
  {
    const remembered = uiPrefs().source;
    const baseSrc = FILTER_SOURCES.includes(remembered) ? remembered : 'search';
    let changed = false;
    for (const g of FILTER_GROUPS) {
      if (!isSharedGroup(g)) continue;
      const v = (SOURCE_FILTERS[baseSrc] || {})[g.key] || '';
      for (const s of FILTER_SOURCES) {
        SOURCE_FILTERS[s] = SOURCE_FILTERS[s] || {};
        if ((SOURCE_FILTERS[s][g.key] || '') !== v) { SOURCE_FILTERS[s][g.key] = v; changed = true; }
      }
    }
    if (changed) saveSourceFilters();   // actions.js 里的写回函数（同一全局作用域）
  }

  restoreFilters();   // 筛选条件记忆：恢复上次的选择（要在首次 renderRows 之前）

  // 界面习惯记忆（刷新 / 重启后保持当前状态）——
  // 恢复来源 / 发送方式 / 意向方向。意向方向直接用记住的方向列表渲染，
  // 不在这里真读 BOSS（否则页面一开就弹浏览器，太打扰）。
  const ui = uiPrefs();
  if (['fillOnly', 'confirm', 'auto'].includes(ui.sendMode)) pickMode(ui.sendMode);
  if (['search', 'recommend', 'expect', 'fav'].includes(ui.source)) {
    $('collectSource').value = ui.source;
    EXPECT_TABS = Array.isArray(ui.expectTabs) ? ui.expectTabs : [];
    EXPECT_PICKED = ui.expectTab || '';
    applySource(ui.source, false);
    if (ui.source === 'expect') renderExpectChips(EXPECT_TABS);
  }
  // 来源 chip 导航栏 + 筛选 chips（没记住来源时也照默认 search 渲染出来）
  renderSourceNav();
  renderFilterNav();

  renderKnowledge(BOOT.knowledge || {});

  // 恢复候选池（合并式：历史批次累积；sent 标记持久化，发过的不会变回可勾选）
  if (BOOT.lastCollect && Array.isArray(BOOT.lastCollect.jobs) && BOOT.lastCollect.jobs.length) {
    CANDS = BOOT.lastCollect.jobs.map(j => ({ ...j, sent: !!j.sent, dupContact: !!j.dupContact }));
    restoreChecked();
    renderRows(); renderFetchRows(); renderEditRows();
    pushLog('·', `已恢复候选池：${CANDS.length} 个岗位（${BOOT.lastCollect.at || ''}）`, '');
  }
  applyState(BOOT.state || {});
}

// 启动过程中的非致命异常提示：
// 在标题后显示红字胶囊，而不是把整页替换成「连不上本地服务」错误卡片 ——
// 服务明明是通的、数据也在，只是某一步初始化出错，页面主体应该照常可用。
// 文案长了胶囊里省略号，悬停（title）看全文；同时打 console 便于排查。
function noteBootProblem(msg) {
  try {
    const el = $('hdrError');
    if (el) {
      el.textContent = '启动异常：' + msg;
      el.title = '启动异常：' + msg;
      el.style.display = '';
    }
  } catch (_) {}
  try { console.error('[启动异常]', msg); } catch (_) {}
}

// ---------- 关键词 ----------
function renderKeywords() {
  const box = $('kwChips');
  box.innerHTML = '';
  if (!SELECTED.size) { box.innerHTML = '<span class="mini">还没有方向，右边加一个</span>'; return; }
  for (const kw of SELECTED) {
    const el = document.createElement('span');
    el.className = 'chip on';
    el.innerHTML = esc(kw) + '<span class="x" title="删除">×</span>';
    el.onclick = (e) => {
      if (!e.target.classList.contains('x')) return;
      SELECTED.delete(kw);
      fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: [...SELECTED] }) });
      renderKeywords();
    };
    box.appendChild(el);
  }
}
function addKeyword() {
  const v = $('kwNew').value.trim();
  if (!v) return;
  const had = SELECTED.size > 0;   // 搜索模式一次只爬一个方向：再加一个 = 替换掉现有的
  SELECTED.clear();
  SELECTED.add(v); $('kwNew').value = '';
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords: [...SELECTED] }) });
  renderKeywords();
  toast(had ? `已替换为「${v}」（搜索一次只爬一个方向）` : `已添加「${v}」`);
}
// ---------- 候选表 ----------
// BOSS 对薪资数字做了字体混淆，抓出来常是 "000-000元/天" 这种假数字
function salaryText(s) {
  if (!s) return '-';
  const digits = (s.match(/\d/g) || []).join('');
  if (!digits || /^0+$/.test(digits)) return '-';   // 数字全是 0 = 被混淆了
  return s;
}
// 二筛「活跃度」：**互斥档** —— 选哪档就只看那一档，各档之间**不包含**。
// 唯一例外：「今日活跃」与「在线」合成一档（招聘者此刻在线 ≈ 今日活跃，语义最近）。
// BOSS 的活跃度文案多变，所以每档是「一类词条」而非单个字符串，按时间跨度归类：
//   今日活跃 = 在线 / 刚刚活跃 / 今日活跃
//   3日内    = 1~3 日内
//   本周     = 本周活跃 / 1 周内 / 4~7 日内（4~7 日 ≈ 一周）
//   半年内   = 2 周及以上周内 / 8 日及以上日内 / 本月 / N月内 / 近期 / 近半年 / 半年内 / 半年前
// 没被任何档覆盖的文案（如「一周内活跃」）不落档，只在「不限」下出现 —— 这是互斥档的必然代价。
// 数字档用 (?<!\d) 防止把「13日内活跃」的「3日内」误匹配进来。
const ACTIVE_TIERS = {
  today: /在线|刚刚活跃|今日活跃/,
  d3: /(?<!\d)[1-3]\s*[日天]内活跃/,
  week: /本周活跃|(?<!\d)1\s*周内活跃|(?<!\d)[4-7]\s*[日天]内活跃/,
  halfyear: /(?<!\d)(?:[2-9]|\d{2,})\s*周内活跃|(?<!\d)(?:[89]|\d{2,})\s*[日天]内活跃|本月活跃|(?<!\d)\d+\s*个?月内活跃|近期活跃|近半年活跃|半年内活跃|半年前活跃/,
};
// 表格里的活跃度配色：与上面的档位**同源**，避免出现「显示成灰、筛选却算另一档」这种自相矛盾。
function actClass(a) {
  if (!a) return ['cold', '未显示'];                       // 没抓到活跃度
  if (ACTIVE_TIERS.today.test(a)) return ['hot', a];        // 在线 / 刚刚 / 今日
  if (ACTIVE_TIERS.d3.test(a)) return ['mid', a];           // 1~3 日内
  if (ACTIVE_TIERS.week.test(a)) return ['mid', a];         // 本周 / 1 周内
  return ['cold', a];                                       // 半年内档，以及认不出的文案（照原文显示）
}
// ---- 二次筛选：从候选里挑出真正想投的 ----
// 薪资文本 → 折算日薪（元/天）。支持 150-200元/天、5-8K、8千-1.2万 这类格式；
// 解析不出来返回 0（筛选时不受影响）
function salaryDaily(s) {
  if (!s) return 0;
  if (/天|日/.test(s)) {
    const m = s.match(/(\d+(?:\.\d+)?)(?:\s*[-–~·]\s*(\d+(?:\.\d+)?))?/);
    if (!m) return 0;
    const lo = parseFloat(m[1]), hi = m[2] ? parseFloat(m[2]) : lo;
    return (lo + hi) / 2;
  }
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)(\s*(千|万|K|k))?/g)].slice(0, 2);
  if (!nums.length) return 0;
  const toM = (v, u) => (u === '万' ? v * 10000 : (u ? v * 1000 : (v < 100 ? v * 1000 : v)));
  const vals = nums.map(n => toM(parseFloat(n[1]), (n[2] || '').trim()));
  return vals.reduce((a, b) => a + b, 0) / vals.length / 22;   // 月薪折日薪
}

// 不在表里展示的岗位：
//   sent        已发送（三个视图都 hide）
//   dupContact  该 HR 已在沟通（同 HR 的另一个岗位聊过了）—— 招呼语不再重复发，hide
function jobHidden(j) {
  return !!j.sent || !!j.dupContact;
}

function visibleCands() {
  const act = $('fActive').value;
  const salMin = parseFloat(($('fSal') && $('fSal').value) || '') || 0;
  const ind = $('fInd') ? $('fInd').value.trim() : '';
  const week = $('fWeek') ? $('fWeek').value : '';

  // 注：不再按「实习/全职」分 —— 关键词判定会把
  // 「实习生勿投 / 不招实习生」这类否定句也算成实习，不可靠，交给人自己看。
  let list = CANDS.map((j, i) => ({ j, i }));
  // 已发送的直接不进二筛/编辑视图（大概率爬不到了，留着纯噪音）；
  // 「已在沟通」（该 HR 的另一个岗位已经聊过）同理 —— 不会再重复发，留着也是噪音
  list = list.filter(x => !jobHidden(x.j));
  // 活跃度：互斥档（在线与今日活跃合成一档，其余各档互不包含）
  if (ACTIVE_TIERS[act]) list = list.filter(x => ACTIVE_TIERS[act].test(x.j.active || ''));

  // 日薪下限：工资文本解析出来的才比，没解析出来的不受影响
  if (salMin > 0) list = list.filter(x => { const d = salaryDaily(x.j.salary); return d === 0 || d >= salMin; });
  if (ind) list = list.filter(x => (x.j.industry || '').includes(ind));
  // 双休（按「每周至少休 2 天」分）：
  //   1~5 天/周 → 有双休（每周休 ≥2 天）；6~7 天/周 → 无双休（单休及以下）
  //   没爬到该信息（0）的岗位只在「不限」下出现
  if (week === 'yes') list = list.filter(x => x.j.daysPerWeek > 0 && x.j.daysPerWeek <= 5);
  else if (week === 'no') list = list.filter(x => x.j.daysPerWeek >= 6);

  return list;
}

// ========== 筛选条件记忆（要求：刷新/重开不丢） ==========
// renderRows() 是所有筛选控件 onchange/oninput 的统一入口，在这里顺手保存最省事；
// boot() 里恢复。控件是静态 HTML，恢复后首个 renderRows 即按恢复值过滤。
const FILTER_KEY = 'boss-filters';
const FILTER_IDS = ['fActive', 'fWeek', 'fSal', 'fInd'];
function saveFilters() {
  try {
    const v = {};
    FILTER_IDS.forEach(id => { const el = $(id); if (el) v[id] = el.value; });
    localStorage.setItem(FILTER_KEY, JSON.stringify(v));
  } catch (_) {}
}
function restoreFilters() {
  try {
    const v = JSON.parse(localStorage.getItem(FILTER_KEY) || '{}');
    FILTER_IDS.forEach(id => { const el = $(id); if (el && v[id] != null) el.value = v[id]; });
  } catch (_) {}
}
// ========== 表格列定义 ==========
// 增删列只改这个数组：表头、每行内容、列宽全部自动跟着变。
//   key   取值字段名；w = grid 列宽；kind = check/text/salary/active
const COLS = [
  { key: 'check',    label: '',      w: '36px',                 kind: 'check' },
  { key: 'idx',      label: '#',     w: '40px',                 kind: 'idx' },
  { key: 'job',      label: '岗位',   w: 'minmax(110px,1.1fr)',  kind: 'text', cls: 'ell jobname', tip: true },
  { key: 'company',  label: '公司',   w: 'minmax(80px,0.9fr)',   kind: 'text', cls: 'ell', tip: true },
  { key: 'area',     label: '地点',   w: 'minmax(76px,0.5fr)',   kind: 'text', cls: 'ell mini' },
  { key: 'salary',   label: '薪资',   w: '132px',                kind: 'salary' },
  { key: 'active',   label: '活跃度', w: '100px',                kind: 'active' },
  { key: 'jd',       label: 'JD 摘要', w: 'minmax(150px,1.4fr)', kind: 'jd' },
];
// 获取岗位页的全量表：和二次筛选页同一份列定义（含勾选框）—— 这页
// 也能勾选（单选 / 多选 / 表头全选），勾完可批量删除不要的岗位（勾选状态与二筛各自独立）
const FETCH_COLS = COLS;

// checkHTML：勾选列表头那一格渲染成什么 —— 两页各有各的「全选」框，所以由调用方给
function renderHeadInto(headEl, wrapEl, cols, checkHTML) {
  headEl.innerHTML = cols.map((c) => (c.kind === 'check'
    ? (checkHTML || '<div></div>')
    : `<div>${esc(c.label)}</div>`)).join('');
  wrapEl.style.setProperty('--tcols', cols.map((c) => c.w).join(' '));
}
function renderHead() {
  renderHeadInto($('thead'), $('tableWrap'), COLS,
    '<div><input type="checkbox" id="ckAll" onchange="toggleAll(this.checked)"></div>');
}

function renderRows() {
  saveFilters();                                     // 筛选条件记忆：一变就存
  if (!$('thead').childElementCount) renderHead();   // 表头空就建一次（不会重置勾选）
  const box = $('rows');
  box.innerHTML = '';
  const list = visibleCands();
  $('tableWrap').style.display = CANDS.length ? '' : 'none';
  $('tableEmpty').style.display = CANDS.length ? 'none' : '';
  $('mCand').textContent = CHECKED.size;   // 发送页指标 = 二筛勾选的数量

  const fi = $('filterInfo');
  if (fi) fi.textContent = CANDS.length ? `筛出 ${list.length} / ${CANDS.length} 个` : '';

  // 序号用「显示顺序」而不是池子里的原始下标 —— 已发送的岗位会被过滤掉，
  // 用原始下标会让序号断号（前 15 个发过 → 剩下的从 16 起跳）。
  list.forEach(({ j }, n) => {
    const d = document.createElement('div');
    d.className = 'trow' + (j.sent ? ' sent' : '');
    d.innerHTML = COLS.map((c) => (c.kind === 'check'
      ? `<div><input type="checkbox" ${CHECKED.has(j.url) ? 'checked' : ''} ${j.sent ? 'disabled' : ''}
           onchange="toggleOne('${attr(j.url)}', this.checked)"></div>`
      : c.kind === 'idx'
      ? `<div class="idx">${n + 1}</div>`
      : cellHTML(c, j))).join('');
    box.appendChild(d);
  });
  updateSelInfo();
}

// 单元格渲染（获取页 / 筛选页两张表共用；招呼语在「编辑发送」页单独渲染）
function cellHTML(c, j) {
  if (c.kind === 'salary') return `<div class="money">${esc(salaryText(j.salary))}</div>`;
  if (c.kind === 'active') {
    const [ac, at] = actClass(j.active);
    return `<div><span class="act ${ac}">${esc(at)}</span></div>`;
  }
  if (c.key === 'area') {
    // 悬浮显示详情页抓到的详细地址（老数据没有 addr 就退回区域）
    const tip = attr(j.addr || j.area || '');
    return `<div class="${c.cls || ''}" title="${tip}">${esc(j.area || '-')}</div>`;
  }
  if (c.kind === 'jd') {
    const t = String(j.jd || '').replace(/\s+/g, ' ').trim();
    return `<div class="jdcell" title="${attr(j.jd || '')}">${t ? esc(t.slice(0, 100)) : '-'}</div>`;
  }
  const v = j[c.key] || '-';
  const tip = c.tip ? ` title="${attr(v)}"` : '';
  // 收藏来源的岗位在岗位名前加「★」（获取岗位页 / 二次筛选页两张表都走这里）
  const star = (c.key === 'job' && j.src === 'fav') ? '★ ' : '';
  return `<div class="${c.cls || ''}"${tip}>${star}${esc(v)}</div>`;
}

// 获取岗位页：池子表（已发送的也不再显示——发了的大概率爬不到了）
function renderFetchRows() {
  if (!$('fetchHead').childElementCount) {
    renderHeadInto($('fetchHead'), $('fetchWrap'), FETCH_COLS,
      '<div><input type="checkbox" id="ckAllFetch" onchange="fetchToggleAll(this.checked)"></div>');
  }
  const box = $('fetchRows');
  box.innerHTML = '';
  const list = CANDS.filter(j => !jobHidden(j));
  // 勾选集跟着当前列表收敛：已删掉 / 已发送的 url 不该继续占着计数
  FETCH_SEL = new Set([...FETCH_SEL].filter(u => list.some(j => j.url === u)));
  $('fetchWrap').style.display = list.length ? '' : 'none';
  $('fetchEmpty').style.display = list.length ? 'none' : '';
  // 空态区分：池子真空 vs 全都发过了
  $('fetchEmpty').textContent = CANDS.length ? '池子里的都已发送，去 BOSS 换个方向爬新岗位吧' : '还没有爬过岗位';
  $('fetchInfo').textContent = list.length ? `已获取 ${list.length} 个` : '';
  $('goFilter').style.display = list.length ? '' : 'none';
  // 勾了才出「删除选中」，并带上个数（没勾就不占地方）
  const del = $('goDel');
  del.style.display = FETCH_SEL.size ? '' : 'none';
  del.textContent = `删除选中的 ${FETCH_SEL.size} 个`;
  list.forEach((j, i) => {
    const d = document.createElement('div');
    d.className = 'trow';
    d.innerHTML = FETCH_COLS.map((c) => (c.kind === 'check'
      ? `<div><input type="checkbox" ${FETCH_SEL.has(j.url) ? 'checked' : ''}
           onchange="fetchToggleOne('${attr(j.url)}', this.checked)"></div>`
      : c.kind === 'idx'
      ? `<div class="idx">${i + 1}</div>`
      : cellHTML(c, j))).join('');
    box.appendChild(d);
  });
  // 表头全选框跟着实际勾选情况走（整列勾满 = 显示选中）
  const all = $('ckAllFetch');
  if (all) all.checked = list.length > 0 && FETCH_SEL.size === list.length;
}

// 编辑招呼语页：勾选的岗位表格化（岗位/公司/JD摘要/招呼语）—— 纯编辑，不碰发送
// （招呼语来自 collect 时的 AI 生成 / agent 经 /api/greetings 写回，这里逐条可改）
const EDIT_COLS = [
  { key: 'job',     label: '岗位',     w: 'minmax(110px,1fr)' },
  { key: 'company', label: '公司',     w: 'minmax(80px,0.8fr)' },
  { key: 'jd',      label: 'JD摘要',   w: 'minmax(150px,1.1fr)' },
  { key: 'greet',   label: '招呼语（AI 生成后可改）', w: 'minmax(280px,1.7fr)' },
];
function renderEditRows() {
  const list = CANDS.map((j, i) => ({ j, i })).filter((x) => CHECKED.has(x.j.url));
  const wrap = $('editWrap'), box = $('editRows'), head = $('editHead');
  if (list.length && !head.childElementCount) {
    head.innerHTML = EDIT_COLS.map((c) => `<div>${esc(c.label)}</div>`).join('');
    wrap.style.setProperty('--tcols', EDIT_COLS.map((c) => c.w).join(' '));
  }
  wrap.style.display = list.length ? '' : 'none';
  box.innerHTML = '';
  $('editEmpty').style.display = list.length ? 'none' : '';
  $('editInfo').textContent = list.length ? `勾选 ${list.length} 个` : '';
  $('goSend').style.display = list.length ? '' : 'none';
  list.forEach(({ j, i }) => {
    const d = document.createElement('div');
    d.className = 'trow etrow';
    d.dataset.url = j.url;   // 招呼语更新时按 url 原地改这一格，不整表重渲染（否则正在打的字会丢焦点）
    d.innerHTML = `
      <div class="ell jobname" title="${attr(j.job)}">${j.src === 'fav' ? '★ ' : ''}${esc(j.job)}</div>
      <div class="ell" title="${attr(j.company)}">${esc(j.company || '-')}</div>
      <div class="jdcell" title="${attr(j.jd || '')}">${j.jd ? esc(String(j.jd).replace(/\s+/g, ' ').slice(0, 100)) : '-'}</div>
      <div class="gcell"><textarea rows="2" placeholder="招呼语（会原样发给 HR，改完即存）"
        oninput="editGreeting(${i}, this.value)">${esc(j.greeting || '')}</textarea></div>`;
    box.appendChild(d);
  });
}

function toggleOne(url, on) { on ? CHECKED.add(url) : CHECKED.delete(url); saveChecked(); updateSelInfo(); renderEditRows(); }
function toggleAll(on) {
  if (on) visibleCands().forEach(({ j }) => { if (!jobHidden(j)) CHECKED.add(j.url); });
  else CHECKED.clear();
  saveChecked();
  renderRows(); renderEditRows();
}
// 「获取岗位」页的勾选：独立于二筛的 CHECKED ——
// 这里勾 = 选中要删除的岗位，不该写进 checkedUrls（agent 会把 checked 当成「要写招呼语的岗位」）
function fetchToggleOne(url, on) {
  on ? FETCH_SEL.add(url) : FETCH_SEL.delete(url);
  renderFetchRows();
}
function fetchToggleAll(on) {
  const list = CANDS.filter(j => !jobHidden(j));
  FETCH_SEL = on ? new Set(list.map(j => j.url)) : new Set();
  renderFetchRows();
}
// 勾选持久化（localStorage）：刷新/关闭不丢；恢复时只保留池子里还存在的 url
// 同时同步服务端副本（POST /api/checked）—— agent 靠 GET /api/collected 的
// checked 字段识别「过二筛岗位」，不同步它就看不见你勾了谁
function saveChecked() {
  try { localStorage.setItem('checked-urls', JSON.stringify([...CHECKED])); } catch (_) {}
  fetch('/api/checked', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: [...CHECKED] }) }).catch(() => {});
}
function restoreChecked() {
  // 整体兜底：恢复勾选失败不该拖垮整个面板 ——
  // 曾因服务端 checkedUrls 类型不对（对象而非数组）在这里抛错，
  // 被全局异常处理渲染成「连不上本地服务」全屏错误页（曾踩到，
  // 表现为：界面全崩、读取意向方向后端明明成功却看不到结果）。
  try {
    let fromStorage = null;
    try {
      const arr = JSON.parse(localStorage.getItem('checked-urls') || 'null');
      // 注意：空数组 [] 不算「用户的有效选择」——旧版刷新 bug 会把空数组写进
      // localStorage，若当事实源就会把 agent 勾的覆盖掉（刷新即丢）
      if (Array.isArray(arr) && arr.length) fromStorage = arr;
    } catch (_) {}
    const urls = new Set(CANDS.map(j => j.url));
    if (fromStorage) {
      // 本机 localStorage 有非空勾选 → 用户本机事实源（用户在面板勾的）
      CHECKED = new Set(fromStorage.filter(u => urls.has(u)));
    } else {
      // 没有/空的 → adopt 服务端副本（agent 勾的、新设备、清缓存、旧版误清空）。
      // 必须防非数组：前端不能假设后端一定给数组，非数组一律当空处理。
      const srv = Array.isArray(BOOT && BOOT.checkedUrls) ? BOOT.checkedUrls : [];
      CHECKED = new Set(srv.filter(u => urls.has(u)));
    }
    saveChecked();   // 统一回写两边（localStorage + 服务端），保持同步
  } catch (e) {
    console.warn('恢复勾选失败，已跳过（不影响其他功能）', e);
    CHECKED = new Set();
  }
}

// 「按筛选结果全选」= 把勾选集合**替换**成「当前筛选结果」（满足全部筛选条件的岗位 = 这些条件的交集）。
// 是替换而非累加：之前勾的、不在这次结果里的会被取消 —— 否则「全选」变成"结果 ∪ 旧勾选"，
// 名不副实（旧实现只 add 不清，提示里的 N 也变成了总数）。
function quickPick() {
  CHECKED = new Set(visibleCands().map(({ j }) => j.url));
  saveChecked();
  renderRows(); renderEditRows();
  toast(`已勾选筛选结果里的 ${CHECKED.size} 个`);
}
function clearPick() { CHECKED.clear(); saveChecked(); renderRows(); renderEditRows(); }
function editGreeting(i, v) {
  const j = CANDS[i]; if (!j) return;
  j.greeting = v;
  // 手改自动落盘（防抖 0.9s）：不然刷新/关闭就丢（数据保存的唯一缺口，被问到过）
  _greetDirty[j.url] = v;
  clearTimeout(editGreeting._t);
  editGreeting._t = setTimeout(async () => {
    const items = Object.entries(_greetDirty).map(([url, greeting]) => ({ url, greeting }));
    for (const k of Object.keys(_greetDirty)) delete _greetDirty[k];
    if (!items.length) return;
    try { await api('/api/greetings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }) }); } catch (_) {}
  }, 900);
}
const _greetDirty = {};
function updateSelInfo() {
  $('selInfo').textContent = `已选 ${CHECKED.size} 个`;
  const st = BOOT && BOOT.state ? BOOT.state.status : 'idle';
  const busy = st !== 'idle' && st !== 'error';
  $('btnSend').disabled = CHECKED.size === 0 || busy;
  $('btnSend').textContent = `开始处理选中的 ${CHECKED.size} 个`;
  // 提示语跟勾选状态保持一致，别出现"按钮说选了 1 个、提示说先勾选"的矛盾
  $('sendHint').textContent = busy ? '任务正在跑，等它结束或点「停止」'
    : CHECKED.size === 0 ? '先去「二次筛选」勾选要投的岗位'
    : '选好发送方式，点开始按钮';
}
function pickMode(m) {
  SEND_MODE = m;
  savePref('sendMode', m);   // 记住发送方式（刷新/重启后不变）
  document.querySelectorAll('#modes button').forEach(el => el.classList.toggle('on', el.dataset.mode === m));
}

// ---------- 发送记录 ----------
// 三项统计（爬取 / 发送 / 放入输入框），每项含「总量 + 今日」
function fillRecStats(stats) {
  if (!stats) return;
  const set = (key, name) => {
    const o = stats[key];
    const total = (o && typeof o === 'object') ? o.total : o;
    const today = (o && typeof o === 'object') ? o.today : null;
    $('st' + name).textContent = (total != null) ? total : '-';
    $('st' + name + 'T').textContent = (typeof today === 'number') ? today : '-';
  };
  set('collected', 'Collected');
  set('sent', 'Sent');
  set('filled', 'Filled');
  set('offline', 'Offline');
}
async function renderRecords() {
  try {
    const r = await api('/api/records');
    fillRecStats(r.stats);
    const box = $('records');
    if (!r.lines || !r.lines.length) { box.innerHTML = '<div class="rnone">还没有</div>'; return; }
    box.innerHTML = r.lines.map(l => {
      const p = l.split('|').map(s => s.trim());
      // 新格式 4 段：时间 | 岗位 | 公司 | 状态；旧格式 3 段（无公司）兼容
      const status = p[p.length - 1] || '';
      const company = p.length >= 4 ? (p[2] || '') : '';
      const job = p[1] || '';
      const stCls = /已发送/.test(status) ? 'st-sent' : /已填入/.test(status) ? 'st-fill' : /已下架/.test(status) ? 'st-offline' : '';
      return `<div class="recline">
        <span class="rtime">${esc(p[0] || '')}</span>
        <span class="rjob" title="${attr(job)}">${esc(job)}</span>
        <span class="rcompany" title="${attr(company)}">${esc(company || '-')}</span>
        <span class="rstate ${stCls}" title="${attr(status)}">${esc(status || '-')}</span></div>`;
    }).join('');
  } catch (_) {}
}

// ---------- 浏览器开关 ----------
function showBrowserUI(on) {
  $('btnCloseBrowser').style.display = on ? '' : 'none';
  $('btnOpenBrowser').style.display = on ? 'none' : '';
}
// 「打开 BOSS」：用任务同款浏览器（同一 profile / 登录态）开一个 BOSS 窗口给你自己用，
// 不跑任何爬取/发送。子进程 spawn 完就返回、真正打开是异步的 ——
// 收尾会广播 browser-kept，届时按钮状态自动切到「关闭 BOSS」。
async function openBrowser() {
  const r = await api('/api/open-browser', { method: 'POST' });
  if (!r.ok) { toast(r.error || '打开失败，再试一次'); return; }
  toast(r.reused ? '浏览器已经开着（任务正在用它）' : '正在打开 BOSS…');
  showBrowserUI(true);
}
async function closeBrowser() {
  const r = await api('/api/close-browser', { method: 'POST' });
  if (r.ok) { toast('BOSS 已关闭'); showBrowserUI(false); }
  else toast('关闭失败，再试一次');
}

// ---------- 状态 ----------
let LAST_STATUS = 'idle';   // 安全验证提示结束后要还原成「运行中/空闲」
let SAFE_ON = false;
const STATUS_MAP = { idle: ['空闲', ''], running: ['运行中', 'run'], paused: ['已暂停', 'pause'],
                     stopping: ['正在停止…', 'pause'], error: ['出错了', 'err'] };
function renderStatusBadge() {
  const el = $('statusBadge');
  if (!el) return;
  if (SAFE_ON) {
    // 安全验证不占布局：只在页头状态徽标上提示（原来那条黄色横条会把整页往下挤）
    el.textContent = '需验证';
    el.className = 'badge pause';
    el.title = 'BOSS 弹了安全验证，请在浏览器窗口里手动完成（滑块拖到最右或按提示点选，最多等 5 分钟，完成后自动继续）';
    return;
  }
  const [t, c] = STATUS_MAP[LAST_STATUS] || STATUS_MAP.idle;
  el.textContent = t;
  el.className = 'badge ' + c;
  el.title = '';
}
function applyState(s) {
  LAST_STATUS = s.status || 'idle';
  renderStatusBadge();
  // 刷新后按钮状态要跟服务端实际的开/关对齐 —— browser-kept/closed 事件只在实时切换时推送，
  // 刷新不会重放，所以这里按 bootstrap/state 里的 browserOpen 兜底（未带该字段的局部 state 事件跳过）
  if (s.browserOpen !== undefined) showBrowserUI(s.browserOpen);

  const busy = s.status !== 'idle' && s.status !== 'error';
  $('btnCollect').disabled = busy;
  $('btnStop').disabled = !busy;
  // 「停止」按钮编排（不要暂停/继续，只保留停止）：
  //   运行/暂停/停止中 → 显示「停止」
  //   空闲/出错 → 隐藏「停止」（只在任务运行时出现）
  // 点了停止 = 直接终止脚本，没爬完的不爬、没发完的不发。
  const stopVisible = s.status === 'running' || s.status === 'paused' || s.status === 'stopping';
  $('btnStop').style.display = stopVisible ? '' : 'none';
  $('btnStop').disabled = !(s.status === 'running' || s.status === 'paused');
  // 任务结束/出错后，"正在搜索岗位…"这类阶段提示不能残留
  if (!busy && s.status !== 'running' && s.status !== 'paused' && s.status !== 'stopping') {
    $('collectHint').textContent = '';
  }

  if (s.sendProgress) {
    $('mFilled').textContent = s.sendProgress.filled || 0;
    $('mSent').textContent = s.sendProgress.sent || 0;
    $('mSkip').textContent = (s.sendProgress.skipped || 0) + (s.sendProgress.failed || 0);
  }
  if (s.awaiting) showAwait(s.awaiting); else hideAwait();
  updateSelInfo();
}
function showAwait(a) {
  $('awaitBox').classList.add('on');
  $('awaitHead').textContent = `招呼语已填进输入框，请在浏览器里点发送：${a.job}${a.company ? ' @ ' + a.company : ''}`;
  $('awaitText').textContent = a.greeting || '';
  // 只填不发模式：界面不提供发送按钮，主动权完全在你手里
}
function hideAwait() { $('awaitBox').classList.remove('on'); }
function showLogin(on) { $('loginBox').style.display = on ? 'block' : 'none'; }
function showSafe(on) { SAFE_ON = !!on; renderStatusBadge(); }

// ---------- 日志 ----------
function pushLog(tag, msg, ts) {
  const box = $('logBox');
  const d = document.createElement('div');
  d.innerHTML = `<span class="ts">${esc(ts || '')}</span><span class="${tag ? 't-' + tag : ''}">${esc(msg)}</span>`;
  box.appendChild(d);
  while (box.childElementCount > 700) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// ---------- 意向方向 chips（来源「意向页签」第一步读回来的）----------
// 单选：点一个选中，再点取消；选中后「爬意向页签」只爬这个方向
// tabs === null 表示读取中；[] 表示失败（真实错误经 renderExpectError 写入）
function renderExpectChips(tabs) {
  EXPECT_TABS = tabs || [];
  const box = $('expectChips');
  if (tabs === null) { box.innerHTML = '<span class="mini">正在读取你在 BOSS 勾选的方向（要开浏览器，约半分钟）…</span>'; return; }
  box.innerHTML = '';
  if (!EXPECT_TABS.length) {
    box.innerHTML = '<span class="mini">没读到方向，点右边 <a href="javascript:loadExpects()" style="text-decoration:underline">重新读取</a>；失败原因会显示在这里</span>';
    return;
  }
  for (const t of EXPECT_TABS) {
    const el = document.createElement('span');
    el.className = 'chip' + (EXPECT_PICKED === t ? ' on' : '');
    el.textContent = t;
    el.onclick = () => {
      EXPECT_PICKED = (EXPECT_PICKED === t) ? '' : t;
      savePref('expectTab', EXPECT_PICKED);   // 记住挑中的意向方向
      renderExpectChips(EXPECT_TABS);
    };
    box.appendChild(el);
  }
}

// 读方向失败时把真实原因亮在 chips 区（error 事件以前只进日志区，用户根本看不到）
function renderExpectError(msg) {
  if ($('collectSource').value !== 'expect') return;
  const box = $('expectChips');
  box.innerHTML = `<span class="mini">读取失败：${esc(msg || '未知错误')}，<a href="javascript:loadExpects()" style="text-decoration:underline">重新读取</a></span>`;
}

// ---------- 岗位初筛：来源 chip 导航栏 + 筛选条件 ----------
// 来源四选一（驱动隐藏的 select#collectSource，旧代码照常读它的 value）；
// 筛选条件随来源变，每项各占一行、选项常显，选中的值直接拼进 BOSS 列表页 URL（源头过滤）。
const SOURCE_ITEMS = [
  { v: 'search', label: '搜索' },
  { v: 'recommend', label: '推荐' },
  { v: 'expect', label: '意向岗位' },
  { v: 'fav', label: '收藏' },
];
// 筛选组：key = config.sourceFilters 里的键（就是 BOSS URL 参数名）
//   searchOnly = true → 只有「搜索」来源有；from = 选项来源（options 的分组 / districts 区县表）
// 注：不再有「薪资待遇」—— BOSS 选了「实习」后薪资档位仍是全职的月薪范围，
// 对实习（日薪）没用，整组去掉。
// 经验档位（BOSS experience 参数）：BOSS 上这组本来就是多选 —— 面板做成和
// 「学历/规模/融资」一样的多选 chips，排在「学历要求」下面。选项用下面这张表（filters.json 里没有这组）。
// 注意：它是「全局」设置（存 config.experience），不按来源存 —— 渲染与写回都单独处理
// （见 renderFilterNav 的 from==='experience' 特判、toggleFilterValue 的同名分支）。
const EXPERIENCE_OPTIONS = [
  { code: '108', name: '在校生' },
  { code: '102', name: '应届生' },
  { code: '101', name: '经验不限' },
  { code: '103', name: '1年以内' },
  { code: '104', name: '1-3年' },
  { code: '105', name: '3-5年' },
  { code: '106', name: '5-10年' },
  { code: '107', name: '10年以上' },
];
let EXP_CODES = [];   // 当前选中的经验档位码（来自 config.experience，逗号串拆开）
// 写回 config.experience（逗号串；空串 = 不限）。全局设置，不随来源变。
function saveExperience(v) {
  EXP_CODES = String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ experience: EXP_CODES.join(',') }) }).catch(() => {});
}

const FILTER_GROUPS = [
  { key: 'multiBusinessDistrict', label: '工作区域', searchOnly: true, from: 'districts' },
  // 求职类型：BOSS 里这组互斥（点了全职就不能点实习），故 single=true 走单选
  { key: 'jobType', label: '求职类型', from: 'options', optKey: 'jobType', single: true },
  { key: 'degree', label: '学历要求', from: 'options', optKey: 'degree' },
  { key: 'experience', label: '经验要求', from: 'experience' },   // 全局设置，非 sourceFilters
  { key: 'scale', label: '公司规模', from: 'options', optKey: 'scale' },
  { key: 'stage', label: '融资阶段', from: 'options', optKey: 'stage' },
];
// 有「源头筛选」的三个来源（收藏来源固定 URL、不吃筛选）；多来源共有的项要同步进这三个
const FILTER_SOURCES = ['search', 'recommend', 'expect'];
// 「多来源共有」= 搜索/推荐/意向都有的那一组（工作区域 searchOnly、经验要求另有全局存储 config.experience）
function isSharedGroup(g) { return !!g && !g.searchOnly && g.from !== 'experience'; }
function curSource() { const el = $('collectSource'); return el ? el.value : 'search'; }
// 收藏来源不套任何筛选条件（固定收藏 URL），不显示任何筛选组
function groupsForSource(src) { return src === 'fav' ? [] : FILTER_GROUPS.filter(g => !g.searchOnly || src === 'search'); }
// 某筛选组的可选项 [{code,name}]；拿不到（filters.json 缺失 / 该市没区县）返回 []，前端降级
function optionsOf(g, src) {
  if (g.from === 'experience') return EXPERIENCE_OPTIONS;   // 这张表不依赖 filters.json
  if (!FILTERS_DATA) return [];
  if (g.from === 'districts') return ((FILTERS_DATA.districts || {})[String(CITY.code)]) || [];
  return ((FILTERS_DATA.options || {})[g.optKey]) || [];
}
function pickedCodes(src, key) {
  const v = (SOURCE_FILTERS[src] || {})[key] || '';
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function renderSourceNav() {
  const box = $('sourceChips');
  if (!box) return;
  const cur = curSource();
  box.innerHTML = '';
  for (const it of SOURCE_ITEMS) {
    const el = document.createElement('span');
    el.className = 'chip' + (cur === it.v ? ' on' : '');
    el.textContent = it.label;
    el.onclick = () => pickSource(it.v);
    box.appendChild(el);
  }
}

// 每个筛选项各占一行：「标签 + 全部选项」常显（不再点开）
function renderFilterNav() {
  const box = $('filterBox');
  if (!box) return;
  const src = curSource();
  box.innerHTML = '';
  for (const g of groupsForSource(src)) {
    const list = optionsOf(g, src);
    const sel = g.from === 'experience' ? EXP_CODES.slice() : pickedCodes(src, g.key);
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'margin-bottom:8px; align-items:flex-start';
    row.innerHTML = `<label class="fld" style="margin-top:5px">${esc(g.label)}</label>`;
    const chips = document.createElement('div');
    chips.className = 'chips';
    // 「不限」= 清空这一项（对应接口里 code=0 的那个「不限」，统一由这里表示）
    const none = document.createElement('span');
    none.className = 'chip' + (sel.length ? '' : ' on');
    none.textContent = '不限';
    none.onclick = () => toggleFilterValue(g.key, '', true);
    chips.appendChild(none);
    for (const o of list) {
      if (String(o.code) === '0') continue;
      const el = document.createElement('span');
      el.className = 'chip' + (sel.includes(String(o.code)) ? ' on' : '');
      el.textContent = o.name;
      el.onclick = () => toggleFilterValue(g.key, String(o.code));
      chips.appendChild(el);
    }
    if (!list.length) {
      const tip = g.from === 'districts' ? '这个城市没有可选的区县' : '拿不到这一项（可跑 node update-filters.js 刷新）';
      chips.insertAdjacentHTML('beforeend', `<span class="mini">${esc(tip)}</span>`);
    }
    row.appendChild(chips);
    box.appendChild(row);
  }
}

// ---------- SSE ----------
function connect() {
  const es = new EventSource('/api/events');
  let wasDown = false;
  // 断线重连后同步一次状态：SSE 断开期间（服务重启 / 网络抖动）
  // 后端状态可能已经变了，前端不刷新就会一直显示旧状态 —— 按钮可用性错乱
  // （今天的「停止」点不了就是状态陈旧的同类问题：连状态都没收到过）
  es.onopen = () => {
    if (wasDown) {
      api('/api/bootstrap').then((b) => { BOOT = b; applyState(b.state || {}); }).catch(() => {});
    }
    wasDown = false;
  };
  es.onerror = () => { wasDown = true; };
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch (_) { return; }
    handle(ev);
  };
}
function handle(ev) {
  switch (ev.t) {
    case 'run-started':
      pushLog('·', `▶ ${ev.label}`, '');
      break;
    case 'log':
      pushLog(ev.tag, ev.msg, ev.ts);
      break;
    case 'state':
      applyState({ status: ev.status, sendProgress: null, awaiting: null });
      break;
    case 'collect-start':
      // mode:'reread' = 刷新活跃度（不是往池子里加岗位，文案不能说「新增」）
      $('collectHint').textContent = ev.mode === 'reread'
        ? `正在刷新活跃度（共 ${ev.total} 个，只回写活跃度，不新增岗位）…`
        : `正在读取 JD（目标新增 ${ev.total} 个，重复自动补位）…`;
      break;
    case 'expects': {
      savePref('expectTabs', ev.tabs || []);   // 记住方向列表：刷新/重启后秒回，不必再读 BOSS
      // 上次挑中的方向若还在新列表里 → 自动选回（意向方向也要"刷新重启后不变"）
      const saved = uiPrefs().expectTab || '';
      EXPECT_PICKED = (ev.tabs || []).includes(saved) ? saved : '';
      renderExpectChips(ev.tabs);
      $('collectHint').textContent = ev.tabs && ev.tabs.length
        ? (ev.fromCache
          ? `读到 ${ev.tabs.length} 个方向（来自缓存，变动了点「刷新方向」）`
          : `读到 ${ev.tabs.length} 个方向，点选一个再爬`)
        : '没读到方向';
      break;
    }
    case 'collect-progress':
      // skipped：重复岗位跳过（不占新增配额，脚本会自动往后补位）
      $('collectHint').textContent = ev.mode === 'reread'
        ? `[刷新 ${ev.index}/${ev.total}] ${ev.current}`
        : ev.skipped
          ? `已在池子里，跳过：${ev.current}（自动补下一位…）`
          : `[新增 ${ev.index}/${ev.total}] ${ev.current}`;
      break;
    case 'candidate':
      // 合并式池子：已有的岗位跳过（招呼语/勾选/sent 保持原样），只加新的
      if (!CANDS.some(x => x.url === ev.job.url)) CANDS.push({ ...ev.job, sent: false, dupContact: !!ev.job.dupContact });
      renderRows(); renderFetchRows();
      break;
    case 'greeting-update':
      // agent 写回的招呼语 → 编辑区实时刷新。
      // 【踩过的坑】不能整表 renderEditRows()：自己手改招呼语时会触发 0.9 秒防抖保存，
      // 服务端把同一个值广播回来，整表重建会把正在打字的 textarea 换掉 —— 光标丢失、
      // 后面打的字全丢，表现为「打几个字就要重新点一下输入框」。
      // 改成按 url 原地更新这一格；正在编辑（有焦点）的那格直接不动。
      {
        const j = CANDS.find(x => x.url === ev.url);
        if (j) j.greeting = ev.greeting;
        const row = [...$('editRows').children].find(el => el.dataset.url === ev.url);
        const ta = row && row.querySelector('textarea');
        if (ta && document.activeElement !== ta) ta.value = ev.greeting;
      }
      break;
    case 'collect-done':
      // mode:'reread' = 刷新活跃度：没有「新增岗位」这回事，只报读到多少 / 删了多少
      if (ev.mode === 'reread') {
        $('collectHint').textContent = `刷新完成：${ev.got}/${ev.planned} 个读到活跃度`
          + (ev.removed ? `，已下架删除 ${ev.removed} 个` : '')
          + (ev.failed ? `，打不开 ${ev.failed} 个` : '')
          + (ev.stopped ? '（中途停止）' : '');
        toast(`活跃度刷新完成：${ev.got} 个拿到新值${ev.removed ? `，下架删除 ${ev.removed} 个` : ''}`);
        renderRows(); renderFetchRows();
        break;
      }
      $('collectHint').textContent = `筛选完成：${ev.ok}/${ev.total} 个拿到了 JD 和招呼语`
        + (ev.exhausted ? '（候选卡片已读完）' : '');
      if (typeof ev.added === 'number') $('fetchInfo').textContent = `已获取 ${CANDS.length} 个（本轮新增 ${ev.added}）`;
      toast(`筛出 ${ev.ok} 个岗位（池子新增 ${ev.added != null ? ev.added : '?'}${ev.skipped ? `，跳过 ${ev.skipped} 个重复` : ''}）`);
      renderFetchRows();
      break;
    case 'sent-cleared':
      // 池子里已发送的岗位被清理（本面板发起的也会收到回声，过滤后幂等）
      {
        const before = CANDS.length;
        CANDS = CANDS.filter(j => !j.sent);
        CHECKED = new Set([...CHECKED].filter(u => CANDS.some(j => j.url === u)));
        renderRows(); renderFetchRows(); renderEditRows(); updateSelInfo();
        if (before !== CANDS.length) toast(`已清理 ${before - CANDS.length} 个已发送岗位`);
      }
      break;
    case 'job-dup': {
      // 同一 HR 已在沟通（这是 TA 的另一个岗位）：招呼语没重复发，
      // server 已给它打了 dupContact 标记 → 面板也跟着从三张表里隐掉。
      // 注意：池子里的 url 可能带 ?securityId=…，事件里的是干净 url —— 按基址比对。
      const base = (u) => String(u || '').split('?')[0].split('#')[0];
      const key = base(ev.url);
      const j = CANDS.find((x) => base(x.url) === key);
      if (j) j.dupContact = true;
      CHECKED = new Set([...CHECKED].filter((u) => base(u) !== key));
      saveChecked();
      renderRows(); renderFetchRows(); renderEditRows(); updateSelInfo();
      toast(`「${ev.job || '岗位'}」的 HR 已在沟通，跳过不重复发`);
      pushLog('SKIP', `「${ev.job || '岗位'}」：该 HR 已在沟通（TA 的另一个岗位），不重复发 —— 已标记，以后不再尝试`, '');
      break;
    }
    case 'quota': {
      // 平台额度提示（「已与 N 位BOSS沟通，还剩 M 次沟通机会」）
      const parts = [];
      if (ev.used != null) parts.push(`已与 ${ev.used} 位沟通`);
      if (ev.remaining != null) parts.push(`还剩 ${ev.remaining} 次`);
      const txt = parts.join('，');
      if (txt) {
        pushLog(ev.remaining != null && ev.remaining <= 5 ? 'WARN' : '·', `平台额度：${txt}`, '');
        if (ev.remaining != null && ev.remaining <= 5) toast(`平台额度不多了：${txt}`);
      }
      break;
    }
    case 'quota-stop':
      pushLog('ERR', '平台今日沟通次数已用完，本轮发送停止', '');
      toast('平台今日沟通次数已用完，已停止发送');
      break;
    case 'job-removed': {
      // 子进程扫到下架岗位，server 删磁盘+内存后广播；面板跟着删掉
      const before = CANDS.length;
      CANDS = CANDS.filter((j) => j.url !== ev.url);
      CHECKED = new Set([...CHECKED].filter((u) => CANDS.some((j) => j.url === u)));
      saveChecked();
      renderRows(); renderFetchRows(); renderEditRows(); updateSelInfo();
      const removed = before - CANDS.length;
      if (removed) toast(`「${ev.job || '岗位'}」已下架，从候选池删除`);
      break;
    }
    case 'candidates-deleted':
      // 岗位被删（「获取岗位」页勾选删除；本面板发起也会收到回声，过滤后幂等）
      {
        const urls = new Set(ev.urls || []);
        CANDS = CANDS.filter(j => !urls.has(j.url));
        CHECKED = new Set([...CHECKED].filter(u => CANDS.some(j => j.url === u)));
        FETCH_SEL = new Set([...FETCH_SEL].filter(u => !urls.has(u)));
        saveChecked();
        renderRows(); renderFetchRows(); renderEditRows(); updateSelInfo();
      }
      break;
    case 'checked-sync':
      // 远端勾选变更（agent 智能二筛 / 其他面板）。与本地一致 = 自己勾选广播
      // 回来的回声，静默跳过；不一致才应用 —— 文案不指明谁勾的
      {
        const inPool = new Set(CANDS.map(j => j.url));
        const next = new Set((ev.urls || []).filter(u => inPool.has(u)));
        const same = next.size === CHECKED.size && [...next].every(u => CHECKED.has(u));
        if (!same) {
          CHECKED = next;
          saveChecked();   // 落 localStorage（否则刷新会被本机旧勾选覆盖、丢失这次变更）
          renderRows(); renderEditRows(); updateSelInfo();
          toast(`勾选已更新（${CHECKED.size} 个）`);
        }
      }
      break;
    case 'collected-clear':
      CANDS = []; CHECKED.clear();
      saveChecked();
      renderRows(); renderFetchRows(); renderEditRows();
      $('collectHint').textContent = '';
      toast('候选已清空');
      break;
    case 'pool-refresh':
      // 池子文件被外部改写后 server 广播（CLI 兜底 + 「刷新活跃度」每写一条就落盘）。
      // 合并规则：新 url → 追加；已在池子里的 → **只同步 active / activeRaw**（刷新活跃度改的就是这俩，
      // 不同步的话刷新完面板上还是旧值），招呼语 / 勾选 / sent 一律保留本地不动。
      if (Array.isArray(ev.jobs) && ev.jobs.length) {
        const seen = new Map(CANDS.map(j => [j.url, j]));
        let added = 0, updated = 0;
        for (const j of ev.jobs) {
          if (!j || !j.url) continue;
          const cur = seen.get(j.url);
          if (!cur) {
            seen.set(j.url, j);
            CANDS.push({ ...j, sent: !!j.sent, dupContact: !!j.dupContact });
            added++;
            continue;
          }
          if ((cur.active || '') !== (j.active || '')) { cur.active = j.active || ''; updated++; }
          cur.activeRaw = j.activeRaw || '';
        }
        if (added || updated) {
          renderRows(); renderFetchRows();
          if (added) {
            $('fetchInfo').textContent = `已获取 ${CANDS.length} 个（本轮新增 ${added}）`;
            toast(`检测到命令行爬取的新岗位 ${added} 个，已并入池子`);
          } else {
            toast(`活跃度已更新 ${updated} 个`);
          }
        }
      }
      break;
    case 'send-start':
      hideAwait();
      pushLog('·', `▶ 开始发送 ${ev.total} 个`, '');
      break;
    case 'send-progress':
      $('mFilled').textContent = ev.filled || 0;
      $('mSent').textContent = ev.sent || 0;
      $('mSkip').textContent = (ev.skipped || 0) + (ev.failed || 0);
      break;
    case 'awaiting':
      showAwait(ev);
      pushLog('WAIT', `「${ev.job}」招呼语已填进输入框，等你确认`, '');
      break;
    case 'filled':
      pushLog('OK', `「${ev.job}」已填进输入框（未发送）`, '');
      break;
    case 'sent':
      pushLog('OK', `✓ 已发送：${ev.job}${ev.manual ? '（你手动点的）' : ''}`, '');
      hideAwait();
      { const j = CANDS.find(x => x.url === ev.url); if (j) { j.sent = true; CHECKED.delete(ev.url); } }
      saveChecked();
      renderRows(); renderEditRows();
      renderRecords();
      break;
    case 'send-done':
      hideAwait();
      if (ev.fillOnly) toast(`处理完成，一个都没自动发送`);
      else toast(`发送完成：成功 ${ev.sent || 0} 个`);
      renderRecords();
      break;
    case 'knowledge-saved':
      toast('经历库已保存');
      break;
    case 'login-needed':
      showLogin(true);
      toast('检测到未登录，请在浏览器里扫码');
      pushLog('WARN', '检测到未登录，已打开登录页，等你扫码（最多等 10 分钟）', '');
      break;
    case 'login-ok':
      showLogin(false);
      toast('登录成功，继续');
      pushLog('OK', '登录成功，继续执行', '');
      break;
    case 'login-timeout':
      showLogin(false);
      pushLog('ERR', '等了 10 分钟还没登录，本次结束', '');
      break;
    case 'security':
      // BOSS 安全验证：只在页头状态徽标上变成「需验证」（悬停看说明），
      // 不再用黄色横幅挤动整页布局；细节进日志。
      showSafe(!!ev.on);
      pushLog(ev.on ? 'WAIT' : 'OK', ev.on ? 'BOSS 弹了安全验证，等你手动完成（最多等 5 分钟）' : '安全验证已通过，继续执行', '');
      break;
    case 'browser-kept':
      showBrowserUI(true);
      toast('浏览器保持开着，你可以去浏览器里查看或手动发送');
      break;
    case 'browser-closed':
      showBrowserUI(false);
      break;
    case 'run-exit':
      applyState({ status: ev.status === 'error' ? 'error' : 'idle', sendProgress: null, awaiting: null });
      $('collectHint').textContent = '';
      showSafe(false);   // 任务已结束，安全验证横条不该残留
      refreshQuota();
      break;
    case 'error':
      pushLog('ERR', ev.msg, '');
      renderExpectError(ev.msg);
      break;
  }
}
async function refreshQuota() {
  // 刷新记录页的三项统计
  try {
    const r = await api('/api/records');
    fillRecStats(r.stats);
  } catch (_) {}
}

// ---------- 动作 ----------
