/**
 * 路径常量 + 文件读写 + 配置视图
 * ----------------------------------------------------------------------------
 * 从 server.js 拆出的基础模块：所有磁盘路径集中在此，路由通过 deps 取用。
 */
const fs = require('fs');
const path = require('path');
// 用户数据统一放 data/（模块加载时自动把根目录的老文件搬进来，见 lib/data-dir.js）
const { DIR, DATA_DIR } = require('./data-dir');

const PUBLIC_DIR = path.join(DIR, 'public');
const LOG_DIR = path.join(DIR, 'logs');

const paths = {
  DIR,
  DATA_DIR,
  PUBLIC_DIR,
  LOG_DIR,
  CONFIG_FILE: path.join(DATA_DIR, 'config.json'),
  KNOWLEDGE_FILE: path.join(DATA_DIR, 'knowledge.json'),
  KNOWLEDGE_EXAMPLE_FILE: path.join(DATA_DIR, 'knowledge.example.json'),   // 首次使用载入的示例（开源版开箱引导）
  CITIES_FILE: path.join(DATA_DIR, 'cities.json'),
  FILTERS_FILE: path.join(DATA_DIR, 'filters.json'),   // BOSS 筛选选项 + 区县（update-filters.js 刷新）
  COLLECT_FILE: path.join(LOG_DIR, 'last-collect.json'),
  CHECKED_FILE: path.join(LOG_DIR, 'checked.json'),   // 二筛勾选的服务端副本（前端 localStorage 为事实源，agent 只读视图）
  EXPECTS_CACHE_FILE: path.join(LOG_DIR, 'expects-cache.json'),   // 意向方向列表缓存（见 loadExpectsCache）
  SENT_FILE: path.join(LOG_DIR, '已打招呼记录.txt'),
  SEND_LIST_FILE: path.join(LOG_DIR, '_send-list.json'),
  STATS_FILE: path.join(LOG_DIR, 'stats.json'),   // 累计统计（记录页「爬取」的总量/今日；greet.js 每次入池新增时累加）
  PROMPT_FILE: path.join(DIR, 'prompts', 'greeting.md'),              // 招呼语提示词（面板可编辑）
  PROMPT_DEFAULT_FILE: path.join(DIR, 'prompts', 'greeting.default.md'),   // 出厂默认（「恢复默认」用）
};

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function localDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function localDateTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${localDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function todayCount() {
  try {
    if (!fs.existsSync(paths.SENT_FILE)) return 0;
    // 只数「已发送」的行（记录里还有「已填入到输入框」的过渡态；旧格式无状态段=已发送）
    return fs.readFileSync(paths.SENT_FILE, 'utf8').split('\n')
      .filter(l => l.startsWith(localDate()) && !l.includes('已填入到输入框')).length;
  } catch (_) { return 0; }
}

// BOSS 城市列表：cities.json（抓自 BOSS 全量城市接口，373 城）
// 文件缺失/损坏时退回内置常用城市（形状保持一致，前端统一按 optgroup 渲染）
const FALLBACK_CITIES = [
  { name: '北京', code: '101010100' },
  { name: '上海', code: '101020100' },
  { name: '广州', code: '101280100' },
  { name: '杭州', code: '101210100' },
  { name: '成都', code: '101270100' },
  { name: '南京', code: '101190100' },
  { name: '武汉', code: '101200100' },
  { name: '西安', code: '101110100' },
];
function loadCities() {
  const d = readJson(paths.CITIES_FILE, null);
  if (d && Array.isArray(d.provinces) && d.provinces.length) {
    return { hot: d.hot || [], provinces: d.provinces };   // 省份→城市两级（cities.json）
  }
  // 兜底：把内置常用城市挂在一个伪省份下，界面结构不变
  return { hot: FALLBACK_CITIES, provinces: [{ code: '000000', name: '常用城市', cities: FALLBACK_CITIES }] };
}

// BOSS 筛选选项 + 区县（data/filters.json，update-filters.js 刷新）
// 文件缺失时返回 null —— 前端按「拿不到选项」降级（chips 只保留「不限」）
function loadFilters() {
  const d = readJson(paths.FILTERS_FILE, null);
  if (d && d.options && typeof d.options === 'object') {
    return { options: d.options, districts: d.districts || {} };
  }
  return null;
}

// ---------- 意向方向缓存 ----------
// 岗位每次爬都不一样（不该缓存，明确否掉），但 BOSS 账号里勾的求职方向
// 长期不变 —— 只缓存这个：切到「意向页签」秒出 chips，不用每次开浏览器重读。
// 自动：读到就存、切来源自动用；手动：界面「刷新方向」带 force 重读。
function loadExpectsCache() {
  try { return JSON.parse(fs.readFileSync(paths.EXPECTS_CACHE_FILE, 'utf8')); } catch (_) { return null; }
}
function saveExpectsCache(tabs) {
  try { fs.writeFileSync(paths.EXPECTS_CACHE_FILE, JSON.stringify({ at: new Date().toISOString(), tabs }), 'utf8'); } catch (_) {}
}

// 设置页可调参数视图：bootstrap 与 /api/config 共用，缺值给默认
function settingsView(cfg) {
  const c = cfg || {};
  const d = (v, dft) => (v !== undefined && v !== null && v !== '' ? v : dft);
  return {
    maxJobsPerRun: d(c.maxJobsPerRun, 10),
    dailyCollectCap: d(c.dailyCollectCap, 80),
    dailyCap: d(c.dailyCap, 60),
    delayMinSec: d(c.delayMinSec, 4), delayMaxSec: d(c.delayMaxSec, 6),
    delayTailRatio: d(c.delayTailRatio, 0.25),
    delayTailMinSec: d(c.delayTailMinSec, 6), delayTailMaxSec: d(c.delayTailMaxSec, 12),
    collectDelayMinSec: d(c.collectDelayMinSec, 4), collectDelayMaxSec: d(c.collectDelayMaxSec, 7),
    collectDelayTailRatio: d(c.collectDelayTailRatio, 0.25),
    collectDelayTailMinSec: d(c.collectDelayTailMinSec, 7), collectDelayTailMaxSec: d(c.collectDelayTailMaxSec, 11),
    clickPauseMinMs: d(c.clickPauseMinMs, 0), clickPauseMaxMs: d(c.clickPauseMaxMs, 2000),
    readPauseMinMs: d(c.readPauseMinMs, 1000), readPauseMaxMs: d(c.readPauseMaxMs, 2000),
    readScrollMinPx: d(c.readScrollMinPx, 300), readScrollMaxPx: d(c.readScrollMaxPx, 700),
    // 刷新活跃度（维护）专属：单次上限 / 每批条数 / 批间休息
    rereadMaxPerRun: d(c.rereadMaxPerRun, 0),
    rereadBatchSize: d(c.rereadBatchSize, 10),
    rereadBatchGapMinMs: d(c.rereadBatchGapMinMs, 30000), rereadBatchGapMaxMs: d(c.rereadBatchGapMaxMs, 90000),
    // 非「设置页」字段，但首屏 / 保存回执都要带上，前端据此恢复界面
    experience: c.experience || '',
    sourceFilters: (c.sourceFilters && typeof c.sourceFilters === 'object') ? c.sourceFilters : {},
  };
}

module.exports = {
  paths, readJson, writeJson, localDate, localDateTime, todayCount,
  loadCities, loadFilters, loadExpectsCache, saveExpectsCache, settingsView,
};
