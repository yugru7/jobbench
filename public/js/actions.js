// 由 index.html 拆出（split-ui.js 自动生成）
// 经典脚本 + defer：三个文件共享全局作用域，加载顺序即 core → render → actions

// ========== 动作（搜索/发送/停止）与经历库 ==========
let STARTING = false;   // 防连点：请求还没回来时再点会双开任务，两个实例抢浏览器必然崩一个

function collectHintFor(a) {
  return a.source === 'recommend' ? '正在爬取推荐岗位…'
    : a.source === 'expect' ? `正在爬「${a.expectTab}」…`
    : a.source === 'fav' ? '正在爬取收藏岗位…' : '正在搜索岗位…';
}

async function collect() {
  if (STARTING) return;
  const source = $('collectSource').value;
  const kws = [...SELECTED];
  if (source === 'search' && !kws.length) { toast('至少选一个投递方向（或把来源切到「推荐」）'); return; }
  if (source === 'expect' && !EXPECT_PICKED) { toast('先去「岗位初筛」页点选一个意向方向'); return; }
  // 单次爬取硬钳制在 10：input 的 max 属性拦不住手动输入（少量多次，一次最多 10）
  const maxJobs = Math.min(parseInt($('maxJobs').value, 10) || 10, 10);
  const args = {
    source, keywords: kws, maxJobs,
    cityCode: CITY.code, cityName: CITY.name,
    expectTab: source === 'expect' ? EXPECT_PICKED : '',
  };
  STARTING = true; $('btnCollect').disabled = true;
  // 合并式池子：不清 CANDS/CHECKED —— 新岗位经 candidate 事件去重合并，历史候选与勾选保留
  $('logBox').innerHTML = '';
  let r;
  try {
    r = await api('/api/collect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } finally {
    STARTING = false; $('btnCollect').disabled = false;
  }
  if (!r.ok) { toast(r.error || '启动失败'); return; }
  $('collectHint').textContent = collectHintFor(args);
}

// 岗位数量实时钳制：上限跟随「设置」页（输入框的 max 属性，render.js 按配置设置）
function clampMaxJobs(el) {
  const cap = parseInt(el.max, 10) || 10;
  const v = parseInt(el.value, 10);
  if (isNaN(v) || v < 1) { if (el.value !== '') el.value = 1; return; }
  if (v > cap) el.value = cap;
}

// 来源切换：推荐/意向页签模式不依赖投递方向（数据来自 BOSS 账号里勾选的求职方向）
// loadIt=false 用于启动恢复：只还原界面，不真去读 BOSS（否则一开页面就弹浏览器）
function applySource(v, loadIt) {
  $('btnCollect').textContent = v === 'recommend' ? '爬推荐岗位'
    : v === 'expect' ? '爬意向岗位'
    : v === 'fav' ? '爬收藏岗位' : '搜索岗位';
  // 投递方向（chips + 添加框）只有搜索模式用得到，推荐/意向页签/收藏都来自 BOSS 账号
  const useKw = v === 'search';
  $('kwRow').style.display = useKw ? '' : 'none';
  $('expectRow').style.display = v === 'expect' ? '' : 'none';
  // 城市定位：意向方向的页签来自 BOSS 简历期望城市（页签后缀自带）、收藏是账号里已收藏的岗位
  // —— 定位选择对它俩都无意义（收藏更是完全不吃，lib/search.js 用固定收藏 URL）
  $('cityRow').style.display = (v === 'expect' || v === 'fav') ? 'none' : '';
  $('collectHint').textContent = v === 'recommend' ? '按你在 BOSS 里勾选的意向岗位推荐，不用选投递方向'
    : v === 'expect' ? '先去「岗位初筛」页挑一个意向方向'
    : v === 'fav' ? '爬你 BOSS 账号里收藏的岗位，不套城市 / 经验 / 筛选条件' : '';
  renderSourceNav();
  renderFilterNav();   // 来源变了：筛选组跟着变，重建
  if (v === 'expect' && loadIt) loadExpects();
}
function onSourceChange() {
  const v = $('collectSource').value;
  savePref('source', v);   // 记住来源（刷新/重启后不变）
  applySource(v, true);
}

// ---------- 岗位初筛：来源 chip 导航栏 + 筛选条件 ----------
// 来源 chip：写进隐藏 select 后走原有 onSourceChange（记住来源 + applySource）。
function pickSource(v) {
  const sel = $('collectSource');
  if (!sel) return;
  if (sel.value === v) { renderSourceNav(); return; }
  sel.value = v;
  onSourceChange();
}
// 选 / 取消一个选项（clear=true 时表示「不限」→ 清空该项）。
// 默认多选（BOSS 支持逗号多选，存「码串」如 404,405）；single 组（如求职类型）互斥，直接替换。
function toggleFilterValue(key, code, clear) {
  const src = curSource();
  // 经验要求是「全局」设置（存 config.experience），不走 sourceFilters —— 单独处理
  if (key === 'experience') {
    const cur = EXP_CODES.slice();
    if (clear) saveExperience('');
    else { const i = cur.indexOf(code); if (i >= 0) cur.splice(i, 1); else cur.push(code); saveExperience(cur.join(',')); }
    renderFilterNav();
    return;
  }
  SOURCE_FILTERS[src] = SOURCE_FILTERS[src] || {};
  if (clear) SOURCE_FILTERS[src][key] = '';
  else if ((FILTER_GROUPS.find(g => g.key === key) || {}).single) {
    // 互斥组：点已选中的再点一次 = 取消（回到不限），否则直接替换成新值
    SOURCE_FILTERS[src][key] = pickedCodes(src, key).includes(code) ? '' : code;
  } else {
    const cur = pickedCodes(src, key);
    const i = cur.indexOf(code);
    if (i >= 0) cur.splice(i, 1); else cur.push(code);
    SOURCE_FILTERS[src][key] = cur.join(',');
  }
  // 「多来源共有」的筛选（求职类型/学历/规模/融资）：全局一份 —— 把新值同步到其它来源，
  // 保证「切来源时不变」（工作区域只有搜索有，不在此列）
  const g = FILTER_GROUPS.find(x => x.key === key);
  if (isSharedGroup(g)) {
    for (const s of FILTER_SOURCES) { SOURCE_FILTERS[s] = SOURCE_FILTERS[s] || {}; SOURCE_FILTERS[s][key] = SOURCE_FILTERS[src][key]; }
  }
  saveSourceFilters();
  renderFilterNav();
}
// 写回 config.json（各来源分别保存；collect 时由 lib/search.js 拼进 BOSS URL）
function saveSourceFilters() {
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceFilters: SOURCE_FILTERS }) }).catch(() => {});
}

// 读 BOSS 账号里勾选的求职方向（结果经 SSE 事件 t:'expects' 回来渲染 chips）
// force=true（「刷新方向」）：忽略缓存真读一次；否则有缓存秒出
async function loadExpects(force) {
  EXPECT_PICKED = '';
  savePref('expectTab', '');   // 清掉记住的方向；读回后若还在会自动选回（见 render.js 的 expects 事件）
  renderExpectChips(null);   // 读取中，别用"没读到方向"的失败文案吓人
  const r = await api('/api/expects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: !!force }),
  });
  if (!r.ok) { renderExpectError(r.error); toast(r.error || '读取方向失败'); }
}

async function send() {
  if (STARTING) return;
  const items = CANDS.filter(j => CHECKED.has(j.url)).map(j => ({
    url: j.url, job: j.job, company: j.company, greeting: j.greeting, jd: j.jd,
  }));
  if (!items.length) { toast('先去「二次筛选」勾选要投的岗位'); return; }
  if (SEND_MODE === 'auto' && !confirm(`确定要自动发送 ${items.length} 个招呼语吗？\n\n发出去就收不回来了。`)) return;

  STARTING = true; $('btnSend').disabled = true;
  $('sendHint').textContent = '正在收掉上一个任务/启动中…';
  let r;
  try {
    r = await api('/api/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // userApproved：auto 模式的服务端门禁 —— 走到这里说明用户刚在弹窗里亲自确认过
      body: JSON.stringify({ items, mode: SEND_MODE, userApproved: SEND_MODE === 'auto' }),
    });
  } finally {
    STARTING = false;
    // 失败时恢复按钮（成功的话马上会被 run-started/applyState 接管）
    updateSelInfo();
  }
  if (!r.ok) { $('sendHint').textContent = ''; toast(r.error || '启动失败'); return; }
  toast(SEND_MODE === 'fillOnly' ? '开始填进输入框（不会发送）' : '开始发送');
}
// 停止 = 直接终止脚本：没爬完的不爬、没发完的不发。
// 后端收到 STOP 后在最近的检查点干净收尾（预热/岗位之间都能及时响应）。
async function stop() { await api('/api/stop', { method: 'POST' }); toast('正在停止…'); }

// 刷新未发送岗位的活跃度（维护动作）：池里的活跃度是采集时的快照，放久了会失真。
// 会真的逐个重开详情页重读 —— 浏览节奏与爬取同源（参数在设置页「爬取 / 刷新岗位」那一组）。
// 过程中可在顶栏点「停止」；停止后再点一次 = 从头重新开始（不做断点续传）。
async function refreshActive() {
  if (STARTING) return;
  const st = BOOT && BOOT.state ? BOOT.state.status : 'idle';
  if (st !== 'idle' && st !== 'error') { toast('任务正在跑，等它结束或点「停止」'); return; }
  const unsent = CANDS.filter(j => !j.sent).length;
  if (!unsent) { toast('池子里没有未发送的岗位'); return; }
  if (!confirm(`刷新 ${unsent} 个未发送岗位的活跃度？会逐个重开详情页重读（浏览节奏与爬取相同），过程中可随时「停止」。`)) return;
  STARTING = true;
  let r;
  try {
    r = await api('/api/reread', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'unsent' }) });
  } finally { STARTING = false; }
  if (!r.ok) { toast(r.error || '刷新启动失败'); return; }
  toast('正在刷新活跃度…（可在顶栏点「停止」）');
}

// 清理已发送（从池子里移除 sent 岗位——发了的大概率爬不到，留着占地方；先备份 .bak）
async function clearSent() {
  const sentCount = CANDS.filter(j => j.sent).length;
  if (!sentCount) { toast('池子里没有已发送的岗位'); return; }
  if (!confirm(`清理池子里 ${sentCount} 个已发送的岗位？（未处理的保留，自动备份到 logs/last-collect.json.bak）`)) return;
  const r = await api('/api/collected/clear-sent', { method: 'POST' });
  if (!r.ok) { toast(r.error || '清理失败'); return; }
  CANDS = CANDS.filter(j => !j.sent);
  CHECKED = new Set([...CHECKED].filter(u => CANDS.some(j => j.url === u)));
  renderRows(); renderFetchRows(); renderEditRows(); updateSelInfo();
  toast(`已清理 ${sentCount} 个已发送岗位`);
}

// 删除「获取岗位」页勾选的岗位：从候选池彻底删除，服务端删除前自动备份 .bak。
// 勾选用的是 FETCH_SEL（与二筛的 CHECKED 各自独立）—— 这里勾的是"不想要的"，不是"不投的"。
async function deleteSelected() {
  const urls = [...FETCH_SEL];
  if (!urls.length) { toast('先勾选要删除的岗位'); return; }
  if (!confirm(`删除勾选的 ${urls.length} 个岗位？（从候选池彻底删除，会自动备份到 logs/last-collect.json.bak）`)) return;
  const r = await api('/api/collected/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }) });
  if (!r.ok) { toast(r.error || '删除失败'); return; }
  CANDS = CANDS.filter(j => !FETCH_SEL.has(j.url));
  CHECKED = new Set([...CHECKED].filter(u => CANDS.some(j => j.url === u)));
  FETCH_SEL = new Set();
  renderRows(); renderFetchRows(); renderEditRows(); updateSelInfo();
  toast(`已删除 ${r.removed != null ? r.removed : urls.length} 个岗位`);
}

// ---------- 招呼语提示词（设置页按钮 → 屏幕中间大输入框）----------
// 写回 prompts/greeting.md（agent 和自动生成共用）。弹窗里的编辑不单独保存：
// 点「完成」关掉后跟设置页其余字段一起由「保存设置」提交。
let PROMPT_OPEN_TEXT = '';   // 打开弹窗时的内容，「取消」用它还原

async function loadPrompt() {
  const r = await api('/api/prompt');
  if (r && r.ok !== false && typeof r.text === 'string') $('promptText').value = r.text;
}

function openPromptBox() {
  PROMPT_OPEN_TEXT = $('promptText').value;
  $('promptModal').hidden = false;
  // 打开时显示最上面：el.value 设值后光标默认在末尾，
  // focus() 会把视图滚到光标处 → 一开就在底部。先聚焦再把光标/滚动条收回开头。
  const ta = $('promptText');
  ta.focus();
  ta.setSelectionRange(0, 0);
  ta.scrollTop = 0;
}

// done=true（完成）保留编辑内容并标脏；false（取消 / ESC / 点遮罩）还原成打开时的内容
function closePromptBox(done) {
  if (!done) $('promptText').value = PROMPT_OPEN_TEXT;
  $('promptModal').hidden = true;
  if (done && $('promptText').value !== PROMPT_OPEN_TEXT) setDirty();
}

// 恢复默认：只把出厂版填进输入框，不立刻写文件 —— 落盘还是走「保存设置」
async function fillPromptDefault() {
  if (!confirm('填入出厂默认提示词？当前编辑的内容会被替换（点「保存设置」后才写回文件）。')) return;
  const r = await api('/api/prompt').catch(() => null);
  if (r && typeof r.defaultText === 'string' && r.defaultText) {
    $('promptText').value = r.defaultText;
    toast('已填入默认提示词，点「保存设置」生效');
  } else toast('读不到默认提示词');
}

// 「保存设置」提交提示词用
async function savePromptPart() {
  const text = ($('promptText') || {}).value || '';
  if (!text.trim()) return { ok: false, error: '提示词不能为空' };
  const r = await api('/api/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }) }).catch(() => null);
  return (r && r.ok === true) ? r : (r || { ok: false, error: '提示词保存失败' });
}

// 弹窗关闭：点遮罩 / ESC（按钮走 HTML 里的 onclick）
document.addEventListener('DOMContentLoaded', () => {
  $('promptModal').addEventListener('click', (e) => { if (e.target === $('promptModal')) closePromptBox(false); });
  document.addEventListener('keydown', (e) => {
    if ($('promptModal').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closePromptBox(false); }
  });
});

// ---------- 设置页（限额 / 间隔 / 防护参数开放给用户） ----------
// 设置页字段表：id = set + 首字母大写的 config 键。集中一处，加新参数改这里 + index.html 即可
// 注意：显示层的单位做了「说人话」转换 —— 界面填「秒 / 百分数」，config 里存
// 「毫秒 / 0~1 小数」（脚本按毫秒用）。转换只在这一层做，config 与脚本零改动。
const SET_FIELDS = [
  'maxJobsPerRun', 'dailyCollectCap', 'dailyCap',
  'delayMinSec', 'delayMaxSec', 'delayTailRatio', 'delayTailMinSec', 'delayTailMaxSec',
  'collectDelayMinSec', 'collectDelayMaxSec', 'collectDelayTailRatio',
  'collectDelayTailMinSec', 'collectDelayTailMaxSec',
  'clickPauseMinMs', 'clickPauseMaxMs', 'readPauseMinMs', 'readPauseMaxMs',
  'readScrollMinPx', 'readScrollMaxPx',
  'rereadMaxPerRun', 'rereadBatchSize', 'rereadBatchGapMinMs', 'rereadBatchGapMaxMs',
];
// 界面 id 用的键（毫秒字段在界面上叫 ...Sec，因为用户填的是秒）
const SET_UI_KEY = {
  clickPauseMinMs: 'clickPauseMinSec', clickPauseMaxMs: 'clickPauseMaxSec',
  readPauseMinMs: 'readPauseMinSec', readPauseMaxMs: 'readPauseMaxSec',
  rereadBatchGapMinMs: 'rereadBatchGapMinSec', rereadBatchGapMaxMs: 'rereadBatchGapMaxSec',
};
const setElId = (key) => 'set' + key.charAt(0).toUpperCase() + key.slice(1);

// config 值 → 界面显示值 / 界面值 → config 值
const toView = (key, v) => {
  if (v === undefined || v === null || v === '') return v;
  if (key.endsWith('Ms')) return Math.round(Number(v) / 100) / 10;        // 2000ms → 2 秒
  if (key.endsWith('Ratio')) return Math.round(Number(v) * 1000) / 10;    // 0.25 → 25
  return v;
};
const toCfg = (key, v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (key.endsWith('Ms')) return Math.round(n * 1000);                    // 2 秒 → 2000ms
  if (key.endsWith('Ratio')) return Math.max(Math.min(n / 100, 1), 0);   // 25 → 0.25
  return n;
};

// 厂商默认值（= server.js settingsView 的兜底值）。重置用它，
// 不写死在服务端另一份，避免两边默认值漂移
const SET_DEFAULTS = {
  maxJobsPerRun: 10, dailyCollectCap: 80, dailyCap: 60,
  delayMinSec: 4, delayMaxSec: 6, delayTailRatio: 0.25, delayTailMinSec: 6, delayTailMaxSec: 12,
  collectDelayMinSec: 4, collectDelayMaxSec: 7, collectDelayTailRatio: 0.25,
  collectDelayTailMinSec: 7, collectDelayTailMaxSec: 11,
  clickPauseMinMs: 0, clickPauseMaxMs: 2000, readPauseMinMs: 1000, readPauseMaxMs: 2000,
  readScrollMinPx: 300, readScrollMaxPx: 700,
  rereadMaxPerRun: 0, rereadBatchSize: 10, rereadBatchGapMinMs: 30000, rereadBatchGapMaxMs: 90000,
};

function fillSettings(cfg) {
  for (const k of SET_FIELDS) {
    const el = $(setElId(SET_UI_KEY[k] || k));
    if (el && cfg && cfg[k] !== undefined && cfg[k] !== null) el.value = toView(k, cfg[k]);
  }
}

// ---------- 保存语义（手动点保存，不再改动即保存）----------
// SET_SAVED = 服务端最后一次确认的生效值（config 单位）；SET_DIRTY = 有未保存改动。
// 有未保存改动时：切页签 / 关页面都会先问一句，别让用户白填。
let SET_SAVED = null;
let SET_DIRTY = false;
let setSaving = false;
const setDirty = () => { if (SET_SAVED) { SET_DIRTY = true; saveDraft(); updateSetBar(); } };

// 界面当前值（换算成 config 单位）——只取 SET_FIELDS 里那些设置页字段
function collectSettings() {
  const out = {};
  for (const k of SET_FIELDS) {
    const el = $(setElId(SET_UI_KEY[k] || k));
    if (el) out[k] = toCfg(k, el.value);
  }
  return out;
}

function markSaved(cfg) {
  SET_SAVED = cfg;
  SET_DIRTY = false;
  updateSetBar();
}

// ---------- 未保存草稿持久化（本页刷新不丢未保存改动）----------
// 存"界面原值"（未换算），刷新后原样回填；只要出现未保存改动就写，
// 保存 / 撤销 / 放弃（切页签选"不保存"）时清。
// 用 sessionStorage（不是 localStorage）：同一标签页刷新能留住，关掉标签页就没了——
// 正好对上"刷新不掉、不保存切走则还原"的语义，也避免草稿跨会话残留。
const DRAFT_KEY = 'settings-draft';
function collectUI() {   // SET_FIELDS 各字段的界面当前值（含非法中间态，原样存）
  const out = {};
  for (const k of SET_FIELDS) { const el = $(setElId(SET_UI_KEY[k] || k)); if (el) out[el.id] = el.value; }
  return out;
}
function saveDraft() {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ fields: collectUI(), prompt: ($('promptText') || {}).value || '' }));
  } catch (_) {}
}
function clearDraft() { try { sessionStorage.removeItem(DRAFT_KEY); } catch (_) {} }
function readDraft() { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null'); } catch (_) { return null; } }

// 进设置页：服务端值已回填后再调本函数 —— 有草稿就用草稿覆盖并标脏（刷新后原样恢复）。
// 草稿若和已保存值一模一样（改完又手动改回来）→ 当没有，顺手清掉，免得虚报"未保存"。
function restoreDraft() {
  const d = readDraft();
  if (!d) return;
  const serverUI = collectUI();
  const sameFields = !d.fields || JSON.stringify(d.fields) === JSON.stringify(serverUI);
  const samePrompt = (typeof d.prompt !== 'string') || d.prompt === (($('promptText') || {}).value || '');
  if (sameFields && samePrompt) { clearDraft(); return; }
  if (d.fields) for (const id in d.fields) { const el = $(id); if (el) el.value = d.fields[id]; }
  if (typeof d.prompt === 'string' && $('promptText')) $('promptText').value = d.prompt;
  SET_DIRTY = true;
  updateSetBar();
}

// 底部操作行：按钮常驻（反馈"按钮还是没有"——之前做成"改了才出现"
// 等于没有按钮）。现在只切按钮可用性与提示文案，不隐藏任何东西。
function updateSetBar() {
  const dirty = SET_DIRTY && !setSaving;
  const sv = $('btnSaveSettings'), rv = $('btnRevertSettings');
  if (sv) sv.disabled = !dirty;
  if (rv) rv.disabled = !dirty;
  const warn = $('setDirtyHint');
  if (warn) {
    warn.textContent = setSaving ? '正在保存…' : (dirty ? '有改动还没保存' : '当前设置已保存');
    warn.classList.toggle('isdirty', dirty);
  }
}

// 进设置页时拉当前值（面板和脚本共用 config.json，改哪边都一致）
async function loadSettings() {
  const r = await api('/api/config').catch(() => null);
  if (r && r.config) {
    fillSettings(r.config);
    markSaved(r.config);
  }
  await loadPrompt();    // 提示词也归设置页了
  restoreDraft();        // 上次刷新前留下的未保存草稿 → 原样恢复
}

// 「撤销改动」= 丢弃未保存草稿，回到服务端已保存的值（也会清掉刷新用的草稿）
function revertSettings() { clearDraft(); loadSettings(); }

// 一键保存：设置页全部字段 + 招呼语提示词，一次性落盘。
// 用服务端回传的值回填（钳制后的结果）—— 保证「界面显示 = 实际生效」
async function saveSettings() {
  if (setSaving) return;

  // —— 前端预校验 ——
  // 后端 clamp 兜底，但用户填 10000 进"发送间隔上限"被压成 120 后界面会变，他会懵。
  // 所以前端直接拦，让他当场改。

  // 1. 单值范围：全部按界面显示单位（因为 DOM value 是界面值）
  //    Ratio 在界面是 %（0~100），Ms 在界面是秒（0~...），其余原样
  const SINGLE_CHECKS = [
    { el: 'setMaxJobsPerRun',       label: '单次爬取数量',     min: 1,    max: 30,   step: null },
    { el: 'setDailyCollectCap',     label: '每日最多爬',       min: 1,    max: 300,  step: null },
    { el: 'setDailyCap',            label: '每日最多发',       min: 1,    max: 200,  step: null },
    { el: 'setDelayMinSec',         label: '发送间隔·短段下限', min: 1,    max: 60,   step: 0.5 },
    { el: 'setDelayMaxSec',         label: '发送间隔·短段上限', min: 1,    max: 120,  step: 0.5 },
    { el: 'setDelayTailRatio',      label: '发送间隔·长尾占比', min: 0,    max: 100,  step: 5,   suffix: '%' },
    { el: 'setDelayTailMinSec',     label: '发送间隔·长尾下限', min: 1,    max: 60,   step: 0.5 },
    { el: 'setDelayTailMaxSec',     label: '发送间隔·长尾上限', min: 1,    max: 300,  step: 0.5 },
    { el: 'setCollectDelayMinSec',  label: '爬取/刷新间隔·短段下限', min: 1,    max: 60,   step: 0.5 },
    { el: 'setCollectDelayMaxSec',  label: '爬取/刷新间隔·短段上限', min: 1,    max: 120,  step: 0.5 },
    { el: 'setCollectDelayTailRatio', label: '爬取/刷新间隔·长尾占比', min: 0,  max: 100,  step: 5,   suffix: '%' },
    { el: 'setCollectDelayTailMinSec', label: '爬取/刷新间隔·长尾下限', min: 1,  max: 60,   step: 0.5 },
    { el: 'setCollectDelayTailMaxSec', label: '爬取/刷新间隔·长尾上限', min: 1,  max: 300,  step: 0.5 },
    { el: 'setClickPauseMinSec',    label: '沟通前在 JD 页面停留·下限', min: 0,    max: 5,    step: 0.1, unit: '秒' },
    { el: 'setClickPauseMaxSec',    label: '沟通前在 JD 页面停留·上限', min: 0,    max: 10,   step: 0.1, unit: '秒' },
    { el: 'setReadPauseMinSec',     label: '看岗位时停留·下限',         min: 0,    max: 10,   step: 0.1, unit: '秒' },
    { el: 'setReadPauseMaxSec',     label: '看岗位时停留·上限',         min: 0,    max: 30,   step: 0.1, unit: '秒' },
    { el: 'setReadScrollMinPx',     label: '停留时滚轮滑动·下限',       min: 0,    max: 3000, step: 50,  unit: '像素' },
    { el: 'setReadScrollMaxPx',     label: '停留时滚轮滑动·上限',       min: 0,    max: 5000, step: 50,  unit: '像素' },
    { el: 'setRereadMaxPerRun',     label: '刷新活跃度·一次最多刷',     min: 0,    max: 300,  step: null },
    { el: 'setRereadBatchSize',     label: '刷新活跃度·每批条数',       min: 1,    max: 30,   step: null },
    { el: 'setRereadBatchGapMinSec', label: '刷新活跃度·批间休息下限',  min: 0,    max: 600,  step: 1,   unit: '秒' },
    { el: 'setRereadBatchGapMaxSec', label: '刷新活跃度·批间休息上限',  min: 0,    max: 900,  step: 1,   unit: '秒' },
  ];
  for (const c of SINGLE_CHECKS) {
    const el = $(c.el);
    const raw = el.value.trim();
    if (raw === '') { toast(`「${c.label}」不能为空`); el.focus(); return; }
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) { toast(`「${c.label}」得是数字`); el.focus(); return; }
    if (n < c.min || n > c.max) {
      const suf = c.suffix ? c.suffix : (c.unit ? c.unit : '');
      toast(`「${c.label}」要在 ${c.min}~${c.max}${suf} 之间（你填了 ${raw}${suf}）`);
      el.focus(); el.select();
      return;
    }
    if (c.step != null) {
      const delta = Math.abs((n / c.step) - Math.round(n / c.step));
      if (delta > 1e-6) {
        toast(`「${c.label}」步长是 ${c.step}${c.suffix || ''}（你填了 ${raw}）`);
        el.focus(); el.select();
        return;
      }
    }
  }

  // 2. 配对校验：min > max 直接拦，不存个错配置跑起来乱
  const PAIR_CHECKS = [
    ['发送间隔·短段',      'setDelayMinSec',              'setDelayMaxSec'],
    ['发送间隔·长尾',      'setDelayTailMinSec',          'setDelayTailMaxSec'],
    ['爬取/刷新间隔·短段',      'setCollectDelayMinSec',       'setCollectDelayMaxSec'],
    ['爬取/刷新间隔·长尾',      'setCollectDelayTailMinSec',   'setCollectDelayTailMaxSec'],
    ['沟通前在 JD 页面停留',   'setClickPauseMinSec',        'setClickPauseMaxSec'],
    ['看岗位时停留',             'setReadPauseMinSec',          'setReadPauseMaxSec'],
    ['停留时滚轮滑动',           'setReadScrollMinPx',          'setReadScrollMaxPx'],
    ['刷新活跃度·批间休息',      'setRereadBatchGapMinSec',     'setRereadBatchGapMaxSec'],
  ];
  for (const [label, minId, maxId] of PAIR_CHECKS) {
    const a = parseFloat($(minId).value), b = parseFloat($(maxId).value);
    if (Number.isFinite(a) && Number.isFinite(b) && a > b) {
      toast(`「${label}」最小值不能比最大值大（${a} > ${b}）`);
      $(minId).focus(); $(minId).select();
      return;
    }
  }

  setSaving = true;
  updateSetBar();
  try {
    // 提示词跟着一起提交（提示词不单独出保存按钮，共用这一套）
    const [rc, rp] = await Promise.all([
      api('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectSettings()),
      }).catch(() => null),
      savePromptPart(),
    ]);
    if (!rc || rc.ok !== true) { toast('保存失败，请重试'); updateSetBar(); return; }
    if (!rp || rp.ok !== true) { toast((rp && rp.error) || '提示词保存失败，其余设置已保存'); updateSetBar(); return; }
    if (rc.config) { fillSettings(rc.config); markSaved(rc.config); }
    else { markSaved(collectSettings()); }
    clearDraft();   // 已落盘，草稿没用了
    // 单次爬取上限变了 → 获取岗位页的输入框 max/value 跟着走
    if (rc.config && $('maxJobs')) {
      const cap = Math.min(Math.max(parseInt(rc.config.maxJobsPerRun, 10) || 10, 1), 30);
      $('maxJobs').max = cap;
      if (parseInt($('maxJobs').value, 10) > cap) $('maxJobs').value = cap;
    }
    toast('设置已保存');
  } finally { setSaving = false; updateSetBar(); }
}

// 恢复默认：只重置数值参数，不碰提示词 / 城市 / 知识库（各自独立重置）。
// 立刻落盘（是明确的破坏性操作），不跟其他改动一起等保存
async function resetSettings() {
  if (!confirm('恢复默认设置？\n\n只重置限额 / 间隔 / 防护参数，不影响招呼语提示词、城市和知识库。\n（立即生效，不用再点保存）')) return;
  const r = await api('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SET_DEFAULTS),
  }).catch(() => null);
  if (r && r.ok) { fillSettings(r.config || SET_DEFAULTS); markSaved(r.config || SET_DEFAULTS); clearDraft(); toast('已恢复默认设置'); }
  else toast('恢复失败');
}

// 离开设置页时的拦截（按钮是「保存 / 不保存」，不是确定/取消）。
//   保存   → 先落盘再离开（明确要保存，就该存）
//   不保存 → 放弃改动直接走
// 返回 true = 可以离开；false = 留在设置页
async function confirmLeaveSettings() {
  if (!SET_DIRTY) return true;
  const pick = await askBox('设置还没保存，要保存吗？', '不保存', '保存');
  if (pick === true) { await saveSettings(); return true; }   // 保存并离开（saveSettings 已清草稿）
  if (pick === false) { clearDraft(); return true; }          // 不保存 → 丢弃草稿再走
  return false;                                                // null(ESC) → 留下
}

// ---------- 页签切换（知识库 + 工作台六步） ----------
const PAGES = { about: 'pageAbout', how: 'pageHow', kb: 'pageKb', dir: 'pageDir', fetch: 'pageFetch', filter: 'pageFilter', edit: 'pageEdit', send: 'pageSend', records: 'pageRecords', settings: 'pageSettings' };
// remember=false 时不写 localStorage（启动恢复用，别把默认值写死成"用户选择"）
// 变async：离开设置页时要等用户在「保存 / 不保存」弹窗里做选择
async function switchTab(name, remember) {
  const id = PAGES[name] || 'pageDir';
  name = Object.keys(PAGES).find((k) => PAGES[k] === id);
  // 离开设置页前拦截未保存改动。
  // 注意顺序：先算目标页，确认「真的在离开设置页」才问，避免切回设置页也被问
  const curPage = document.querySelector('.page.on');
  const leavingSettings = curPage && curPage.id === 'pageSettings' && id !== 'pageSettings';
  if (leavingSettings && SET_DIRTY && !(await confirmLeaveSettings())) return;
  // 离开知识库页时，把还没到点的那一笔立刻写出去（边写边存）
  if (curPage && curPage.id === 'pageKb' && id !== 'pageKb') kbFlush();
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('on', el.id === id));
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('on', el.dataset.tab === name));
  // 离开后清脏标记（保存路径里 saveSettings 已经清了），别下次再问
  if (leavingSettings) { SET_DIRTY = false; updateSetBar(); }
  if (id !== 'pageSettings' && SET_DIRTY) { SET_DIRTY = false; updateSetBar(); }
  if (id === 'pageFetch') renderFetchRows();   // 进页面刷新计数/空态
  if (id === 'pageEdit') renderEditRows();     // 提示词编辑区已移到「设置」页
  if (id === 'pageSettings') loadSettings();   // 设置页：参数 + 提示词
  if (id === 'pageRecords') renderRecords();
  if (remember !== false) { try { localStorage.setItem('tab', name); } catch (_) {} }
}

// ---------- 个人知识库 ----------
// 经历条目兼容：新格式 { title, content }；旧格式（有过 highlights 的）自动合并成一段内容
function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map(en => {
    if (!en || typeof en !== 'object') return null;
    if (en.content) return en;
    // highlights 只在"确实是数组"时才遍历 —— 兼容旧格式的同时，兜住类型不对的输入
    const texts = (Array.isArray(en.highlights) ? en.highlights : [])
      .map(h => h && h.text).filter(Boolean);
    const head = [en.role, en.summary].filter(Boolean).join('：');
    return { title: en.title || '', content: [head].concat(texts).filter(Boolean).join('\n') };
  }).filter(en => en && (String(en.title || '').trim() || String(en.content || '').trim()));
}
function renderKnowledge(k) {
  K = JSON.parse(JSON.stringify(k || {}));
  // 兼容早期格式（老版本的 person.intro → profile.identity）
  K.profile = K.profile || {};
  if (!K.profile.identity && K.person && K.person.intro) K.profile.identity = K.person.intro;
  K.entries = normalizeEntries(K.entries);
  // 「我是谁」单框（不分四类）；旧格式 status/city/note 自动并入 identity
  if (!K.profile.identity && (K.profile.status || K.profile.city || K.profile.note)) {
    K.profile.identity = [K.profile.status, K.profile.city && `意向${K.profile.city}`, K.profile.note]
      .filter(Boolean).join('，');
  }
  $('kIdentity').value = K.profile.identity || '';
  $('kSkills').value = K.skills || '';
  $('kbExampleNote').style.display = k && k._isExample ? '' : 'none';   // 首次使用载入的是示例 → 提醒改掉
  renderEntries();
}
function renderEntries() {
  const box = $('entries');
  box.innerHTML = '';
  if (!K.entries.length) { box.innerHTML = '<div class="mini">还没有经历。点下面「新增经历」加一条（项目、实习、校园经历都可以）。</div>'; return; }
  K.entries.forEach((en, ei) => {
    const d = document.createElement('div');
    d.className = 'entry';
    d.innerHTML = `
      <div class="elabel">名称</div>
      <div class="row" style="margin:2px 0 8px">
        <input type="text" value="${attr(en.title)}" placeholder="例：校园二手交易小程序 / XX公司运营实习" style="flex:1"
          oninput="K.entries[${ei}].title=this.value;kbTouch()">
        <button class="sm danger" onclick="delEntry(${ei})">删除</button>
      </div>
      <div class="elabel">内容</div>
      <textarea rows="4" style="margin-top:2px" placeholder="写清楚你做过什么（真实、具体，带数字更好）。例：我独立做过一个校园二手交易小程序，从设计到上线都是自己弄的，现在还有两百多个同学在用。"
        oninput="K.entries[${ei}].content=this.value;kbTouch()">${esc(en.content || '')}</textarea>`;
    box.appendChild(d);
  });
}
function addEntry() { K.entries.push({ title: '', content: '' }); renderEntries(); kbTouch(); }
function delEntry(i) { if (confirm('删除这条经历？')) { K.entries.splice(i, 1); renderEntries(); kbTouch(); } }

// ---------- 知识库：边写边存（方案 B）----------
// 去掉「保存知识库」按钮：任何改动停手约 0.9 秒后静默写入 knowledge.json。
// 存的是服务端文件，所以刷新 / 切页签 / 关掉面板都不会丢。
// 静默 = 成功不弹 toast（不要状态提示），失败才提示。
let kbTimer = 0;
function kbTouch() { clearTimeout(kbTimer); kbTimer = setTimeout(() => { kbTimer = 0; saveKnowledge(true); }, 900); }
// 离开知识库页 / 关闭页面时，把还没到点的那一笔立刻冲出去（sendBeacon 能随页面关闭发出）
function kbFlush() {
  if (!kbTimer) return;
  clearTimeout(kbTimer); kbTimer = 0;
  if (!kbBeacon()) saveKnowledge(true);
}
function kbBeacon() {
  try {
    navigator.sendBeacon('/api/knowledge', new Blob([JSON.stringify(kbPayload())], { type: 'application/json' }));
    return true;
  } catch (_) { return false; }
}
window.addEventListener('pagehide', kbFlush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') kbFlush(); });

// 知识库要落盘的完整对象：界面上的「我是谁 / 技能」取 DOM，经历条目已由 oninput 同步进 K
function kbPayload() {
  K.profile = K.profile || {};
  const ident = $('kIdentity'); if (ident) K.profile.identity = ident.value.trim();
  const sk = $('kSkills'); if (sk) K.skills = sk.value.trim();
  K.enabled = true;
  delete K._isExample;   // 存过就是正式数据了
  delete K.person;       // 旧字段已迁进 profile
  delete K.tone;         // 口吻段已去掉（相关规则内置到 AI 生成里）
  delete K.template;     // 兜底模板已去掉（句式写死在代码里，没必要可配）
  delete K.fallback;
  K.entries = K.entries.filter(en => (en.title || '').trim() || (en.content || '').trim());
  return K;
}
// silent=true（边写边存）：成功不弹 toast，失败才提示
async function saveKnowledge(silent) {
  const r = await api('/api/knowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(kbPayload()) });
  if (r.ok) { if (!silent) toast('知识库已保存'); $('kbExampleNote').style.display = 'none'; }
  else toast(r.error || '保存失败');
}

// ---------- 起 ----------
// 恢复上次页签；首次使用（载入的是示例知识库）直接引导到知识库页
let savedTab = '';
try { savedTab = localStorage.getItem('tab') || ''; } catch (_) {}
if (savedTab === 'work') savedTab = 'dir';   // 旧版「工作台」页签映射到新的「岗位初筛」
switchTab(savedTab || 'dir', false);
boot().then(() => {
  if (!savedTab && BOOT.knowledge && BOOT.knowledge._isExample) switchTab('kb', false);
  connect(); renderRecords();
  // 不再挂 beforeunload：未保存改动已落 sessionStorage 草稿，
  // 本页刷新会自动恢复（loadSettings → restoreDraft），所以不需要"重新加载站点？"这个原生弹窗。
  // 切页面仍有页内「保存 / 不保存」询问；选「不保存」才丢弃草稿、还原成改动前。
}).catch(e => {
  // 错误分两种走法：
  //   ① bootstrap 都拿不到（服务没起来 / 面板被双击打开）→ 整页引导卡片：
  //      这时界面确实没数据可用，得明确告诉用户怎么启动服务；
  //   ② 服务是通的、只是初始化某一步抛错 → 只在标题后红字提示，页面主体照常。
  //   之前两者共用整页错误卡片：一个字段类型不对就把整个界面吞了（曾踩到，
  //   表现为「读取意向方向后端明明成功却什么都看不到」）。
  if (e && e.__bootFailed) {
    document.querySelector('.wrap').innerHTML = `
      <div class="card" style="margin-top:40px">
        <h2>连不上本地服务</h2>
        <p style="color:var(--ink-2); font-size:13px; margin:0 0 12px">这个界面需要后台服务配合，不能直接双击打开的 HTML 文件。</p>
        <p style="font-size:13px; margin:0 0 6px"><b>请这样打开：</b>双击项目目录里的 <b>启动.bat</b></p>
        <p class="mini">技术细节：${esc(e.message)}</p>
      </div>`;
  } else {
    noteBootProblem((e && e.message) || String(e));
  }
});
