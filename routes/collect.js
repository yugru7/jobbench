/**
 * POST /api/collect —— 阶段一：收集（读 JD + 活跃度 + 生成招呼语，不发任何消息）
 */
const fs = require('fs');

module.exports = (deps) => async (req, res, body) => {
  const { paths, state, broadcast, json, startChild, readJson, localDate } = deps;
  const b = body;
  // ---- 每日爬取上限（2026-10-13 设置页开放）----
  // 单次数量钳制（≤30）+「今日已爬 + 本次 ≤ dailyCollectCap」：
  // 超出自动收窄，已满直接拒绝（放在设「运行中」之前，拒绝时状态不动）
  const capCfg = readJson(paths.CONFIG_FILE, {});
  const dCap = Math.min(Math.max(parseInt(capCfg.dailyCollectCap, 10) || 80, 1), 300);
  let runMaxJobs = Math.min(Math.max(parseInt(b.maxJobs, 10) || parseInt(capCfg.maxJobsPerRun, 10) || 10, 1), 30);
  let todayCollected = 0;
  try {
    const st = JSON.parse(fs.readFileSync(paths.STATS_FILE, 'utf8'));
    todayCollected = (st.collect && st.collect.daily && st.collect.daily[localDate()]) || 0;
  } catch (_) {}
  if (todayCollected >= dCap) {
    return json(res, 400, { ok: false, error: `今日爬取已达上限（${todayCollected}/${dCap}）。明天再爬，或到「设置」页调高上限` });
  }
  if (todayCollected + runMaxJobs > dCap) {
    const left = dCap - todayCollected;
    broadcast({ t: 'log', tag: '·', msg: `今日爬取还剩 ${left} 个额度（上限 ${dCap}），本次自动收窄为 ${left} 个`, ts: new Date().toTimeString().slice(0, 8) });
    runMaxJobs = left;
  }

  state.phase = 'collect';
  state.collected = [];
  state.collectProgress = { index: 0, total: 0, current: '' };
  state.error = '';
  state.status = 'running';
  state.startedAt = Date.now();
  state.stopRequested = false;   // 新任务：重置停止标记
  // 【2026-10-13 修】设了状态必须广播（同 /api/expects 的注释：漏广播 →
  // 前端按钮停在初始禁用态，「停止」点不了）
  broadcast({ t: 'state', status: 'running' });

  const args = ['--mode=collect'];
  // 参数钳制（2026-10-12 安全审计）：单次爬取 ≤30 个、关键词 ≤10 个 ——
  // 防agent/API 误传大参数导致长时间高频操作 BOSS（风控风险）；
  // 数量已在上面的「每日爬取上限」检查中定稿（runMaxJobs）
  args.push('-n', String(runMaxJobs));
  if (b.source === 'recommend' || b.source === 'expect') args.push(`--source=${b.source}`);
  if (b.source === 'expect' && b.expectTab) args.push('--expect-tab', String(b.expectTab));
  else if (b.source !== 'recommend' && b.source !== 'expect' && Array.isArray(b.keywords) && b.keywords.length) {
    args.push('--keywords', b.keywords.slice(0, 10).join(','));
  }
  if (b.cityCode) args.push('--city-code', String(b.cityCode));
  if (b.cityName) args.push('--city-name', String(b.cityName));
  state.cityName = b.cityName || '';

  try {
    await startChild(args, '收集岗位');
    return json(res, 200, { ok: true });
  } catch (e) {
    state.status = 'idle';
    broadcast({ t: 'state', status: 'idle' });
    return json(res, 400, { ok: false, error: e.message });
  }
};
