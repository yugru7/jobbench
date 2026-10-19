/**
 * 刷新候选池岗位的「招聘者活跃度」（维护模式）
 * ----------------------------------------------------------------------------
 * 场景：池子里的活跃度是**采集当时的快照**，放几天就失真；二筛按活跃度过滤时会用到过期值。
 *       另有少量岗位采集时读不到活跃度（页面还没渲染完），落池就是空的。
 * 做法：把这些岗位逐个重新打开详情页，用与 lib/collect.js 同一套页面侧读取
 *       （lib/job-active.js）重读活跃度。
 *   范围（--reread-scope）：unsent（默认）= 所有未发送岗位，强制重刷；empty = 只补活跃度为空的。
 * 节奏：与采集同款（阅读停顿 / 拟人滚动 / 岗位间隔都复用设置页里「爬取 / 刷新岗位」那组参数），
 *       并按「每批条数」分批、批与批之间休息一段（批大小与休息时长同样在设置页可调），
 *       避免一口气连刷几十条详情页。批间休息切成 1 秒小段，随时可「停止」。
 * 边界：只回写 active / activeRaw 两个字段，绝不动 greeting / checked / sent / jd 等其它字段；
 *       岗位下架/失效 → 直接从候选池删掉（server 会删磁盘，这里同步内存副本）；反复打不开 → 只记日志不删
 *       （网络抖动不该误删好岗位）。
 * 用法：node greet.js --mode=reread --use-cdp --no-pause（面板走 POST /api/reread）
 */
const fs = require('fs');
const path = require('path');
const { readActiveInPage, DETAIL_LOADED_JS } = require('./job-active');

module.exports = (deps) => {
  const {
    rt, CFG, LOG_DIR, log, ipcEmit, checkpoint, sleep, StoppedError,
    gotoWithGuard, isKickedToLogin, sec, paceRand, nextCollectDelaySec, listReferer,
    humanWheelScroll,
  } = deps;

  const POOL_FILE = path.join(LOG_DIR, 'last-collect.json');
  const BACKUP_FILE = POOL_FILE + '.bak';

  // 设置页参数（缺值给默认；非法值兜底）。批量/休息在 routes/config.js 已钳制过一次，这里再兜一次
  const num = (v, dft) => (Number.isFinite(Number(v)) ? Number(v) : dft);
  const BATCH_SIZE = Math.min(Math.max(Math.round(num(CFG.rereadBatchSize, 10)), 1), 30);
  const GAP_MIN_MS = Math.max(0, Math.round(num(CFG.rereadBatchGapMinMs, 30000)));
  const GAP_MAX_MS = Math.max(GAP_MIN_MS, Math.round(num(CFG.rereadBatchGapMaxMs, 90000)));
  const MAX_PER_RUN = Math.max(0, Math.round(num(CFG.rereadMaxPerRun, 0)));   // 0 = 不限（全刷）

  // evaluate 看门狗：与 lib/collect.js 同一套（Playwright 的 evaluate 没有超时参数，
  // 页面卡死会永久挂起；8 秒超时按失败处理，各调用点本来就用 .catch 兜底）
  const EVAL_TIMEOUT_MS = 8000;
  const evalT = (fn, arg) => Promise.race([
    rt.page.evaluate(fn, arg),
    new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate 超时')), EVAL_TIMEOUT_MS)),
  ]);

  function readPool() {
    const raw = fs.readFileSync(POOL_FILE, 'utf8').replace(/^\uFEFF/, '');
    const doc = JSON.parse(raw);
    if (!doc || !Array.isArray(doc.jobs)) throw new Error('候选池文件格式异常（缺 jobs 数组）');
    return doc;
  }

  // 写回池子：Node 写 utf8 不带 BOM；缩进与原文件一致（null, 2）
  function savePool(doc) {
    fs.writeFileSync(POOL_FILE, JSON.stringify(doc, null, 2), 'utf8');
  }

  // 可中断的等待：批间休息可能几十秒，若整段 sleep，用户点「停止」要干等到休息结束才生效。
  // 按 1 秒切片、每片查一次检查点，停止指令 1~2 秒内就能响应。
  async function sleepStoppable(ms) {
    let left = ms;
    while (left > 0) {
      await checkpoint();                    // 被停止时抛 StoppedError，交给调用方处理
      const step = Math.min(1000, left);
      await sleep(step);
      left -= step;
    }
  }

  // 打开一个岗位详情页，重读活跃度。打不开返回 null；被判下架时通过 onOffline 通知调用方。
  async function rereadOne(job, onOffline) {
    const ok = await gotoWithGuard(job.url, `「${job.job}」`, {
      verifyJs: DETAIL_LOADED_JS, maxAttempts: 2, referer: listReferer(), job, onOffline,
    });
    if (!ok) return null;

    // 拟人滚动后再读：与采集同款（先滚一段、停一下、再看），滚动距离读设置页同一组参数
    await humanWheelScroll(rt.page, paceRand('readScrollMinPx', 'readScrollMaxPx', 300, 700), { backRatio: 0.4 }).catch(() => {});
    await sleep(paceRand('readPauseMinMs', 'readPauseMaxMs', 1000, 2000));

    // 同 collect：刚加载完可能只有空壳，没读到就再等再抓（最多 4 轮 × 1.2s）
    let r = { active: '', activeRaw: '' };
    for (let s = 0; s < 4 && !r.active; s++) {
      r = await evalT(readActiveInPage).catch(() => ({ active: '', activeRaw: '' }));
      if (!r.active) await sleep(1200);
    }
    return r;
  }

  // ---------- 模式入口 ----------
  // scope: 'unsent' = 所有未发送岗位（强制重刷）；'empty' = 只补活跃度为空的
  async function runRereadMode(scope) {
    const doc = readPool();
    const onlyEmpty = scope === 'empty';
    const unsent = doc.jobs.filter(j => j && j.url && !j.sent);
    let targets = onlyEmpty ? unsent.filter(j => !j.active) : unsent;
    const matchedAll = targets.length;
    if (MAX_PER_RUN > 0 && targets.length > MAX_PER_RUN) targets = targets.slice(0, MAX_PER_RUN);

    log(`刷新活跃度：候选池共 ${doc.jobs.length} 个，未发送 ${unsent.length} 个，` +
      `${onlyEmpty ? '活跃度为空的' : '本次要刷新的'} ${matchedAll} 个` +
      `${targets.length < matchedAll ? `，按「单次上限 ${MAX_PER_RUN}」收窄为 ${targets.length} 个` : ''}`, 'OK');
    if (!targets.length) { log('没有需要刷新的岗位，收工', 'OK'); return; }
    log(`节奏：每批 ${BATCH_SIZE} 个，批间休息 ${Math.round(GAP_MIN_MS / 1000)}~${Math.round(GAP_MAX_MS / 1000)} 秒（设置页可调）`, '·');

    // 备份一次原始池子（沿用「删除/清理前先 .bak」的约定）
    try {
      fs.writeFileSync(BACKUP_FILE, JSON.stringify(doc, null, 2), 'utf8');
      log(`已备份原始候选池 → ${path.basename(BACKUP_FILE)}`, '·');
    } catch (e) { log(`备份失败（继续跑）：${e.message}`, 'WARN'); }

    let got = 0, stillEmpty = 0, failed = 0, removed = 0, processed = 0, stopped = false;
    // 复用采集的进度事件，面板能看到进度条与当前岗位
    ipcEmit({ t: 'collect-start', total: targets.length });

    for (let i = 0; i < targets.length; i++) {
      const job = targets[i];   // targets 是 doc.jobs 的元素引用，直接改它即改池子

      try { await checkpoint(); }
      catch (e) { if (e && e.name === 'StoppedError') { stopped = true; log('已按你的要求停止', 'WARN'); break; } throw e; }

      if (sec.stop) { log('安全熔断：一次运行内触发多次安全验证，提前收手', 'ERR'); break; }
      if (await isKickedToLogin(true).catch(() => false)) {
        log('检测到登录态失效（BOSS 把你踢回登录页）—— 刷新立即中止', 'ERR');
        ipcEmit({ t: 'kicked-login', where: '刷新活跃度', msg: '登录态失效，刷新已中止' });
        break;
      }

      ipcEmit({ t: 'collect-progress', index: i + 1, total: targets.length, current: job.job });
      log(`▶ [${i + 1}/${targets.length}] ${job.job} @ ${job.company || '?'}`);

      let offline = false;
      const r = await rereadOne(job, () => { offline = true; }).catch(() => null);

      if (offline) {
        // gotoWithGuard 已发 job-offline（server 删磁盘 + 内存 + 勾选副本）。
        // 这里必须同步删掉自己手里的内存副本：否则下面 savePool 整份写回又会把它写回来。
        doc.jobs = doc.jobs.filter(j => j.url !== job.url);
        removed++;
        log('  岗位已下架/失效，已从候选池删除', 'SKIP');
      } else if (!r) {
        failed++;
        log('  打不开详情页，跳过（不删，避免网络抖动误删好岗位）', 'WARN');
      } else if (r.active) {
        job.active = r.active; job.activeRaw = '';
        got++; log(`  活跃度「${r.active}」`, 'OK');
      } else {
        job.activeRaw = r.activeRaw || '';
        stillEmpty++;
        log(`  仍未读到活跃度${r.activeRaw ? `（招聘者区块原文：${r.activeRaw}）` : ''}`, 'WARN');
      }

      // 增量落盘：中途被打断也不丢进度
      try { savePool(doc); } catch (e) { log(`写回候选池失败：${e.message}`, 'ERR'); }
      processed++;

      const isLast = i === targets.length - 1;
      if (!isLast && (i + 1) % BATCH_SIZE === 0) {
        // 一批刷完 → 休息一段再继续（把连刷几十条拆成几段，像真人分批干活）
        const gap = Math.floor(GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS + 1));
        log(`本批 ${BATCH_SIZE} 个已刷完，休息 ${Math.round(gap / 1000)} 秒再继续（点「停止」可随时中断）`, '·');
        try { await sleepStoppable(gap); }
        catch (e) { if (e && e.name === 'StoppedError') { stopped = true; log('已按你的要求停止', 'WARN'); break; } throw e; }
      } else if (!isLast) {
        await sleep(nextCollectDelaySec() * 1000);   // 与采集同款节奏（4~7 秒为主，偶尔 7~11 秒）
      }
    }

    ipcEmit({ t: 'collect-done', total: got });
    log(`刷新完成：本次处理 ${processed} 个（计划 ${targets.length} 个）｜读到活跃度 ${got} 个｜仍读不到 ${stillEmpty} 个｜打不开 ${failed} 个` +
      `${removed ? `｜已下架删除 ${removed} 个` : ''}${stopped ? '｜（中途按你的要求停止）' : ''}`, 'OK');
    if (!stopped) log('回面板刷新后，二筛的活跃度过滤即可按新值生效', '·');
  }

  return { runRereadMode };
};
