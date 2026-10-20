/**
 * 运行时状态 + 事件广播 + SSE 订阅/重放
 * ----------------------------------------------------------------------------
 * 从 server.js 拆出的基础模块：
 *   · 可变 state（面板与路由共读）
 *   · broadcast(...)：把事件推给所有 SSE 客户端，并写进事件缓冲
 *   · clients：SSE 订阅集合
 *   · framesAfter(lastId)：断线重连时按 seq 续传的事件帧
 *   · handleEvent(ev)：把 greet.js 回传的 IPC 事件落到 state 上再广播
 */
module.exports = (deps) => {
  const { paths, readJson, writeJson, localDate, localDateTime, todayCount, saveExpectsCache } = deps;

  // ---------- 运行时状态 ----------
  const state = {
    status: 'idle',        // idle | running | paused | stopping
    phase: '',             // collect | send
    keyword: '',
    cityName: '',
    maxJobs: 0,

    // collect 阶段
    collected: [],         // 候选岗位（含 JD / 活跃度 / 招呼语）
    collectProgress: { index: 0, total: 0, current: '' },
    checkedUrls: [],       // 过二筛勾选的服务端副本（POST /api/checked 同步，agent 用它识别「过二筛岗位」）

    // send 阶段
    sendMode: '',          // fillOnly | confirm | auto
    sendProgress: { index: 0, total: 0, sent: 0, skipped: 0, failed: 0, filled: 0, current: '', company: '' },
    awaiting: null,        // confirm 模式下当前等你确认的岗位

    startedAt: null,
    finishedAt: null,
    error: '',
    stopRequested: false,   // 本次运行是否收到过「停止」指令（exit 判定用）
  };
  // 启动恢复勾选副本
  // 写盘格式是 { at, urls }（见 /api/checked），这里原来直接
  // readJson(file, []) 当数组读 —— 勾选过且重启过服务后，state.checkedUrls 会变成
  // 对象，bootstrap 原样回传，前端 checkedUrls.filter() 直接抛
  // 「srv.filter is not a function」，整个面板崩成错误页。
  // 兼容两种历史格式：对象取 .urls，数组直接用。
  state.checkedUrls = (() => {
    const raw = readJson(paths.CHECKED_FILE, null);
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.urls)) return raw.urls;
    return [];
  })();

  const eventBuffer = [];
  const EVENT_KEEP = 500;
  const clients = new Set();
  let eventSeq = 0;   // 事件序号：SSE 的 id 字段，断线重连时按它续传（见 /api/events）
  let runSeq = 0;          // 每次任务一个自增 id，事件都带上 —— 界面/测试用它过滤回放的旧事件
  let currentRunId = 0;

  function broadcast(obj) {
    eventSeq++;
    eventBuffer.push({ seq: eventSeq, ev: obj });
    if (eventBuffer.length > EVENT_KEEP) eventBuffer.splice(0, eventBuffer.length - EVENT_KEEP);
    const frame = `id: ${eventSeq}\ndata: ${JSON.stringify({ ...obj, rid: currentRunId })}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch (_) { clients.delete(res); }
    }
  }

  // 每次任务开始分配一个自增 runId（startChild 用），事件里带上它用于过滤回放旧事件
  function nextRunId() { currentRunId = ++runSeq; return currentRunId; }

  // 断线重连续传：返回 seq > lastId 的事件帧（rid 用当前 runId）
  function framesAfter(lastId) {
    const out = [];
    for (const { seq, ev } of eventBuffer) {
      if (seq > lastId) out.push(`id: ${seq}\ndata: ${JSON.stringify({ ...ev, rid: currentRunId })}\n\n`);
    }
    return out;
  }

  function handleEvent(ev) {
    switch (ev.t) {
      case 'start':
        state.maxJobs = ev.maxJobs;
        state.keyword = (ev.keywords || []).join('、');
        broadcast(ev);
        break;

      // 「来源：意向页签」第一步：方向列表回传，界面渲染成 chips 让用户挑
      case 'expects':
        state.expects = ev.tabs || [];
        if (ev.tabs && ev.tabs.length) saveExpectsCache(ev.tabs);   // 读到就存，下次秒出
        broadcast(ev);
        break;

      case 'collect-start':
        state.collectProgress = { index: 0, total: ev.total, current: '' };
        broadcast(ev);
        break;

      case 'collect-progress':
        state.collectProgress = { index: ev.index, total: ev.total, current: ev.current };
        broadcast(ev);
        break;

      case 'candidate':
        state.collected.push(ev.job);
        broadcast(ev);
        break;

      // 【收藏来源】收藏岗"默认过二筛"：子进程把本轮新进池的收藏岗位回传，
      // 这里合进勾选副本（写盘）+ 广播 checked-sync，面板会跟着勾上。只在采集这一刻
      // 勾一次，之后用户手动取消不会被反复勾回来。
      case 'fav-checked': {
        const add = Array.isArray(ev.urls) ? ev.urls : [];
        if (add.length) {
          state.checkedUrls = [...new Set([...(state.checkedUrls || []), ...add])];
          try { writeJson(paths.CHECKED_FILE, { at: new Date().toISOString(), urls: state.checkedUrls }); } catch (_) {}
          broadcast({ t: 'checked-sync', urls: state.checkedUrls });
        }
        break;
      }

      case 'collect-done':
        broadcast(ev);
        break;

      case 'send-start':
        state.sendMode = ev.confirmEach ? 'confirm' : 'auto';
        state.sendProgress = { index: 0, total: ev.total, sent: 0, skipped: 0, failed: 0, filled: 0, current: '', company: '' };
        broadcast(ev);
        break;

      case 'send-progress':
        state.sendProgress = {
          index: ev.index, total: ev.total, sent: ev.sent, skipped: ev.skipped,
          failed: ev.failed, filled: ev.filled || 0, current: ev.current, company: ev.company || '',
        };
        broadcast(ev);
        break;

      case 'awaiting':
        state.awaiting = { url: ev.url, job: ev.job, company: ev.company, greeting: ev.greeting };
        broadcast(ev);
        break;

      case 'filled':
        // 累加进度计数（send-progress 是每个岗位处理前发的，最后一个岗位的
        // 结果只在这里出现——不累加就会少算，发了 2 个显示 1）
        state.sendProgress.filled = (state.sendProgress.filled || 0) + 1;
        broadcast(ev);
        break;

      case 'sent':
        state.awaiting = null;
        state.sendProgress.sent = (state.sendProgress.sent || 0) + 1;   // 同上：终点计数补这里
        // sent 持久化：标进 last-collect.json 池子（不然刷新后 sent 丢失，发过的岗位又变可勾选）
        try {
          const coll = readJson(paths.COLLECT_FILE, null);
          if (coll && Array.isArray(coll.jobs)) {
            const job = coll.jobs.find(j => j.url === ev.url);
            if (job) { job.sent = true; job.greeting = ev.greeting || job.greeting; writeJson(paths.COLLECT_FILE, coll); }
          }
          const mem = state.collected.find(j => j.url === ev.url);
          if (mem) { mem.sent = true; mem.greeting = ev.greeting || mem.greeting; }
        } catch (_) {}
        broadcast(ev);
        break;

      case 'send-done':
        state.awaiting = null;
        broadcast({ ...ev, dailyUsed: todayCount() });
        break;

      case 'job-offline': {
        // 下架岗位从候选池彻底删掉（磁盘 + 内存 + 勾选副本）— 面板实时消失
        const url = ev.url;
        try {
          const coll = readJson(paths.COLLECT_FILE, null);
          if (coll && Array.isArray(coll.jobs)) {
            coll.jobs = coll.jobs.filter((j) => j.url !== url);
            writeJson(paths.COLLECT_FILE, coll);
          }
          if (Array.isArray(state.collected)) state.collected = state.collected.filter((j) => j.url !== url);
          if (Array.isArray(state.checkedUrls) && state.checkedUrls.includes(url)) {
            state.checkedUrls = state.checkedUrls.filter((u) => u !== url);
            try { writeJson(paths.CHECKED_FILE, { at: new Date().toISOString(), urls: state.checkedUrls }); } catch (_) {}
          }
        } catch (_) {}
        // 下架留痕：写进发送记录 + 累加统计（记录页能看到）
        try {
          require('fs').appendFileSync(paths.SENT_FILE, `${localDateTime()} | ${ev.job || ''} | ${ev.company || ''} | 岗位已下架，已删除\n`, 'utf8');
        } catch (_) {}
        try {
          let st = {};
          try { st = JSON.parse(require('fs').readFileSync(paths.STATS_FILE, 'utf8')); } catch (_) {}
          st.offline = st.offline || { total: 0, daily: {} };
          st.offline.total = (st.offline.total || 0) + 1;
          st.offline.daily = st.offline.daily || {};
          const d = localDate();
          st.offline.daily[d] = (st.offline.daily[d] || 0) + 1;
          const keys = Object.keys(st.offline.daily).sort();
          while (keys.length > 60) { delete st.offline.daily[keys.shift()]; }
          require('fs').writeFileSync(paths.STATS_FILE, JSON.stringify(st, null, 2), 'utf8');
        } catch (_) {}
        broadcast({ t: 'job-removed', url, job: ev.job, company: ev.company });
        break;
      }

      case 'login-needed':
        state.loginNeeded = true;
        broadcast(ev);
        break;

      case 'login-ok':
      case 'login-timeout':
        if (ev.t === 'login-ok') state.loginNeeded = false;
        broadcast(ev);
        break;

      case 'browser-kept':
        // 任务干完了但浏览器还开着 —— 对界面来说这就是"空闲"了，可以开始新任务
        state.status = 'idle';
        state.browserOpen = true;
        broadcast(ev);
        broadcast({ t: 'state', status: 'idle', browserOpen: true });
        break;

      case 'browser-closed':
        state.browserOpen = false;
        broadcast(ev);
        broadcast({ t: 'state', status: 'idle', browserOpen: false });
        break;

      case 'state':
        state.status = ev.status;
        if (ev.browserOpen !== undefined) state.browserOpen = ev.browserOpen;
        broadcast(ev);
        break;

      case 'log':
        broadcast(ev);
        break;

      case 'error':
        state.error = ev.msg;
        broadcast(ev);
        break;

      case 'dup-hr': {
        // 同一 HR 已在沟通（这是 TA 的另一个岗位）：招呼语不重复发，
        // 给池子落一个 dupContact 标记 —— 以后发布 / 二筛都不再碰它，免得反复白跑。
        //
        // 【坑】池子里的 url 可能带查询串（如 ?securityId=...，收藏来源尤其常见），
        // 而发送清单里通常是干净的基础 url；必须按「去掉查询串的基址」比对，
        // 否则 find 落空 → 标记根本写不进去。
        const base = (u) => String(u || '').split('?')[0].split('#')[0];
        const url = ev.url;
        const key = base(url);
        try {
          const coll = readJson(paths.COLLECT_FILE, null);
          if (coll && Array.isArray(coll.jobs)) {
            const job = coll.jobs.find((j) => base(j.url) === key);
            if (job) { job.dupContact = true; writeJson(paths.COLLECT_FILE, coll); }
          }
          const mem = state.collected.find((j) => base(j.url) === key);
          if (mem) mem.dupContact = true;
          // 已经从勾选里拿掉（它不会再被发送）
          if (Array.isArray(state.checkedUrls) && state.checkedUrls.some((u) => base(u) === key)) {
            state.checkedUrls = state.checkedUrls.filter((u) => base(u) !== key);
            try { writeJson(paths.CHECKED_FILE, { at: new Date().toISOString(), urls: state.checkedUrls }); } catch (_) {}
            broadcast({ t: 'checked-sync', urls: state.checkedUrls });
          }
        } catch (_) {}
        broadcast({ t: 'job-dup', url, job: ev.job, company: ev.company });
        break;
      }

      case 'quota':
        // 平台额度提示（已与 N 位沟通 / 还剩 M 次）：面板直接显示，不改本地计数
        broadcast(ev);
        break;

      case 'quota-stop':
        state.error = '平台今日沟通次数已用完';
        broadcast(ev);
        break;

      default:
        broadcast(ev);
    }
  }

  return { state, broadcast, clients, framesAfter, nextRunId, handleEvent };
};
