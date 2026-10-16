/**
 * 经历库接口组：
 *   GET  /api/knowledge —— 读知识库（首次使用载入示例）
 *   POST /api/knowledge —— 写回知识库（body = 完整 knowledge.json）
 */
const fs = require('fs');

module.exports = (deps) => async (req, res, body) => {
  const { paths, readJson, writeJson, json, broadcast } = deps;

  if (req.method === 'GET') {
    // 首次使用（没有 knowledge.json）→ 载入示例，让新用户直接看到该怎么填；
    // 带 _isExample 标记，界面会提示"这是示例，请改成你自己的"
    let k = readJson(paths.KNOWLEDGE_FILE, null);
    if (!k) {
      const ex = readJson(paths.KNOWLEDGE_EXAMPLE_FILE, null);
      if (ex) k = { ...ex, _isExample: true };
    }
    return json(res, 200, k || { profile: {}, tone: {}, entries: [] });
  }

  if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: '内容格式不对' });
  try { if (fs.existsSync(paths.KNOWLEDGE_FILE)) fs.copyFileSync(paths.KNOWLEDGE_FILE, paths.KNOWLEDGE_FILE + '.bak'); } catch (_) {}
  writeJson(paths.KNOWLEDGE_FILE, body);
  broadcast({ t: 'knowledge-saved' });
  return json(res, 200, { ok: true });
};
