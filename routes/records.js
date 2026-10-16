/**
 * GET /api/records —— 已发送记录 + 统计
 */
const fs = require('fs');

module.exports = (deps) => async (req, res) => {
  const { paths, json, localDate, todayCount } = deps;
  let text = '';
  try { if (fs.existsSync(paths.SENT_FILE)) text = fs.readFileSync(paths.SENT_FILE, 'utf8'); } catch (_) {}
  const lines = text.split('\n').filter(Boolean).reverse().slice(0, 120);
  const today = localDate();
  // 统计口径（2026-10-13 已定：每项分「总量 / 今日」）：
  //   发送 / 放入输入框：记录文件按「| 状态」子串计数（历史黏行也能算准）
  //     —— 今日再按行首日期过滤（今天写入的记录必然是规整的）
  //   爬取：读 stats.json（greet.js 每次入池新增时累加；总量为历史近似）
  const sentAll = text.match(/\|\s*已发送/g) || [];
  const filledAll = text.match(/\|\s*已填入到输入框/g) || [];
  const countToday = (re) => text.split('\n').filter((l) => l.startsWith(today) && re.test(l)).length;
  let collectTotal = 0, collectToday = 0, offlineTotal = 0, offlineToday = 0;
  try {
    const st = JSON.parse(fs.readFileSync(paths.STATS_FILE, 'utf8'));
    collectTotal = (st.collect && st.collect.total) || 0;
    collectToday = (st.collect && st.collect.daily && st.collect.daily[today]) || 0;
    offlineTotal = (st.offline && st.offline.total) || 0;
    offlineToday = (st.offline && st.offline.daily && st.offline.daily[today]) || 0;
  } catch (_) {}
  const stats = {
    collected: { total: collectTotal, today: collectToday },
    sent: { total: sentAll.length, today: countToday(/\|\s*已发送/) },
    filled: { total: filledAll.length, today: countToday(/\|\s*已填入到输入框/) },
    offline: { total: offlineTotal, today: offlineToday },
  };
  return json(res, 200, { lines, dailyUsed: todayCount(), stats });
};
