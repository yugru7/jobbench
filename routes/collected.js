/**
 * 候选池接口组：
 *   GET  /api/collected              —— 上次收集结果（每条附 checked）
 *   POST /api/collected/clear        —— 清空候选池
 *   POST /api/collected/clear-sent   —— 清理已发送岗位
 *   POST /api/collected/delete       —— 删除指定岗位（「获取岗位」页勾选后删除）
 */
const fs = require('fs');

module.exports = (deps) => async (req, res, body) => {
  const { paths, state, readJson, writeJson, json, broadcast } = deps;
  const p = req.url.split('?')[0];

  // 删之前先留一份 .bak（删错了还能从 logs/last-collect.json.bak 捞回来）
  const backup = () => {
    try { if (fs.existsSync(paths.COLLECT_FILE)) fs.copyFileSync(paths.COLLECT_FILE, paths.COLLECT_FILE + '.bak'); } catch (_) {}
  };
  // 按 url 集合删岗位（磁盘 + 内存一起删），返回删掉的个数
  const dropByUrls = (urls) => {
    const coll = readJson(paths.COLLECT_FILE, null);
    let removed = 0;
    if (coll && Array.isArray(coll.jobs)) {
      const fresh = coll.jobs.filter(j => { if (urls.has(j.url)) { removed++; return false; } return true; });
      if (removed > 0) writeJson(paths.COLLECT_FILE, { ...coll, jobs: fresh, at: new Date().toISOString() });
    }
    state.collected = (state.collected || []).filter(j => !urls.has(j.url));
    return removed;
  };

  // ---- 上次收集结果 ----
  // 每个岗位附 checked（过二筛勾选状态，来自前端同步的副本）——
  // agent 识别「过二筛岗位」就看这个字段：checked:true 的就是要生成招呼语的
  if (req.method === 'GET') {
    const data = readJson(paths.COLLECT_FILE, { jobs: [] });
    const set = new Set(state.checkedUrls || []);
    (data.jobs || []).forEach(j => { j.checked = set.has(j.url); });
    return json(res, 200, data);
  }

  // ---- 清空候选池（合并式池子需要手动清，不然一直累积）----
  if (p === '/api/collected/clear') {
    backup();
    try { fs.unlinkSync(paths.COLLECT_FILE); } catch (_) {}
    state.collected = [];
    state.collectDone = false;
    broadcast({ t: 'collected-clear' });
    return json(res, 200, { ok: true });
  }

  // ---- 清理已发送（2026-10-12 已定：发了的大概率爬不到，从池子里移除）----
  // 只删 sent:true 的岗位（先备份 .bak），未处理的和它的招呼语/勾选保留
  if (p === '/api/collected/clear-sent') {
    backup();
    const coll = readJson(paths.COLLECT_FILE, null);
    let removed = 0, kept = 0;
    if (coll && Array.isArray(coll.jobs)) {
      const fresh = coll.jobs.filter(j => { if (j.sent) { removed++; return false; } kept++; return true; });
      if (removed > 0) writeJson(paths.COLLECT_FILE, { ...coll, jobs: fresh, at: new Date().toISOString() });
    }
    state.collected = (state.collected || []).filter(j => !j.sent);
    broadcast({ t: 'sent-cleared', removed, kept });
    return json(res, 200, { ok: true, removed, kept });
  }

  // ---- 删除指定岗位（2026-10-16 加：「获取岗位」页勾选后点删除）----
  // 与 clear-sent 不同：这里不看 sent，勾了哪几个就删哪几个（面板上就是这么用的）
  if (p === '/api/collected/delete') {
    const urls = Array.isArray(body.urls) ? body.urls.filter(u => typeof u === 'string' && u) : null;
    if (!urls || !urls.length) return json(res, 400, { ok: false, error: 'urls 必须是非空字符串数组' });
    const set = new Set(urls);
    backup();
    const removed = dropByUrls(set);
    broadcast({ t: 'candidates-deleted', urls: [...set] });
    return json(res, 200, { ok: true, removed });
  }

  return json(res, 404, { ok: false, error: '未知的候选池操作' });
};
