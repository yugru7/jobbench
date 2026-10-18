/**
 * 离线单测：lib/search.js 的纯函数（searchUrl 构造 + 源头筛选拼参）
 * 不联网、不开浏览器 —— 只调用工厂返回的纯函数。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const makeSearch = require('../../lib/search');

const CFG = { cityCode: '101010100', experience: '' };

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

// 源头筛选：config.sourceFilters 各来源条件拼进列表页 URL
// 注：不含 salary —— BOSS 薪资档位是月薪口径、对实习（日薪）无意义，已整组去掉
const CFG_FLT = {
  ...CFG,
  sourceFilters: {
    search: { multiBusinessDistrict: '110100,110200', jobType: '1902', degree: '202', scale: '302', stage: '802' },
    recommend: { jobType: '1902', degree: '202', scale: '302', stage: '802' },
    expect: { jobType: '1901', degree: '', scale: '', stage: '' },
  },
};

// 收藏源：固定收藏页 URL，不拼城市 / 经验 / 筛选参数
test('fav 源返回固定收藏页 URL，且不带 city / experience / 筛选参数', () => {
  const u = makeSearch({ ...CFG_FLT, experience: '105' }, 'fav').searchUrl('随便什么');
  assert.strictEqual(u, 'https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=1&tag=4&ka=header-username');
  assert.ok(!u.includes('city='));
  assert.ok(!u.includes('experience='));
  assert.ok(!u.includes('jobType='));
});

test('sourceFilters：search 源按 5 个键原样拼参（含区县与多选逗号）', () => {
  const u = makeSearch(CFG_FLT, 'search').searchUrl('前端');
  assert.ok(u.includes('&multiBusinessDistrict=110100,110200'));
  assert.ok(u.includes('&jobType=1902'));
  assert.ok(u.includes('&degree=202'));
  assert.ok(u.includes('&scale=302'));
  assert.ok(u.includes('&stage=802'));
});

test('sourceFilters：salary 已整组去掉，任何来源都不再拼 salary 参数', () => {
  const cfg = { ...CFG, sourceFilters: { search: { salary: '404,405' }, recommend: { salary: '404' }, expect: { salary: '404' } } };
  assert.ok(!makeSearch(cfg, 'search').searchUrl('x').includes('salary='));
  assert.ok(!makeSearch(cfg, 'recommend').searchUrl('').includes('salary='));
  assert.ok(!makeSearch(cfg, 'expect').searchUrl('').includes('salary='));
});

test('sourceFilters：recommend/expect 源不带 multiBusinessDistrict（只有 search 有）', () => {
  const rec = makeSearch(CFG_FLT, 'recommend').searchUrl('');
  assert.ok(!rec.includes('multiBusinessDistrict'));
  assert.ok(rec.includes('&jobType=1902'));
  const exp = makeSearch(CFG_FLT, 'expect').searchUrl('');
  assert.ok(!exp.includes('multiBusinessDistrict'));
  assert.ok(exp.includes('&jobType=1901'));
});

test('sourceFilters：空串 / "0"（不限）/ 非数字被剔除，残留字符被清洗', () => {
  const cfg = { ...CFG, sourceFilters: { search: { jobType: '0', degree: 'abc', scale: '30-2', stage: '802' } } };
  const u = makeSearch(cfg, 'search').searchUrl('x');
  assert.ok(!u.includes('jobType='), '0=不限 不加参数');
  assert.ok(!u.includes('degree='), 'abc 清洗成空 → 不加参数');
  assert.ok(u.includes('&scale=302'), '非数字被清洗、数字保留');
  assert.ok(u.includes('&stage=802'));
});

test('sourceFilters：无该配置时不追加任何筛参（兼容旧 config）', () => {
  const u = makeSearch(CFG, 'search').searchUrl('x');
  assert.ok(!u.includes('jobType='));
  assert.ok(!u.includes('multiBusinessDistrict='));
});

