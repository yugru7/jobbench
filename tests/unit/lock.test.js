/**
 * 离线单测：lib/lock.js（工厂函数，用 os.tmpdir() 临时目录，测完不残留）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const makeLock = require('../../lib/lock');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jb-lock-'));
}

test('acquireLock 递归建目录并写入当前 pid', () => {
  const dir = path.join(tmpDir(), 'nested', 'profile');
  const { acquireLock } = makeLock(dir);
  assert.deepStrictEqual(acquireLock(), { ok: true });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'greet.lock'), 'utf8'), String(process.pid));
});

test('releaseLock 只删除属于自己的锁文件', () => {
  const dir = tmpDir();
  const { acquireLock, releaseLock } = makeLock(dir);
  acquireLock();
  releaseLock();
  assert.strictEqual(fs.existsSync(path.join(dir, 'greet.lock')), false);   // 自己的锁被删
  fs.writeFileSync(path.join(dir, 'greet.lock'), '4294967290');             // 别的 pid 的锁
  releaseLock();
  assert.strictEqual(fs.existsSync(path.join(dir, 'greet.lock')), true);    // 不会被误删
});
