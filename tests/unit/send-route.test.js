/**
 * 离线单测：routes/send.js 的「该 HR 已在沟通」兜底
 * 用 mock deps 直接跑 handler —— 不启服务、不开浏览器、不碰真实数据。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const makeRoute = require('../../routes/send');

const DUP = 'https://job/dup';
const NORMAL = 'https://job/normal';

function harness(jobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-send-'));
  const COLLECT_FILE = path.join(dir, 'pool.json');
  fs.writeFileSync(COLLECT_FILE, JSON.stringify({ at: '', jobs }), 'utf8');
  const SEND_LIST_FILE = path.join(dir, 'list.json');
  const seen = { startChild: 0, broadcast: [] };
  const deps = {
    paths: { COLLECT_FILE, CONFIG_FILE: path.join(dir, 'config.json'), SEND_LIST_FILE },
    state: {},
    broadcast: (ev) => seen.broadcast.push(ev),
    json: (res, code, obj) => { seen.code = code; return obj; },
    startChild: async () => { seen.startChild++; },
    readJson: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } },
    writeJson: (f, o) => fs.writeFileSync(f, JSON.stringify(o), 'utf8'),
    todayCount: () => 0,
  };
  return { handler: makeRoute(deps), seen, SEND_LIST_FILE };
}

const item = (url) => ({ url, job: '岗位', company: '公司', greeting: '招呼语', jd: 'JD' });

test('全部岗位都是「已在沟通」→ 400，且不启动子进程', async () => {
  const { handler, seen } = harness([{ url: DUP, dupContact: true }]);
  const res = await handler({}, {}, { items: [item(DUP)], mode: 'fillOnly' });
  assert.strictEqual(seen.code, 400);
  assert.match(String(res.error), /已在沟通/);
  assert.strictEqual(seen.startChild, 0);
});

test('部分岗位「已在沟通」→ 只把其余的写进发送清单，并广播提示', async () => {
  const { handler, seen, SEND_LIST_FILE } = harness([{ url: DUP, dupContact: true }, { url: NORMAL }]);
  await handler({}, {}, { items: [item(DUP), item(NORMAL)], mode: 'fillOnly' });
  assert.strictEqual(seen.startChild, 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(SEND_LIST_FILE, 'utf8')).map((x) => x.url), [NORMAL]);
  assert.ok(seen.broadcast.some((e) => e.t === 'log' && /排除 1 个/.test(e.msg)), '应广播「排除」提示');
});

test('没有 dupContact 标记时，正常路径不受影响', async () => {
  const { handler, seen, SEND_LIST_FILE } = harness([{ url: NORMAL }]);
  await handler({}, {}, { items: [item(NORMAL)], mode: 'fillOnly' });
  assert.strictEqual(seen.startChild, 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(SEND_LIST_FILE, 'utf8')).map((x) => x.url), [NORMAL]);
  assert.ok(!seen.broadcast.some((e) => e.t === 'log'), '不该有多余的排除提示');
});
