/**
 * POST /api/greetings —— agent 写回招呼语（面板实时刷新）
 * ----------------------------------------------------------------------------
 * 用户自己的 AI agent 按 prompts/greeting.md 生成招呼语后，从这里写回来：
 *   { items: [{ url, greeting }] }
 */
module.exports = (deps) => async (req, res, body) => {
  const { paths, state, readJson, writeJson, broadcast, json } = deps;
  const b = body;
  const items = Array.isArray(b.items)
    ? b.items.filter(x => x && x.url && typeof x.greeting === 'string' && x.greeting.length <= 500)   // 超长招呼语 BOSS 会拒，直接拒收该条
    : [];
  if (!items.length) return json(res, 400, { ok: false, error: 'items 不能为空，格式 [{url, greeting}]' });
  // 1) 写进 last-collect.json（持久化）
  const coll = readJson(paths.COLLECT_FILE, null);
  let updated = 0;
  if (coll && Array.isArray(coll.jobs)) {
    for (const it of items) {
      const job = coll.jobs.find(j => j.url === it.url);
      if (job) { job.greeting = it.greeting; updated++; }
    }
    writeJson(paths.COLLECT_FILE, coll);
  }
  // 2) 同步内存 + 推给面板（实时刷新，不用整页重载）
  for (const it of items) {
    const j = state.collected.find(x => x.url === it.url);
    if (j) j.greeting = it.greeting;
    broadcast({ t: 'greeting-update', url: it.url, greeting: it.greeting });
  }
  return json(res, 200, { ok: true, updated, total: items.length });
};
