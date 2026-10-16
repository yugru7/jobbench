/**
 * POST /api/expects —— 「来源：意向页签」第一步：读 BOSS 账号里勾选的求职方向列表
 * ----------------------------------------------------------------------------
 * 结果通过 SSE 事件 t:'expects' 回传界面渲染成 chips
 */
module.exports = (deps) => async (req, res, body) => {
  const { state, broadcast, json, startChild, loadExpectsCache } = deps;
  const b = body;
  // 方向列表长期不变 → 有缓存直接回放（毫秒级，不开浏览器）。
  // 手动刷新：界面「刷新方向」链接带 force 真读一次并更新缓存。
  if (!b.force) {
    const c = loadExpectsCache();
    if (c && Array.isArray(c.tabs) && c.tabs.length) {
      state.expects = c.tabs;
      broadcast({ t: 'expects', tabs: c.tabs, fromCache: true, cachedAt: c.at });
      return json(res, 200, { ok: true, fromCache: true, count: c.tabs.length, cachedAt: c.at });
    }
  }
  state.status = 'running';
  state.error = '';
  state.stopRequested = false;   // 新任务：重置停止标记
  // 【2026-10-13 修】设了状态必须广播，否则前端仍以为空闲 —— 「停止」按钮停在
  // 初始禁用态点不了（实测：爬取中鼠标是圈斜线、点了没反应）
  broadcast({ t: 'state', status: 'running' });
  try {
    await startChild(['--mode=expects'], '读取意向方向');
    return json(res, 200, { ok: true });
  } catch (e) {
    state.status = 'idle';
    broadcast({ t: 'state', status: 'idle' });
    return json(res, 400, { ok: false, error: e.message });
  }
};
