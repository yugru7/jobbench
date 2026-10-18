/**
 * 清理上次遗留的浏览器（只杀用我们 profile 的 chrome.exe）
 * ----------------------------------------------------------------------------
 * 因为任务结束后浏览器是「保持开着」的，下次启动前必须先把它关掉，
 * 否则 profile 被占用，新的浏览器起不来。
 * 只杀命令行里带我们这个 profile 路径的 chrome.exe —— 你自己日常的 Chrome 不受影响。
 *
 * 用法：const { killChromeUsingProfile } = require('./lib/chrome-kill')(CFG.profileDir, LOG_DIR);
 */
const fs = require('fs');
const path = require('path');

module.exports = (profileDir, logDir) => {
  function killChromeUsingProfile() {
    if (process.platform !== 'win32') return 0;
    try {
      const psFile = path.join(logDir, '_kill-chrome.ps1');
      const prof = profileDir.replace(/'/g, "''");
      // 必须带 UTF-8 BOM —— PowerShell 5.1 读「无 BOM 的 .ps1」时按系统
      // ANSI 代码页（中文 Windows 上是 GBK）解码，路径里的中文会变乱码，.Contains($prof)
      // 永远匹配不上 → 一个 Chrome 都杀不掉（静默返回 0）。实测无 BOM 匹配 0 个、带 BOM 匹配 8 个。
      // 这与「HTTP body 不能带 BOM」不冲突：判据是"谁读这个文件"（JSON.parse 怕 BOM，PS 5.1 缺 BOM 就乱码）。
      fs.writeFileSync(psFile, '\uFEFF' + [
        `$prof = '${prof}'`,
        `$hit = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |`,
        `  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($prof) }`,
        `$n = ($hit | Measure-Object).Count`,
        `$hit | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        `Write-Output $n`,
      ].join("\r\n"), 'utf8');

      const out = require('child_process').execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`,
        { encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      return parseInt(String(out).trim(), 10) || 0;
    } catch (_) { return 0; }
  }

  return { killChromeUsingProfile };
};
