/**
 * 离线单测：lib/utils.js 的 rnd / localDate / withoutProxy
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { rnd, localDate, withoutProxy } = require('../../lib/utils');

test('rnd 落在闭区间内、为整数、边界可取', () => {
  for (let i = 0; i < 200; i++) {
    const v = rnd(3, 7);
    assert.ok(v >= 3 && v <= 7);
    assert.ok(Number.isInteger(v));
  }
  assert.strictEqual(rnd(5, 5), 5);                 // a===b 退化
  assert.ok([1, 2].includes(rnd(1, 2)));
});

test('localDate 是本地 YYYY-MM-DD，与本地年月日一致', () => {
  const s = localDate();
  assert.match(s, /^\d{4}-\d{2}-\d{2}$/);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  assert.strictEqual(s, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
});

test('withoutProxy 执行期间摘掉代理，用完恢复', async () => {
  process.env.HTTP_PROXY = 'http://proxy.local:8080';
  delete process.env.ALL_PROXY;
  const inside = await withoutProxy(() => process.env.HTTP_PROXY);
  assert.strictEqual(inside, undefined);                                  // 期间已摘除
  assert.strictEqual(process.env.HTTP_PROXY, 'http://proxy.local:8080');  // 用完恢复
  assert.strictEqual(process.env.ALL_PROXY, undefined);                   // 原不存在的不会被填成 "undefined"
  delete process.env.HTTP_PROXY;
});

test('withoutProxy 回调抛错时也恢复代理', async () => {
  process.env.HTTPS_PROXY = 'http://p:1';
  await assert.rejects(withoutProxy(() => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(process.env.HTTPS_PROXY, 'http://p:1');
  delete process.env.HTTPS_PROXY;
});
