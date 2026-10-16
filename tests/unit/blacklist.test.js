/**
 * 离线单测：lib/blacklist.js（工厂函数，用 os.tmpdir() 临时文件，测完不残留）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const makeBlacklist = require('../../lib/blacklist');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jb-bl-')), 'skip.txt');
}

test('文件不存在时返回空 Map', () => {
  const { loadSkipList } = makeBlacklist(tmpFile());
  assert.strictEqual(loadSkipList().size, 0);
});

test('markFail 累加失败次数并落盘，可被重新读回', () => {
  const f = tmpFile();
  const { loadSkipList, markFail } = makeBlacklist(f);
  const m = loadSkipList();
  markFail(m, 'https://job/1');
  markFail(m, 'https://job/1');
  markFail(m, 'https://job/2');
  const back = makeBlacklist(f).loadSkipList();
  assert.strictEqual(back.get('https://job/1'), 2);
  assert.strictEqual(back.get('https://job/2'), 1);
});

test('saveSkipList 写出 "url|次数" 且可被重新解析', () => {
  const f = tmpFile();
  const { saveSkipList, loadSkipList } = makeBlacklist(f);
  saveSkipList(new Map([['https://job/9', 3]]));
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'https://job/9|3');
  assert.strictEqual(loadSkipList().get('https://job/9'), 3);
});
