/**
 * POST /api/stop —— 停止当前任务（含 5 秒兜底强杀）
 */
module.exports = (deps) => async (req, res) => {
  const { state, broadcast, json, sendCmd, getChild } = deps;
  const ok = sendCmd('STOP');
  if (ok) {
    state.status = 'stopping';
    state.stopRequested = true;   // exit 判定用它（state.status 可能被 browser-kept 覆盖）
    broadcast({ t: 'state', status: 'stopping' });
    // 捕获目标进程：期间若有新任务启动（child 变量被替换），别误杀新进程
    const target = getChild();
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (!target || target.exitCode !== null || target.killed) { clearInterval(timer); return; }
      // 12 秒 → 5 秒：预热阶段已有 checkpoint 会立刻响应，
      // 这里的兜底强杀只留给"卡死"的极端情况，等太久用户以为没停掉
      if (Date.now() - t0 > 5000) { try { target.kill(); } catch (_) {} clearInterval(timer); }
    }, 1000);
  }
  return json(res, 200, { ok, status: state.status });
};
