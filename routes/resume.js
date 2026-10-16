/**
 * POST /api/resume —— 继续当前任务
 */
module.exports = (deps) => async (req, res) => {
  const { state, broadcast, json, sendCmd } = deps;
  const ok = sendCmd('RESUME');
  if (ok) { state.status = 'running'; broadcast({ t: 'state', status: 'running' }); }
  return json(res, 200, { ok, status: state.status });
};
