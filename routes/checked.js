/**
 * POST /api/checked —— 勾选同步（前端 localStorage 为事实源，这里只做 agent 可读的副本）
 * ----------------------------------------------------------------------------
 * agent 智能二筛（评分+勾选）也走这个接口 —— 广播 checked-sync 让面板实时跟着变
 */
module.exports = (deps) => async (req, res, body) => {
  const { paths, state, writeJson, broadcast, json } = deps;
  const b = body;
  const urls = Array.isArray(b.urls) ? b.urls.filter(u => typeof u === 'string' && u) : null;
  if (!urls) return json(res, 400, { ok: false, error: 'urls 必须是字符串数组' });
  state.checkedUrls = [...new Set(urls)];
  try { writeJson(paths.CHECKED_FILE, { at: new Date().toISOString(), urls: state.checkedUrls }); } catch (_) {}
  broadcast({ t: 'checked-sync', urls: state.checkedUrls });
  return json(res, 200, { ok: true, count: state.checkedUrls.length });
};
