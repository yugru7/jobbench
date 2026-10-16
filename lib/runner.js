/**
 * 子进程编排：启动 / 停止 greet.js，接收 IPC 事件喂给 handleEvent
 * ----------------------------------------------------------------------------
 * 从 server.js 拆出的基础模块，持有子进程句柄：
 *   · child / starting / childAlive()：当前子进程
 *   · startChild(extraArgs, label)：拉起 greet.js 并接管其 stdout/stderr/exit
 *   · sendCmd(cmd) / stopChildAsync()：向子进程写指令 / 等它退出
 *   · killKeptBrowser()：任务后强杀占着 profile 的浏览器
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

module.exports = (deps) => {
  const { state, broadcast, handleEvent, nextRunId, paths, DIR, NODE, IPC_MARK, readJson } = deps;

  // ---------- 子进程 ----------
  let child = null;
  let starting = false;    // 启动动作进行中（防连点：两次请求间隔极短时都看到 childAlive()==false，会双开）
  const childAlive = () => !!child && !child.killed && child.exitCode === null;

  async function startChild(extraArgs, label) {
    if (starting) throw new Error('正在启动中，别连点，稍等一两秒');
    starting = true;
    try {
      // 上一个任务的浏览器还开着的话（子进程还活着），先把它收掉。
      // 【必须异步等】之前用 Atomics.wait 同步等 8~11 秒，事件循环整个被冻住：
      // SSE 断、所有按钮没响应 —— 界面上就是"点了卡住"。这是"任务结束浏览器保持
      // 开着"成为常态后的必经路径（每次开始新任务都要先收旧的）。
      if (childAlive()) {
        broadcast({ t: 'log', tag: '·', msg: '正在收掉上一个任务，几秒钟…', ts: new Date().toTimeString().slice(0, 8) });
        await stopChildAsync();
      }
      if (childAlive()) throw new Error('上一个任务还没退出，稍等几秒再试');

      // 【A + 同标签翻页 2026-10-16】面板发起的任务统一走 CDP 模式：
      // 复用常驻的调试 Chrome + 已有的 BOSS 标签页，每一轮只是就地翻页 ——
      // 浏览器窗口不再"关掉再重开"（又快，又更像真人反复操作同一个窗口）。
      // 命令行手敲 `node greet.js` 不受影响，仍是独立模式（默认不带这个参数）。
      const args = ['greet.js', '--ipc', '--no-pause', '--use-cdp', ...extraArgs];
      nextRunId();
      const readable = ['node', 'greet.js', ...extraArgs].join(' ');

      child = spawn(NODE, args, { cwd: DIR, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      // 【2026-10-13 修】闭包捕获本次 spawn 的进程：exit 回调里读的 child 变量会指向
      // 后来的进程 —— 上一个任务迟到的 exit 事件会把新任务的 running 覆盖成 idle
      // （实测：新任务 startedAt 与 finishedAt 同一秒，界面显示空闲但任务在跑，
      //  按钮状态全乱）
      const thisChild = child;

      // 【2026-10-13 修2】闭包检查挡不住另一种时序：收旧进程（上面的 stopChildAsync）
      // 期间旧进程退出，它的 exit 回调**当场**执行 —— 那一刻 child 还是旧进程、
      // thisChild 也是旧进程，检查通过 → 状态被覆盖成 idle 并写 finishedAt；等新进程
      // 就位时已经晚了。浏览器保持开着成为常态后，每次新任务都会命中（实测日志：旧
      // 进程 10:06:21 收到关闭指令退出，新任务界面显示空闲但实际在跑）。
      // 新进程已就位，这里把状态校正回「运行中」。
      state.status = 'running';
      state.finishedAt = null;
      state.error = '';
      broadcast({ t: 'state', status: 'running' });

      const readline = require('readline');
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.startsWith(IPC_MARK)) return;
        let ev;
        try { ev = JSON.parse(line.slice(IPC_MARK.length)); } catch (_) { return; }
        handleEvent(ev);
      });

      child.stderr.on('data', (buf) => {
        const txt = buf.toString('utf8').trim();
        if (txt) broadcast({ t: 'log', tag: 'ERR', msg: txt.slice(0, 400), ts: new Date().toTimeString().slice(0, 8) });
      });

      child.on('exit', (code) => {
        if (child !== thisChild) return;   // 迟到的旧进程退出事件：忽略，别覆盖新任务的状态
        // 【2026-10-13 修】判断"是否用户主动停止"不能只看 state.status ——
        // 子进程停止后会发 browser-kept（把状态设回 idle），5 秒兜底强杀时
        // state.status 早已不是 stopping，被误判成 error（实测：点了停止，
        // 任务停了但状态显示「出错了」）。改看本次运行是否收到过停止指令。
        const wasStopping = state.status === 'stopping' || state.stopRequested;
        // 【2026-10-13 修】用户主动停止（stopping）是正常结束，不该显示「出错了」——
        // 强杀时 exit code 是 null，原来一律判 error（实测：点停止后状态变出错）
        state.status = (wasStopping || code === 0) ? 'idle' : 'error';
        state.finishedAt = Date.now();
        if (code !== 0 && !wasStopping && !state.error) state.error = `脚本退出码 ${code}`;
        state.awaiting = null;
        broadcast({ t: 'run-exit', code, stopped: wasStopping, status: state.status, label });
        child = null;
      });

      child.on('error', (e) => {
        state.status = 'error';
        state.error = e.message;
        broadcast({ t: 'log', tag: 'ERR', msg: '启动失败：' + e.message, ts: new Date().toTimeString().slice(0, 8) });
        child = null;
      });

      broadcast({ t: 'run-started', label, mode: state.phase });
      return readable;
    } finally {
      starting = false;
    }
  }

  function sendCmd(cmd) {
    if (!childAlive()) return false;
    try { child.stdin.write(cmd + '\n'); return true; } catch (_) { return false; }
  }

  // 异步等待子进程退出，不阻塞事件循环（替代旧的 Atomics.wait 同步版）
  function stopChildAsync() {
    return new Promise((resolve) => {
      if (!childAlive()) return resolve(true);
      try { child.stdin.write('STOP\n'); } catch (_) {}
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (!childAlive()) { clearInterval(timer); return resolve(true); }
        if (Date.now() - t0 > 8000) {
          clearInterval(timer);
          try { child.kill(); } catch (_) {}
          // kill() 后 exitCode 不会立刻置上，再等一小会儿
          const t1 = Date.now();
          const timer2 = setInterval(() => {
            if (!childAlive()) { clearInterval(timer2); return resolve(true); }
            if (Date.now() - t1 > 3000) { clearInterval(timer2); return resolve(false); }
          }, 150);
        }
      }, 200);
    });
  }

  // 关掉"任务结束后保持开着"的那个浏览器（只杀用我们 profile 的，不动你日常的 Chrome）
  function killKeptBrowser() {
    const profRaw = readJson(paths.CONFIG_FILE, {}).profileDir || '.chrome-profile';
    const prof = String(path.isAbsolute(profRaw) ? profRaw : path.resolve(DIR, profRaw));
    try {
      const psFile = path.join(paths.LOG_DIR, '_kill-kept.ps1');
      // 【2026-10-16 重要】这个 .ps1 必须带 UTF-8 BOM：PowerShell 5.1 读「无 BOM 的 .ps1」
      // 时按系统 ANSI 代码页（中文 Windows 上是 GBK）解码 —— 项目路径里只要带中文
      // （例如 D:\...\求职助手\.chrome-profile），$prof 就变成乱码、.Contains() 永远匹配
      // 不上，于是「关闭浏览器」静默返回 closed:false 而 Chrome 还活着。实测：无 BOM 匹配
      // 到 0 个进程，带 BOM 匹配到 8 个。
      // 注意：这与「HTTP 写回接口的 body 绝不能带 BOM」是两回事（那个会静默清空数据）——
      // 判据是"谁来读这个文件"：HTTP 走 JSON.parse（怕 BOM）；PowerShell 5.1 走 ANSI（缺 BOM 就乱码）。
      fs.writeFileSync(psFile, '\uFEFF' + [
        `$hit = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |`,
        `  Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${prof.replace(/'/g, "''")}') }`,
        `$n = ($hit | Measure-Object).Count`,
        `$hit | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        `Write-Output $n`,
      ].join('\r\n'), 'utf8');
      const out = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${psFile}"`,
        { encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'ignore'] });
      return parseInt(String(out).trim(), 10) || 0;
    } catch (_) { return 0; }
  }

  function getChild() { return child; }

  return { startChild, sendCmd, stopChildAsync, childAlive, getChild, killKeptBrowser };
};
