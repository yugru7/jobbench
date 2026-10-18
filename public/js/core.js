// 由 index.html 拆出（split-ui.js 自动生成）
// 经典脚本 + defer：三个文件共享全局作用域，加载顺序即 core → render → actions

// ========== 状态与通用工具 ==========
const $ = (id) => document.getElementById(id);
let BOOT = null;
let SELECTED = new Set();      // 选中的关键词
let CITY = { name: '', code: '' };
let CANDS = [];                // 候选岗位
let CHECKED = new Set();       // 二筛勾选的岗位 url（= 要写招呼语 / 要投的）
let FETCH_SEL = new Set();     // 「获取岗位」页勾选的岗位 url（只服务于批量删除，与二筛勾选互不影响）
let SEND_MODE = 'fillOnly';
let K = { person: {}, template: '', fallback: '', entries: [] };
let EXPECT_TABS = [];          // 「来源：意向页签」从 BOSS 读回的求职方向列表
let EXPECT_PICKED = '';        // 用户挑中的那一个方向（单选）
let FILTERS_DATA = null;       // 岗位初筛筛选 chips 的选项 + 区县（BOOT.filters；缺失 = null，前端降级）
let SOURCE_FILTERS = {};       // 各来源已选的筛选条件（= config.sourceFilters，改动即落盘）

function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2400);
}
async function api(p, opt) { return (await fetch(p, opt)).json(); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function attr(s) { return esc(s).replace(/"/g, '&quot;'); }

// ---------- 界面习惯记忆（刷新 / 重启后保持当前状态）----------
// 来源（搜索/推荐/意向）、发送方式、意向方向（含方向列表）—— 都是"用户习惯"，
// 存 localStorage（关掉浏览器再打开也还在，跟筛选条件、勾选一个路子）。
const UI_KEY = 'boss-ui';
function uiPrefs() { try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {}; } catch (_) { return {}; } }
function savePref(k, v) { const o = uiPrefs(); o[k] = v; try { localStorage.setItem(UI_KEY, JSON.stringify(o)); } catch (_) {} }

// ---------- 自定义确认框 ----------
// 为什么不用原生 confirm：按钮文案「确定 / 取消」由浏览器决定，改不了。
// 要求离开设置页时是「保存 / 不保存」，所以这里做一个可自定义按钮文案的。
// 用法：await askBox('设置还没保存，要保存吗？', '不保存', '保存')
//      返回 true = 点第二个按钮（yesText，主按钮），false = 第一个（noText），null = ESC/遮罩
let askResolve = null;
function askBox(msg, noText, yesText) {
  const box = $('askBox');
  $('askMsg').innerHTML = msg;
  $('askNo').textContent = noText || '取消';
  $('askYes').textContent = yesText || '确定';
  box.hidden = false;
  $('askYes').focus();
  return new Promise((res) => { askResolve = res; });
}
function askClose(val) {
  $('askBox').hidden = true;
  const r = askResolve; askResolve = null;
  if (r) r(val);
}
// 按钮 / 遮罩 / ESC
document.addEventListener('DOMContentLoaded', () => {
  $('askNo').addEventListener('click', () => askClose(false));   // 第一个 = 否
  $('askYes').addEventListener('click', () => askClose(true));   // 第二个 = 是（primary）
  $('askBox').addEventListener('click', (e) => { if (e.target === $('askBox')) askClose(null); });
  document.addEventListener('keydown', (e) => {
    if ($('askBox').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); askClose(null); }
  });
});

// ---------- 启动 ----------
