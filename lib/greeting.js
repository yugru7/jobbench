/**
 * 招呼语生成（AI 唯一路径，已定：不做无 AI 降级）
 * ----------------------------------------------------------------------------
 * 每条招呼语按岗位 JD 定制，必须调大模型 —— 这个工具就是要结合 AI 提效的，
 * 没配 AI 接口就不出招呼语（collect 仍可跑，用于看岗位/JD/活跃度）。
 * TODO(下一步)：接入大模型 API（prompt 草案已提交审阅，确认后实现；调用方已按异步写好）
 */
async function buildGreeting(jobTitle, jdText) {
  return { text: '', matchedName: '', score: 0, source: 'ai-not-configured' };
}

// BOSS 风控/验证页 URL 特征（匹配到说明撞上安全检查，要停手）
function isGuardUrl(u) {
  return /passport\/zp\/(verify|security)\.html|_security_check=/.test(u || '');
}

module.exports = { buildGreeting, isGuardUrl };
