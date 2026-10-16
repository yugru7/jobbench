/**
 * 通用工具：异步等待 / 随机数 / 时间戳 / 代理摘除 / 本地日期 / 终端颜色 / Chrome 探测
 * ----------------------------------------------------------------------------
 */
const fs = require('fs');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const stamp = () => new Date().toTimeString().slice(0, 8);

// 【踩过的坑】本机设了 HTTP_PROXY（且 NO_PROXY 为空）时，Playwright 连本地
// 127.0.0.1:9222 也会走代理，直接返回 502。连本地端口不需要代理，
// 这里临时摘掉代理变量，用完（finally）再恢复。
function withoutProxy(fn) {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
  const saved = {};
  for (const k of keys) {
    if (process.env[k] !== undefined) { saved[k] = process.env[k]; delete process.env[k]; }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => { for (const k of Object.keys(saved)) process.env[k] = saved[k]; });
}

// 本地日期 YYYY-MM-DD（不能用 toISOString，那是 UTC，晚上会差一天）
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

// ---------- 终端颜色 ----------
const C = { cyan: 36, yellow: 33, green: 32, red: 31, gray: 90, white: 37 };
const paint = (s, c) => `\u001b[${C[c]}m${s}\u001b[0m`;
const cyan = s => paint(s, 'cyan'), yellow = s => paint(s, 'yellow');
const green = s => paint(s, 'green'), red = s => paint(s, 'red');
const gray = s => paint(s, 'gray'), white = s => paint(s, 'white');

// ---------- Chrome 安装路径探测 ----------
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
];
const CHROME = CHROME_PATHS.find(p => p && fs.existsSync(p));

module.exports = {
  sleep, rnd, stamp, withoutProxy, localDate, localDateTime,
  C, paint, cyan, yellow, green, red, gray, white,
  CHROME_PATHS, CHROME,
};
