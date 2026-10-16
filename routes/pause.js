/**
 * POST /api/pause —— 暂停当前任务
 */
module.exports = (deps) => async (req, res) => {
  const { state, broadcast, json, sendCmd } = deps;
  const ok = sendCmd('PAUSE');
  if (ok) { state.status = 'paused'; broadcast({ t: 'state', status: 'paused' }); }
  return json(res, 200, { ok, status: state.status });
};
