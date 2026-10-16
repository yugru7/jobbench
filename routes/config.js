/**
 * 方向管理（config）接口组：
 *   GET  /api/config —— 设置页读取（返回可调参数当前值）
 *   POST /api/config —— 保存设置（含值域钳制）
 */
module.exports = (deps) => async (req, res, body) => {
  const { paths, readJson, writeJson, json, settingsView } = deps;

  // 设置页读取（2026-10-13）：返回可调参数当前值（进设置页/保存后刷新用）
  if (req.method === 'GET') {
    return json(res, 200, { config: settingsView(readJson(paths.CONFIG_FILE, {})) });
  }

  const b = body;
  // 值域钳制（2026-10-12 安全审计）：dailyCap/maxJobsPerRun 是安全阀，
  // 不能被改成 9999 之类绕过限额 —— agent/API 改 config 也必须守住边界
  const cfg = readJson(paths.CONFIG_FILE, {});
  if (Array.isArray(b.keywords)) cfg.keywords = b.keywords.filter(Boolean).slice(0, 30);
  if (b.dailyCap) cfg.dailyCap = Math.min(Math.max(parseInt(b.dailyCap, 10) || 40, 1), 200);
  if (b.maxJobsPerRun) cfg.maxJobsPerRun = Math.min(Math.max(parseInt(b.maxJobsPerRun, 10) || 20, 1), 30);
  if (b.cityCode !== undefined) cfg.cityCode = String(b.cityCode || '');
  if (b.cityName !== undefined) cfg.cityName = String(b.cityName || '');
  // 经验档位（2026-10-16 新面板）：BOSS 的 experience 参数，允许空串（不限）或合法档位码
  if (b.experience !== undefined) {
    const v = String(b.experience || '');
    const ALLOWED = ['', '101', '102', '103', '104', '105', '108'];
    cfg.experience = ALLOWED.includes(v) ? v : '';
  }
  // 填充模式（2026-10-12 新增）：只允许三个已知值，防止被塞成任意串
  if (b.fillMode !== undefined && ['mix', 'hybrid', 'paste', 'type'].includes(String(b.fillMode))) {
    cfg.fillMode = String(b.fillMode);
  }
  // 岗位间隔（2026-10-13 长尾两段）：值域钳制，防被塞成 0 秒或 9999 秒
  // 数字安全钳制（2026-10-13 修）：0 是合法值（如「点击前停留 0 毫秒」），
  // 不能像旧版那样被 `parseInt(v) || dft` 吞成默认值
  const clampInt = (v, lo, hi, dft) => { const n = parseInt(v, 10); return Math.min(Math.max(Number.isFinite(n) ? n : dft, lo), hi); };
  if (b.delayMinSec !== undefined) cfg.delayMinSec = clampInt(b.delayMinSec, 1, 60, 4);
  if (b.delayMaxSec !== undefined) cfg.delayMaxSec = clampInt(b.delayMaxSec, 1, 120, 6);
  if (b.delayTailMinSec !== undefined) cfg.delayTailMinSec = clampInt(b.delayTailMinSec, 1, 60, 6);
  if (b.delayTailMaxSec !== undefined) cfg.delayTailMaxSec = clampInt(b.delayTailMaxSec, 1, 300, 12);
  if (b.delayTailRatio !== undefined) {
    const r = parseFloat(b.delayTailRatio);
    cfg.delayTailRatio = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0.25;
  }
  // 爬取间隔（2026-10-13 长尾两段）：同套钳制
  if (b.collectDelayMinSec !== undefined) cfg.collectDelayMinSec = clampInt(b.collectDelayMinSec, 1, 60, 4);
  if (b.collectDelayMaxSec !== undefined) cfg.collectDelayMaxSec = clampInt(b.collectDelayMaxSec, 1, 120, 7);
  if (b.collectDelayTailMinSec !== undefined) cfg.collectDelayTailMinSec = clampInt(b.collectDelayTailMinSec, 1, 60, 7);
  if (b.collectDelayTailMaxSec !== undefined) cfg.collectDelayTailMaxSec = clampInt(b.collectDelayTailMaxSec, 1, 300, 11);
  if (b.collectDelayTailRatio !== undefined) {
    const r = parseFloat(b.collectDelayTailRatio);
    cfg.collectDelayTailRatio = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0.25;
  }
  // 设置页参数（2026-10-13 新增）：每日爬取上限 + 行为防护
  if (b.dailyCollectCap !== undefined) cfg.dailyCollectCap = clampInt(b.dailyCollectCap, 1, 300, 80);
  if (b.clickPauseMinMs !== undefined) cfg.clickPauseMinMs = clampInt(b.clickPauseMinMs, 0, 5000, 0);
  if (b.clickPauseMaxMs !== undefined) cfg.clickPauseMaxMs = clampInt(b.clickPauseMaxMs, 0, 10000, 2000);
  if (b.readPauseMinMs !== undefined) cfg.readPauseMinMs = clampInt(b.readPauseMinMs, 0, 10000, 1000);
  if (b.readPauseMaxMs !== undefined) cfg.readPauseMaxMs = clampInt(b.readPauseMaxMs, 0, 30000, 2000);
  if (b.readScrollMinPx !== undefined) cfg.readScrollMinPx = clampInt(b.readScrollMinPx, 0, 3000, 300);
  if (b.readScrollMaxPx !== undefined) cfg.readScrollMaxPx = clampInt(b.readScrollMaxPx, 0, 5000, 700);

  // 配对钳制（2026-10-13 修）：min > max 自动把 max 抬上来，不丢用户意图（比把 min 压下去温和）
  // 必须在所有单值 clamp 之后做，确保两边都是合法数字
  const pairClamp = (...[a, b]) => { if (cfg[a] > cfg[b]) cfg[b] = cfg[a]; };
  pairClamp('delayMinSec', 'delayMaxSec');
  pairClamp('delayTailMinSec', 'delayTailMaxSec');
  pairClamp('collectDelayMinSec', 'collectDelayMaxSec');
  pairClamp('collectDelayTailMinSec', 'collectDelayTailMaxSec');
  pairClamp('clickPauseMinMs', 'clickPauseMaxMs');
  pairClamp('readPauseMinMs', 'readPauseMaxMs');
  pairClamp('readScrollMinPx', 'readScrollMaxPx');

  writeJson(paths.CONFIG_FILE, cfg);
  return json(res, 200, { ok: true, config: settingsView(cfg) });
};
