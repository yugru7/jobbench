/**
 * 招呼语提示词接口组（编辑招呼语页编辑；agent 和自动生成都按这份规则来）：
 *   GET  /api/prompt —— 读提示词（带出厂默认）
 *   POST /api/prompt —— 保存 / 恢复默认
 */
const fs = require('fs');
const path = require('path');

module.exports = (deps) => async (req, res, body) => {
  const { paths, json } = deps;

  if (req.method === 'GET') {
    // 兜底链：用户文件读不到 → 出厂默认 → 空。反馈过「面板提示词没了」，
    // 静默返回空体验极差——读失败时至少给默认版
    let text = '', dft = '';
    try { text = fs.readFileSync(paths.PROMPT_FILE, 'utf8'); } catch (_) {}
    try { dft = fs.readFileSync(paths.PROMPT_DEFAULT_FILE, 'utf8'); } catch (_) {}
    if (!text.trim()) text = dft;
    // defaultText 给面板「恢复默认」用：只填进输入框，落盘仍走「保存设置」
    return json(res, 200, { text, defaultText: dft });
  }

  const b = body;
  if (b && b.reset) {
    // 恢复默认：把出厂版本写回 greeting.md
    try {
      if (!fs.existsSync(paths.PROMPT_DEFAULT_FILE)) return json(res, 400, { ok: false, error: '找不到默认提示词文件' });
      fs.copyFileSync(paths.PROMPT_DEFAULT_FILE, paths.PROMPT_FILE);
      return json(res, 200, { ok: true, text: fs.readFileSync(paths.PROMPT_FILE, 'utf8') });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }
  const text = typeof b.text === 'string' ? b.text : '';
  if (!text.trim()) return json(res, 400, { ok: false, error: '提示词不能为空' });
  try {
    fs.mkdirSync(path.dirname(paths.PROMPT_FILE), { recursive: true });
    fs.writeFileSync(paths.PROMPT_FILE, text);
  } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  return json(res, 200, { ok: true });
};
