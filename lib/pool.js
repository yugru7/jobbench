/**
 * 候选池：落盘 / 按岗位 ID 去重合并 / 增量配额（从 greet.js 的 runCollectMode 外提，纯搬运）
 * ----------------------------------------------------------------------------
 * logs/last-collect.json 跨批次累积（不覆盖）；已存在的岗位一律跳过，保护用户的勾选/招呼语/发送状态。
 * 用法：const pool = require('./lib/pool')({ LOG_DIR });
 */
const fs = require('fs');
const path = require('path');
const { localDate, localDateTime } = require('./utils');

module.exports = (deps) => {
  const { LOG_DIR } = deps;

  // 去重 key：BOSS 详情 URL 的岗位 ID（job_detail/<id>.html）。
  const poolKey = u => (String(u).match(/job_detail\/([^.?#/]+)\.html/) || [null, 'raw:' + u])[1];

  // 读池子里已有岗位的 ID 集合（提前跳过，不重复读 JD）
  function loadPoolKeys() {
    const alreadyInPool = new Set();
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'last-collect.json'), 'utf8'));
      (Array.isArray(cur.jobs) ? cur.jobs : []).forEach(j => j && j.url && alreadyInPool.add(poolKey(j.url)));
    } catch (_) {}
    return alreadyInPool;
  }

  // 落盘：按岗位 ID 合并进池子（不覆盖上一轮 —— 已定的「少量多次、攒着统一筛」）
  // 已存在的岗位一律跳过：用户改过的招呼语/勾选/发送状态绝不被重爬污染
  function mergeIntoPool(collectResults, targetNew, okCount) {
    let added = 0, dupSkipped = 0;
    try {
      const poolFile = path.join(LOG_DIR, 'last-collect.json');
      const oldPool = (() => {
        try {
          const j = JSON.parse(fs.readFileSync(poolFile, 'utf8'));
          return Array.isArray(j.jobs) ? j.jobs : [];
        } catch (_) { return []; }
      })();
      const key = u => (String(u).match(/job_detail\/([^.?#/]+)\.html/) || [null, 'raw:' + u])[1];
      const seen = new Set(oldPool.map(j => key(j.url)));
      const fresh = collectResults.filter(j => {
        const k = key(j.url);
        if (seen.has(k)) { dupSkipped++; return false; }
        seen.add(k);
        return true;
      });
      added = fresh.length;
      fs.writeFileSync(
        poolFile,
        JSON.stringify({ at: localDateTime(), total: targetNew, ok: okCount, added, poolSize: oldPool.length + added, jobs: oldPool.concat(fresh) }, null, 2),
        'utf8'
      );
      // 记录页「爬取」统计（总量 / 今日）：每次入池新增时累加。
      // 总量首次初始化用旧池子量（对历史近似），之后持续累加；daily 只留最近 60 天。
      try {
        const stFile = path.join(LOG_DIR, 'stats.json');
        let st = null;
        try { st = JSON.parse(fs.readFileSync(stFile, 'utf8')); } catch (_) {}
        if (!st || typeof st !== 'object' || !st.collect) st = { collect: { total: oldPool.length, daily: {} } };
        st.collect.total = (st.collect.total || 0) + added;
        st.collect.daily = st.collect.daily || {};
        const d = localDate();
        st.collect.daily[d] = (st.collect.daily[d] || 0) + added;
        const keys = Object.keys(st.collect.daily).sort();
        while (keys.length > 60) { delete st.collect.daily[keys.shift()]; }
        fs.writeFileSync(stFile, JSON.stringify(st, null, 2), 'utf8');
      } catch (_) {}
    } catch (_) {}
    return { added, dupSkipped };
  }

  return { poolKey, loadPoolKeys, mergeIntoPool };
};
