// 关键问题验证：launchPersistentContext 启动的 Chrome，
// 在父 Node 进程退出后会不会跟着死？
// 结论写到 logs/test-persist.txt
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..');
const LOG_DIR = path.join(DIR, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
].find(p => p && fs.existsSync(p));

const ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const lines = [];
const P = (s) => { lines.push(s); console.log(s); };

// 用 PowerShell 数一下有多少 chrome 进程用的是我们的测试 profile
function countChrome(profileTag) {
  try {
    const ps = `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profileTag}') } | Measure-Object).Count`;
    const { execSync } = require('child_process');
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 20000 });
    return parseInt(String(out).trim(), 10) || 0;
  } catch (e) { return -1; }
}

(async () => {
  P('=== 浏览器存活测试 ===');
  P(`Chrome: ${CHROME}`);

  const prof = path.join(require('os').tmpdir(), 'persist-test-' + Date.now());
  const tag = 'persist-test-';          // 命令行里会出现这个片段

  const { chromium } = require('patchright');
  const ctx = await chromium.launchPersistentContext(prof, {
    executablePath: CHROME, headless: false, viewport: null,
    args: ARGS, ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = await ctx.newPage();
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(1500);

  P(`启动后，用我们 profile 的 chrome 进程数: ${countChrome(tag)}`);
  P(`profile: ${prof}`);

  // 把 profile 路径写出来给外部脚本用
  fs.writeFileSync(path.join(LOG_DIR, '_persist-probe.txt'), prof, 'utf8');

  P('');
  P('现在**故意不调 ctx.close()**，直接 process.exit(0) —— 看浏览器会不会跟着死');
  P('（这是本次测试的核心问题）');
  fs.writeFileSync(path.join(LOG_DIR, 'test-persist.txt'), lines.join('\n'), 'utf8');

  // 关键：不关浏览器，直接退出
  process.exit(0);
})().catch(e => {
  P('FATAL ' + e.message);
  try { fs.writeFileSync(path.join(LOG_DIR, 'test-persist.txt'), lines.join('\n'), 'utf8'); } catch (_) {}
  process.exit(1);
});
