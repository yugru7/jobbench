/**
 * GET /api/bootstrap —— 首屏全量（config / 知识库 / 城市 / 状态 / 池子）
 */
module.exports = (deps) => async (req, res) => {
  const { paths, state, readJson, json, settingsView, loadCities, loadFilters, todayCount } = deps;
  const cfg = readJson(paths.CONFIG_FILE, {});
  const lastCollect = readJson(paths.COLLECT_FILE, null);
  return json(res, 200, {
    config: {
      keywords: cfg.keywords || [],
      cityCode: cfg.cityCode || '',
      cityName: cfg.cityName || '',
      ...settingsView(cfg),   // 设置页参数：限额/间隔/行为防护
    },
    knowledge: readJson(paths.KNOWLEDGE_FILE, { entries: [] }),
    cities: loadCities(),
    filters: loadFilters(),   // 岗位初筛筛选 chips 数据源（选项 + 区县；缺失时为 null，前端降级）
    state: { ...state, collected: [] },   // collected 单独给，避免首屏太大
    checkedUrls: state.checkedUrls || [],   // 勾选服务端副本：boot 兜底用（localStorage 空时 adopt，见 render.js restoreChecked）
    lastCollect,
    dailyUsed: todayCount(),
  });
};
