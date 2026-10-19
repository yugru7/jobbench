/**
 * POST /api/reread —— 刷新候选池岗位的招聘者活跃度（维护用）
 * ----------------------------------------------------------------------------
 * 起 greet.js 的 reread 模式子进程（CDP 复用常驻 Chrome + 现有登录态），
 * 逐个重开详情页重读，只回写 active / activeRaw，不动勾选 / 招呼语 / 发送状态。
 * body.scope：
 *   "unsent"（默认）刷新所有未发送岗位的活跃度（含已有值，强制重刷）
 *   "empty"         只补活跃度为空的岗位
 * 分批大小 / 批间休息 / 单次上限在设置页配置（config.json），随子进程读取生效。
 * 进度复用采集同款事件（collect-start / collect-progress），面板可见。
 */
module.exports = (deps) => async (req, res, body) => {
  const { state, broadcast, json, startChild } = deps;
  const b = body || {};
  const scope = b.scope === 'empty' ? 'empty' : 'unsent';

  const args = ['--mode=reread'];
  // 默认（unsent）就是子进程的默认，不用传；只有 empty 需要显式指定
  if (scope === 'empty') args.push('--reread-scope=empty');

  state.phase = 'collect';   // 复用采集的进度 UI（事件也是 collect-* 那套）
  state.collectProgress = { index: 0, total: 0, current: '' };
  state.error = '';
  state.status = 'running';
  state.startedAt = Date.now();
  state.stopRequested = false;
  broadcast({ t: 'state', status: 'running' });

  try {
    await startChild(args, '刷新活跃度');
    return json(res, 200, { ok: true, scope });
  } catch (e) {
    state.status = 'idle';
    broadcast({ t: 'state', status: 'idle' });
    return json(res, 400, { ok: false, error: e.message });
  }
};
