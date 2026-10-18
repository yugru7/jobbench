/**
 * POST /api/open-browser —— 用「任务同款浏览器」打开 BOSS直聘（供你自己上手用）
 * ----------------------------------------------------------------------------
 * 与 /api/close-browser 互为反向：那个只管关，这个只管开。
 *   · 已有子进程在跑 → 不再另起一个（浏览器本来就是开着的、正被任务用），直接回「已在运行」
 *   · 否则 spawn `--mode=open`：复用/启动常驻调试 Chrome，停在 BOSS 首页；子进程做完即退，
 *     Chrome 是 detached 起的、不跟着退，窗口留在屏幕上给你用
 * 用的是同一个 profile（config.profileDir）⇒ 登录态就落在那份目录里，关掉浏览器/面板都不丢，
 *   下次任务照旧复用同一份登录态。
 * 不触发任何采集/发送，不消耗额度。
 */
module.exports = (deps) => async (req, res) => {
  const { json, childAlive, startChild } = deps;
  if (childAlive()) {
    return json(res, 200, {
      ok: true, opened: false, reused: true,
      note: '浏览器已经在运行（当前任务正在用它），不用另开',
    });
  }
  try {
    await startChild(['--mode=open'], '打开 BOSS');
    return json(res, 200, { ok: true, opened: true, reused: false });
  } catch (e) {
    return json(res, 400, { ok: false, error: e.message });
  }
};
