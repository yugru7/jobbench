/**
 * 离线单测：lib/knowledge.js 的 normalizeEntries 归一化 / 容错
 * 用 os.tmpdir() 作目录（无 knowledge.json），只测纯归一化函数。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const makeKnowledge = require('../../lib/knowledge');

const { normalizeEntries } = makeKnowledge(os.tmpdir());

test('新格式 {title,content} 原样返回（同一引用，不改写）', () => {
  const src = [{ title: 't', content: '正文' }];
  const out = normalizeEntries(src);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0], src[0]);
});

test('旧格式 highlights 合并成一段内容（role：summary 打头）', () => {
  const out = normalizeEntries([{
    title: '实习', role: '前端', summary: '某公司',
    highlights: [{ text: 'A' }, { text: 'B' }, { text: '' }],
  }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, '实习');
  assert.strictEqual(out[0].content, '前端：某公司\nA\nB');
});

test('空值 / 缺字段容错：不抛错，返回空数组', () => {
  assert.deepStrictEqual(normalizeEntries(undefined), []);
  assert.deepStrictEqual(normalizeEntries(null), []);
  assert.deepStrictEqual(normalizeEntries([]), []);
});

test('内容为空白的条目被过滤掉', () => {
  const out = normalizeEntries([{ content: '   ' }, { content: '有效' }, { title: 'x' }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].content, '有效');
});

test('highlights 里缺 text / 空 text 的项被剔除', () => {
  const out = normalizeEntries([{ title: 't', highlights: [{ text: 'A' }, {}, { text: '' }, { text: 'B' }] }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].content, 'A\nB');
});

test('类型不对的输入不抛错：entries 非数组 / 元素非对象 / highlights 非数组', () => {
  assert.deepStrictEqual(normalizeEntries('不是数组'), []);
  assert.deepStrictEqual(normalizeEntries({ a: 1 }), []);
  assert.deepStrictEqual(normalizeEntries([null, 42, 'str']), []);
  // highlights 是"非数组真值"（字符串 / 对象）时要兜住，而不是抛 TypeError
  assert.strictEqual(normalizeEntries([{ title: 't', highlights: '字符串' }]).length, 0);
  assert.strictEqual(normalizeEntries([{ title: 't', highlights: { text: 'x' } }]).length, 0);
});
