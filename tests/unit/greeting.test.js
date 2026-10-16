/**
 * 离线单测：lib/greeting.js 的 isGuardUrl 判定 + 未配置 AI 时 buildGreeting 占位
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { isGuardUrl, buildGreeting } = require('../../lib/greeting');

test('isGuardUrl 命中 BOSS 风控 / 验证页特征', () => {
  assert.strictEqual(isGuardUrl('https://www.zhipin.com/passport/zp/verify.html?x=1'), true);
  assert.strictEqual(isGuardUrl('https://www.zhipin.com/passport/zp/security.html'), true);
  assert.strictEqual(isGuardUrl('https://www.zhipin.com/web/geek/job?_security_check=1'), true);
});

test('isGuardUrl 对正常职位页 / 空值返回 false', () => {
  assert.strictEqual(isGuardUrl('https://www.zhipin.com/web/geek/job?query=%E5%89%8D%E7%AB%AF'), false);
  assert.strictEqual(isGuardUrl(''), false);
  assert.strictEqual(isGuardUrl(undefined), false);
});

test('未配置 AI 时 buildGreeting 返回占位（空文本 + ai-not-configured）', async () => {
  const r = await buildGreeting('前端开发实习', 'JD 文本');
  assert.strictEqual(r.source, 'ai-not-configured');
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.score, 0);
});
