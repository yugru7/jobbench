/**
 * 离线单测：lib/search.js 的纯函数（searchUrl 构造 + isInternTitle 判定）
 * 不联网、不开浏览器 —— 只调用工厂返回的纯函数。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const makeSearch = require('../../lib/search');

const CFG = { cityCode: '101010100', requireInTitle: ['实习'], experience: '' };

test('search 源：关键词被 URL 编码并带上城市', () => {
  const { searchUrl } = makeSearch(CFG, 'search');
  const u = searchUrl('前端开发 实习');
  assert.ok(u.includes('query=%E5%89%8D%E7%AB%AF%E5%BC%80%E5%8F%91%20%E5%AE%9E%E4%B9%A0'));
  assert.ok(u.includes('city=101010100'));
  assert.ok(!u.includes('query=前端'));   // 未编码即为回归
});

test('search 源：关键词里的 & 会被编码，不会多出一个 city 参数', () => {
  const { searchUrl } = makeSearch(CFG, 'search');
  const u = searchUrl('a&city=xxx');
  assert.ok(u.includes('query=a%26city%3Dxxx'));
  assert.strictEqual((u.match(/city=/g) || []).length, 1);
});

test('recommend 源不带 query；expect 源走 /jobs 落地页', () => {
  const rec = makeSearch(CFG, 'recommend').searchUrl('');
  assert.ok(!rec.includes('query='));
  assert.ok(rec.includes('/web/geek/job?'));
  const exp = makeSearch(CFG, 'expect').searchUrl('');
  assert.ok(exp.includes('/web/geek/jobs?'));
});

test('experience 有值时追加参数，无值时不追加', () => {
  const withExp = makeSearch({ ...CFG, experience: '202' }, 'search').searchUrl('x');
  assert.ok(withExp.endsWith('&experience=202'));
  const without = makeSearch(CFG, 'search').searchUrl('x');
  assert.ok(!without.includes('experience='));
});

test('isInternTitle：命中标题词才通过，空白名单全通过', () => {
  const { isInternTitle } = makeSearch(CFG, 'search');
  assert.strictEqual(isInternTitle('前端开发实习'), true);
  assert.strictEqual(isInternTitle('前端开发工程师'), false);
  assert.strictEqual(isInternTitle(undefined), false);
  assert.strictEqual(makeSearch({ ...CFG, requireInTitle: [] }, 'search').isInternTitle('社招岗'), true);
});
