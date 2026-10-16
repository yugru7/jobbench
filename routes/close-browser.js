/**
 * POST /api/close-browser —— 关闭「任务结束后保持开着」的浏览器
 */
module.exports = (deps) => async (req, res) => {
  const { state, broadcast, json, sendCmd, childAlive, killKeptBrowser, getChild } = deps;
  let closed = false;
  if (childAlive()) {
    closed = sendCmd('CLOSE');
    // 等它自己退出（同样捕获目标进程，避免误杀期间新启动的任务）
    const target = getChild();
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (!target || target.exitCode !== null || target.killed) { clearInterval(timer); return; }
      if (Date.now() - t0 > 10000) { try { target.kill(); } catch (_) {} clearInterval(timer); }
    }, 800);
  } else {
    const n = killKeptBrowser();
    closed = n > 0;
    state.browserOpen = false;
    broadcast({ t: 'browser-closed' });
  }
  return json(res, 200, { ok: true, closed });
};
