/**
 * POST /api/send —— 阶段二：发送
 * ----------------------------------------------------------------------------
 * 安全护栏（2026-10-12 审计）：
 *   ① mode=auto（全自动点发送）必须带 userApproved:true —— 只有面板上用户
 *      亲自在确认弹窗点了「确定」才带；agent 按 AGENTS.md 只能用 fillOnly/confirm
 *   ② 数量双保险：硬顶 60 条 + 按「今日剩余额度」截断（todayCount 已发的不算）
 */
module.exports = (deps) => async (req, res, body) => {
  const { paths, state, broadcast, json, startChild, readJson, writeJson, todayCount } = deps;
  const b = body;
  let items = Array.isArray(b.items) ? b.items.filter(x => x && x.url) : [];
  if (!items.length) return json(res, 400, { ok: false, error: '没有勾选任何岗位' });

  const mode = b.mode || 'fillOnly';    // fillOnly | confirm | auto
  if (!['fillOnly', 'confirm', 'auto'].includes(mode)) {
    return json(res, 400, { ok: false, error: `未知 mode: ${mode}` });
  }
  if (mode === 'auto' && b.userApproved !== true) {
    return json(res, 403, { ok: false, error: '自动发送必须由用户本人批准（面板确认弹窗）。agent 请用 fillOnly（只填不发）或 confirm（逐条确认）。' });
  }
  // 数量护栏：先硬顶，再按今日剩余额度截断（fillOnly 也限 —— 填太多同样有风控风险）
  items = items.slice(0, 60);
  const cap = readJson(paths.CONFIG_FILE, {}).dailyCap || 40;
  const remaining = Math.max(0, cap - todayCount());
  let capped = false;
  if (items.length > remaining) {
    capped = true;
    items = items.slice(0, remaining);
  }
  if (!items.length) {
    return json(res, 400, { ok: false, error: `今日额度已用完（${todayCount()}/${cap}），明天再跑或调高 config 的 dailyCap` });
  }
  writeJson(paths.SEND_LIST_FILE, items);

  state.phase = 'send';
  state.error = '';
  state.status = 'running';
  state.startedAt = Date.now();
  state.awaiting = null;
  state.sendMode = mode;
  state.stopRequested = false;   // 新任务：重置停止标记
  // 【2026-10-13 修】设了状态必须广播（同上：漏广播 → 「停止」按钮点不了）
  broadcast({ t: 'state', status: 'running' });
  state.sendProgress = { index: 0, total: items.length, sent: 0, skipped: 0, failed: 0, filled: 0, current: '', company: '' };

  const args = ['--mode=send', '--send-list', paths.SEND_LIST_FILE];
  if (mode === 'fillOnly') args.push('--fill-only');
  try {
    await startChild(args, mode === 'fillOnly' ? '只填不发' : (mode === 'confirm' ? '逐条确认发送' : '一键发送'));
    broadcast({ t: 'send-capped', capped, kept: items.length, remaining });
    return json(res, 200, { ok: true, mode, count: items.length, capped, remaining });
  } catch (e) {
    state.status = 'idle';
    broadcast({ t: 'state', status: 'idle' });
    return json(res, 400, { ok: false, error: e.message });
  }
};
