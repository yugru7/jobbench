/**
 * 收集岗位（从 greet.js 外提，纯搬运）
 * ----------------------------------------------------------------------------
 * collectJobs()：列表页抓卡片、进详情、过滤去重；
 * runCollectMode()：逐个读 JD + 活跃度 + 生成招呼语，不发消息；
 * readJobDetail()：只读打开详情页抓 JD；runExpectsMode()：读意向页签。
 * 用法：const collect = require('./lib/collect')(deps);
 */
const { sleep, rnd, cyan, gray } = require('./utils');
const { readActiveInPage, DETAIL_LOADED_JS } = require('./job-active');

module.exports = (deps) => {
  const {
    rt, CFG, SOURCE, EXPECT_TAB, FORCE_MAX,
    log, ipcEmit, checkpoint, StoppedError, sec, SECURITY_STOP_AT,
    buildGreeting, isGuardUrl, searchUrl, favUrl, readExpectTabs, clickExpectTab,
    humanWheelScroll, gotoWithGuard, passGuard, realUrl, isSecurityPage, isKickedToLogin,
    listReferer, paceRand, nextCollectDelaySec, waitEnter,
    poolKey, loadPoolKeys, mergeIntoPool,
  } = deps;

  // evaluate 看门狗：Playwright 的 page.evaluate 没有超时参数，
  // 页面卡死时它会永久挂起（表现为整个采集「卡住不动」）。这里用 Promise.race 加 8 秒
  // 超时，超时按失败处理 —— 各调用点本来就用 .catch 兜底，不改变原有语义。
  const EVAL_TIMEOUT_MS = 8000;
  const evalT = (fn, arg) => Promise.race([
    rt.page.evaluate(fn, arg),
    new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate 超时')), EVAL_TIMEOUT_MS)),
  ]);

  // 轻量登录态早退守卫：在爬取循环的关键节点检查一次，
  // 被 BOSS 踢回登录页就立刻停，emit kicked-login 让面板显示警告。
  // 返回 true 表示应该中止整个采集流程。
  //
  // isStrict = false（goto 后用）：只查 URL 路径（goto 完 URL 立刻可靠），
  //   不查 bodyLen —— goto 完页面还在加载，bodyLen 小是正常的，会误判。
  // isStrict = true（每个 job 前用）：同时查 URL + bodyLen + 登录入口，
  //   此时页面已稳定，bodyLen 检测可靠。
  async function checkLoginKick(where, isStrict = false) {
    if (!isKickedToLogin) return false;
    const kicked = await isKickedToLogin(isStrict).catch(() => false);
    if (kicked) {
      log(`检测到登录态失效（${where}）—— BOSS 把你踢回登录页了，本次采集立即中止`, 'ERR');
      ipcEmit({ t: 'kicked-login', where: where || '', msg: '登录态失效，本次采集已中止。请登录后重新发起' });
      return true;
    }
    return false;
  }

  // 等职位卡片真正渲染出来。
  // BOSS 的列表是懒渲染：先出 1 张占位卡，再逐步填充。
  // 只等"有 1 张"就往下走会拿到空数据，所以要求"数量稳定"。
  async function waitForCards(minCount = 3, maxWaitMs = 30000) {
    const deadline = Date.now() + maxWaitMs;
    let last = -1, stableRounds = 0;
    while (Date.now() < deadline) {
      const n = await evalT(
        () => document.querySelectorAll('a[href*="/job_detail/"]').length
      ).catch(() => 0);

      // 达到下限且连续 3 轮（约 2.1s）不再增长 → 认为渲染完了
      if (n >= minCount && n === last) {
        stableRounds++;
        if (stableRounds >= 3) return n;
      } else {
        stableRounds = 0;
      }
      last = n;
      await sleep(700);
    }
    return last > 0 ? last : 0;
  }

  // ---------- 模式：只读意向岗位页签（来源「意向页签」第一步，几秒就完）----------
  // 读出用户在 BOSS 勾选的求职方向，回传界面渲染成 chips 让用户挑一个。
  // 【注意】必须放在搜索流程之前 —— 下面有个 jobs.length===0 的退出守卫，
  // expects 模式不搜索，走不到那里就会先被弹掉。
  async function runExpectsMode() {
    log('读取意向岗位页签…');
    let tabs = [];
    try {
      await rt.page.goto(searchUrl(''), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(rnd(2200, 3800));
      const r = await readExpectTabs(rt.page);
      tabs = [...new Set([...r.direct, ...r.more])];   // direct 和「更多」里可能有重叠，去重
    } catch (e) {
      log(`读页签失败：${e.message.slice(0, 60)}`, 'ERR');
    }
    ipcEmit({ t: 'expects', tabs });
    log(tabs.length ? `OK 意向方向 ${tabs.length} 个，已回传界面: ${tabs.join('、')}` : '没读到意向页签', tabs.length ? 'OK' : 'WARN');
    await rt.closer();
    return;
  }

  // ---------- 收集岗位 ----------
  //
  // 【核心策略】BOSS 的反爬会在页面加载后约 10 秒把页面弹回上一页。
  // 所以不能"先等到稳定再抓"，必须在卡片出现的瞬间立刻抓走。
  // 这里把「检查卡片」和「提取数据」合并成一次 evaluate，抓到就撤。
  async function collectJobs(jobs, keywords) {
  const seen = new Set();
  // 过滤统计，帮你看清每道门槛卡掉多少
  // 注：收集端只卡「城市」一道硬门槛 —— 不按标题判实习/全职、也没有源头关键词过滤；
  // 实习/全职的区分与其它筛选都放在界面的二次筛选里。
  let rejectedArea = 0;    // 不在目标城市
  let rejectedJunk = 0;    // 假卡片：导航残留的 /job_detail/ 链接，无公司无薪资
  const rejectedNames = []; // 被滤掉的岗位名（写进日志，不再黑箱）

  // 【收藏来源】收藏页是"用户自己衡量后加进收藏"的岗位，不套城市过滤
  // （不加任何限制）；只保留下面「假卡片」那道结构门槛，挡掉导航残留的假链接。
  const NO_FILTER = SOURCE === 'fav';

  // 去重 key：BOSS 详情 URL 的岗位 ID（job_detail/<id>.html）。
  // 同一岗位会以不同 lid/securityId 参数出现多次（同页重复挂载/跨关键词），
  // 按完整 URL 去重挡不住 —— 「行政实习生」同轮被抓了两遍。
  const jobKey = u => (String(u).match(/job_detail\/([^.?#/]+)\.html/) || [null, 'raw:' + u])[1];

  // 【加载深度按需】计数口径 = 「新的」：本轮首次见到 + 不在候选池里
  // （"爬去过的去掉"）。目标就是本次要爬的数量（面板数量 / -n）—— 拿到这么多新的就够，
  // 不用把每页都遍历完、也不用一路滚到底；这也和下游 runCollectMode「重复自动补位」同口径。
  const alreadyInPool = loadPoolKeys();
  const needNew = FORCE_MAX > 0 ? FORCE_MAX : Infinity;   // 本次要拿到的「新」岗位数
  let newTotal = 0;                                       // 本次运行累计拿到的「新」候选数
  let aborted = false;                                    // 登录态失效 → 整个采集立刻收手

  function mergeItems(items) {
    const addedArr = [];
    for (const it of items) {
      if (!it.url || !it.job || seen.has(jobKey(it.url))) continue;

      // 【硬门槛0】结构门槛：真卡片必有公司或薪资。都没有的是导航残留假卡
      // （「职位搜索」混进候选，还浪费一次详情页访问）
      if (!it.company && !it.salary) { rejectedJunk++; continue; }

      // 【硬门槛1】工作地点必须在目标城市（过滤 BOSS 混进来的外地岗）—— 收藏来源不套（见上）
      if (!NO_FILTER && CFG.cityName && it.area && !it.area.includes(CFG.cityName)) {
        rejectedArea++;
        if (rejectedNames.length < 8) rejectedNames.push(it.job);
        continue;
      }

      seen.add(jobKey(it.url));
      jobs.push(it);
      addedArr.push(it);
    }
    return addedArr;
  }

  // 合并一批卡片并计「新」数：added = 本批新增的卡片（含池里已有的），fresh = 其中不在池子里的
  function mergeAndCount(items) {
    const addedArr = mergeItems(items);
    const fresh = addedArr.filter(it => !alreadyInPool.has(poolKey(it.url))).length;
    newTotal += fresh;
    return { added: addedArr.length, fresh };
  }

  // 一次性：有卡片就提取，没有就返回空数组
  const EXTRACT_JS = () => {
    const out = [], seenHref = new Set();
    document.querySelectorAll('a[href*="/job_detail/"]').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!href || seenHref.has(href)) return;
      const card = a.closest('li') || (a.parentElement && a.parentElement.parentElement) || a;
      const pick = (sels) => {
        for (const s of sels) {
          const el = card.querySelector(s);
          if (el && el.innerText.trim()) return el.innerText.trim();
        }
        return '';
      };
      const job = pick(['.job-name', '.job-name-limit', '[class*="job-name"]'])
        || (a.innerText || '').split('\n')[0].trim();
      if (!job) return;
      seenHref.add(href);
      out.push({
        url: href.startsWith('http') ? href : 'https://www.zhipin.com' + href,
        job,
        company: pick(['.company-name', '[class*="company-name"]', '.boss-name']),
        tags: pick(['.tag-list', '[class*="tag"]']),
        // 薪资（实习岗位是"X-Y元/天"，方便你判断值不值得投）
        salary: pick(['.job-salary', '[class*="salary"]']),
        // 工作地点（如"北京·朝阳区"），用于过滤混进来的外地岗
        area: pick(['.job-area', '[class*="job-area"]', '.company-location', '[class*="area"]']),
      });
    });
    return out;
  };

  // 直接数卡片数量（不提取），用于判断"列表真的渲染好了"
  const COUNT_JS = () => document.querySelectorAll('a[href*="/job_detail/"]').length;

  // ---------- 收藏来源 ----------
  // 收藏页（个人中心 → 感兴趣 → 职位收藏）的卡片结构跟搜索/推荐列表页完全不同，
  // 单独一套提取：卡片根是 li.item-boss，岗位名 .job-name-text、地点 .location、
  // 公司 .company-info .text b a，薪资/标签同在一个 .job-info p.gray 里（薪资是第一个文本节点、标签是后面的 span）。
  // 【必须限定在 .user-jobs-ul 内】页面右栏「谁看过我 / 对我感兴趣」也有 /job_detail/ 链接，
  // 那是推荐、不是收藏，绝不能抓进来（同页 6 个链接里 4 个来自右栏）。
  const EXTRACT_FAV_JS = () => {
    const out = [], seenHref = new Set();
    const txt = (root, sel) => { const el = root.querySelector(sel); return el ? (el.innerText || '').trim() : ''; };
    document.querySelectorAll('.user-jobs-ul li.item-boss').forEach(li => {
      const a = li.querySelector('a[href*="/job_detail/"]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      const key = href.split('?')[0];
      if (!href || seenHref.has(key)) return;
      const job = txt(li, '.job-name-text');
      if (!job) return;
      seenHref.add(key);
      const grayP = li.querySelector('.job-info p.gray');
      let salary = '', tags = '';
      if (grayP) {
        salary = ((grayP.firstChild && grayP.firstChild.textContent) || '').trim();
        tags = [...grayP.querySelectorAll('span')].map(s => (s.innerText || '').trim()).filter(Boolean).join(' ');
      }
      out.push({
        url: href.startsWith('http') ? href : 'https://www.zhipin.com' + href,
        job,
        company: txt(li, '.company-info .text b a') || txt(li, '.company-info .text b'),
        tags,
        salary,
        // 收藏卡的 .location 原文被方括号和换行包着（如 "[␊城市·区␊]"），
        // 洗成与搜索/推荐列表一致的纯地点串（去括号与空白）
        area: txt(li, '.location').replace(/[\[\]\s]/g, ''),
      });
    });
    return out;
  };
  // 收藏卡片数（只数主列表，不含右栏推荐）
  const COUNT_FAV_JS = () => document.querySelectorAll('.user-jobs-ul li.item-boss').length;
  // 按来源选提取器 / 计数口径；就绪阈值：列表页要 5 张才算渲染好，
  // 但收藏页卡片数可能只有 1~2 个（用户收藏本来就不多），阈值 5 会永远抓不到 → 收藏降到 1
  const COUNT = SOURCE === 'fav' ? COUNT_FAV_JS : COUNT_JS;
  const EXTRACT = SOURCE === 'fav' ? EXTRACT_FAV_JS : EXTRACT_JS;
  const READY_N = SOURCE === 'fav' ? 1 : 5;

  // ---------- 加载深度上限----------
  // 收藏每页 15 条、单次最多爬 30 个 → 5 页足够，留一页兜底防跑飞
  const FAV_MAX_PAGES = 5;
  // 非收藏来源按缺口补滚：滚动轮数上限 + 连续"滚不出新卡片"的容忍轮数
  // （humanWheelScroll 自带 25% 概率这轮不滚，所以要容忍几轮才判定"到底了"）
  const SCROLL_MAX_ROUNDS = 8;
  const SCROLL_NO_NEW_STREAK = 3;
  // 列表页判定：只有确定还停在真正的列表页才继续滚动/提取。
  // 【踩坑】BOSS 反爬会在加载后几秒内把页面弹走 —— 一次搜索页在
  // 约 3 秒后就自己跳到了 /job_detail/ 详情页（详情页右侧「推荐」也有大量 /job_detail/ 链接），
  // 此时若继续按 EXTRACT 提取，会把详情页的推荐卡当成候选岗位合并进来。
  // 原来只判 /zhipin\.com/（详情页也满足）挡不住，必须再要求是列表页路径 + 排除 job_detail。
  const LIST_PATH = SOURCE === 'fav' ? /\/web\/geek\/recommend/ : /\/web\/geek\/job/;
  const isListPage = u => LIST_PATH.test(u) && !/job_detail/.test(u);

  // ---------- 加载「一页」列表并抓卡（搜索/推荐/意向/收藏 共用）----------
  // pageNo：收藏来源翻页用；其它来源恒为 1（它们靠滚动加深，不翻页）。
  // 返回：added 本页合并的卡片数 / fresh 其中「新的」数 / maxSeen 轮询期间见到的最大卡片数
  //      （0 = 这页压根没卡片 → 收藏已翻到底）/ ok 这页算不算读成功
  async function loadListPage(kw, pageNo) {
    const label = SOURCE === 'fav' ? `收藏第 ${pageNo} 页` : `搜索「${kw}」`;
    let res = { added: 0, fresh: 0, maxSeen: 0, ok: false };

    for (let attempt = 1; attempt <= (CFG.searchRetryPerKw || 3) && !res.ok; attempt++) {
      // 每次都换新标签页，杜绝上一页/上一个关键词的陈旧 DOM（会抓到 1 个残留卡片）
      if (attempt > 1) {
        try {
          const np = await rt.ctx.newPage();
          // attachPage / crashed 已由 connectBrowser 挂到共享的 rt 上，
          // 这里真正把 rt.page 切到新标签，重试不再空转。
          rt.attachPage(np);
          await np.bringToFront().catch(() => {});
          await rt.page.close().catch(() => {});
          rt.page = np;
          rt.crashed = false;
        } catch (_) {}
      }

      try {
        await rt.page.goto(SOURCE === 'fav' ? favUrl(pageNo) : searchUrl(kw), { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (e) {
        log(`  第${attempt}次 goto 失败：${e.message.slice(0, 45)}`, 'WARN');
        await sleep(2000);
        continue;
      }

      // 【登录态早退】刚 goto 完就查一次登录态，被踢回登录页 → 立刻停
      // 用 isStrict=false：goto 完页面还在加载，只查 URL 是否落了登录路径（可靠），
      // 不查 bodyLen（页面还没渲染完 bodyLen 小是正常的，会误判）
      if (await checkLoginKick(`${label} goto 后`, false)) { aborted = true; return res; }

      // expect 模式：落地的是推荐流，先点当前页签把列表切过去，等切换完成再进轮询
      // （不点的话轮询会立刻把推荐流的卡片当结果抓走）
      if (SOURCE === 'expect') {
        const err = await clickExpectTab(rt.page, kw);
        if (err) {
          log(`  页签「${kw}」失败：${err}`, 'WARN');
          await sleep(1000);
          continue;
        }
      }

      let bounced = false;
      let maxSeen = 0;
      let sawZhipin = false, offStreak = 0;
      let pageAdded = 0, pageFresh = 0;

      // 轮询：卡片数达到就绪阈值就判定列表渲染好了，立刻抓走
      // （BOSS 会在加载后约 10 秒弹回上一页，必须抢在这个窗口内）
      // 【关键修复】同理：导航提交前会短暂 about:blank，不能误判为"被弹回"
      // 间隔 400→800ms、迭代 60→30：仍是约 24 秒窗口，CDP 调用减半
      for (let i = 0; i < 30; i++) {
        await sleep(800);
        const u = await realUrl();

        if (isGuardUrl(u)) {
          if (!await passGuard(label)) { bounced = true; break; }
          continue;
        }

        if (/zhipin\.com/.test(u)) {
          sawZhipin = true;
          offStreak = 0;
          // 验证内容直接渲染在页内（URL 不变）的情况：页面稳定后检测，同样交给 passGuard 等人工
          if (i >= 8 && i % 5 === 3 && await isSecurityPage()) {
            if (!await passGuard(`页内安全验证`)) break;
          }
        } else {
          if (u) offStreak++;
          if (sawZhipin && offStreak >= 4) { bounced = true; break; }
          continue;
        }

        const n = await evalT(COUNT).catch(() => 0);
        if (n > maxSeen) maxSeen = n;

        if (n >= READY_N) {
          const items = await evalT(EXTRACT).catch(() => []);
          const t = mergeAndCount(items);
          pageAdded += t.added;
          pageFresh += t.fresh;
          if (pageAdded > 0) break;
          // 收藏页：卡片渲染出来就算这页读完 —— 池里已有的重复不该触发"没就绪"重试
          //（否则每页都要空转 24 秒 × 重试次数）
          if (SOURCE === 'fav') break;
        }
      }

      res = { added: pageAdded, fresh: pageFresh, maxSeen, ok: false };

      if (bounced) {
        log(`  第${attempt}次被弹回，换新标签重试`, 'WARN');
        // 【提速】原 2~4 秒，1 秒足够
        await sleep(800 + Math.floor(Math.random() * 600));
        continue;
      }

      if (pageAdded > 0) res.ok = true;
      else if (SOURCE === 'fav' && maxSeen > 0) res.ok = true;   // 收藏：全是爬过的也算这页读完了

      // 收藏页一张卡片都没有 = 收藏已翻到底（不是"没就绪"）→ 直接当读完、不重试，
      // 否则每翻过一个空页都要空转 24 秒 × 重试次数
      if (SOURCE === 'fav' && maxSeen === 0) break;

      if (!res.ok) {
        log(`  第${attempt}次没就绪（最多见到 ${maxSeen} 个卡片）`, 'WARN');
        await sleep(600);
      }
    }

    return res;
  }

  // ---------- 按缺口补滚（搜索 / 推荐 / 意向）----------
  // 【加载深度按需】原来是固定补 2~3 轮；现在改成「还差多少个新的就继续滚」：
  //   要 10 个、首页就够 → 一轮都不滚（和原来一样快）；
  //   要 30 个 → 一直滚到够数，或连续几轮滚不出新卡（页面到底），或到轮数上限。
  async function topUpByScroll(kw) {
    let noNew = 0;
    for (let r = 1; r <= SCROLL_MAX_ROUNDS; r++) {
      if (newTotal >= needNew) return;          // 数量够了 → 停手
      // 【踩过的坑】realUrl() 是 page.evaluate，SPA 路由切换/导航瞬间会抛
      // "execution context destroyed"，它内部 .catch 返回空串 —— 只读一次就判"离开列表页"
      // 会误收手（need=30 却一轮都没滚，日志里什么都看不出来）。这里连读 3 次，全空才认。
      let u = '';
      for (let k = 0; k < 3 && !u; k++) { u = await realUrl(); if (!u) await sleep(400); }
      if (!isListPage(u)) {
        log(`  补滚收手：页面已不在 BOSS 列表页（URL=${String(u).slice(0, 60) || '空'}）—— 再滚会把非列表内容当候选`, 'WARN');
        return;
      }
      await humanWheelScroll(rt.page, rnd(600, 1200)).catch(() => {});
      await sleep(rnd(800, 1800));
      const items = await evalT(EXTRACT).catch(() => []);
      const t = mergeAndCount(items);
      log(`  「${kw}」补滚第 ${r} 轮：合并 ${t.added} 个（其中新的 ${t.fresh} 个）｜累计新的 ${newTotal} 个`, t.fresh ? 'OK' : '·');
      noNew = t.added > 0 ? 0 : noNew + 1;
      if (noNew >= SCROLL_NO_NEW_STREAK) return;   // 连续几轮滚不出新卡片 → 到底了
    }
  }

  // expect 模式：先 goto 职位页一次，读出意向岗位页签文字，把"关键词"替换成页签名
  // 之后循环体里每个 kw 就是一个页签：goto 干净职位页 → 点页签 → 抓列表
  // 两步流程：界面先调 --mode=expects 读列表让用户挑，然后 --expect-tab 只爬选中的
  if (SOURCE === 'expect') {
    log('读取意向岗位页签…');
    try {
      await rt.page.goto(searchUrl(''), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(rnd(2200, 3800));
      const tabs = await readExpectTabs(rt.page);
      let all = [...new Set([...tabs.direct, ...tabs.more])];   // direct 和「更多」里可能有重叠，去重
      if (EXPECT_TAB) all = all.filter(t => t === EXPECT_TAB);
      if (all.length) {
        keywords = all;
        log(`OK 意向页签 ${all.length} 个: ${all.join('、')}`);
      } else {
        log(EXPECT_TAB ? `页签「${EXPECT_TAB}」不在你的意向里，终止 —— 重新在界面读一次方向列表` : '没读到意向页签（页面结构变了？）—— 循环将空跑终止，请改用其他来源', 'WARN');
      }
    } catch (e) {
      log(`读页签失败：${e.message.slice(0, 50)}`, 'WARN');
    }
  }

  for (const kw of keywords) {
    await checkpoint();   // 暂停/停止在这里生效（只在关键词 / 页之间，安全位置）
    ipcEmit({ t: 'phase', phase: 'search', keyword: kw });
    log(`---- ${SOURCE === 'fav' ? '收藏' : SOURCE === 'expect' ? '意向页签' : '搜索'}: ${kw} ----`);
    let gotThisKw = 0;      // 本关键词拿到的「新」候选数
    let mergedThisKw = 0;   // 本关键词合并进来的卡片数（含池里已有的）

    if (SOURCE === 'fav') {
      // 【收藏翻页】页数由「还差多少个新的」决定：够了就停，不把每页都遍历完；
      // 某页一张卡片都没有 = 收藏已翻到底；最后有页数上限兜底（防跑飞）。
      // 再跑一轮时依旧从第 1 页开始 —— 池子里已有的会被 alreadyInPool 剔出计数（"爬去过的去掉"）。
      for (let p = 1; p <= FAV_MAX_PAGES; p++) {
        await checkpoint();
        const r = await loadListPage(kw, p);
        if (aborted) return;
        gotThisKw += r.fresh;
        mergedThisKw += r.added;
        const left = FORCE_MAX > 0 ? Math.max(0, FORCE_MAX - newTotal) : 0;
        log(`  收藏第 ${p} 页：合并 ${r.added} 个（其中新的 ${r.fresh} 个）｜累计新的 ${newTotal} 个`
          + (FORCE_MAX > 0 ? `，还差 ${left} 个` : ''), r.fresh ? 'OK' : '·');
        if (newTotal >= needNew) break;                                          // 数量够了 → 不再翻页
        if (r.maxSeen === 0) { log('  这页没有卡片，收藏已翻到底', '·'); break; }    // 到底了
        if (p < FAV_MAX_PAGES) {                                                 // 页间：拟人停顿 + 一次小滚动
          await sleep(rnd(1000, 2400));
          await humanWheelScroll(rt.page, rnd(500, 1000)).catch(() => {});
        }
      }
    } else {
      // 搜索 / 推荐 / 意向：列表是无限滚动，不翻页 —— 加载深度改成「按缺口补滚」（见 topUpByScroll）
      const r = await loadListPage(kw, 1);
      if (aborted) return;
      gotThisKw += r.fresh;
      mergedThisKw += r.added;
      if (r.maxSeen >= READY_N) await topUpByScroll(kw);   // 页面真的渲染出卡片才补滚
    }

    log(`  「${kw}」新增 ${gotThisKw} 个新的（合并 ${mergedThisKw} 个，累计候选 ${jobs.length}）`, gotThisKw ? 'OK' : 'WARN');
  }

  // 登录态失效：立刻收手（不推候选清单、不写汇总日志）—— 与原行为一致
  if (aborted) return;

  console.log('');
  console.log(cyan(`  共筛出 ${jobs.length} 个候选岗位`));
  log(`共筛出 ${jobs.length} 个候选岗位`);
  console.log(gray(`  过滤掉：非${CFG.cityName || '目标城市'} ${rejectedArea} 个 / 假卡片 ${rejectedJunk} 个（全职/实习在界面二次筛选里分）`));
  log(`过滤掉：非${CFG.cityName || '目标城市'} ${rejectedArea} / 假卡 ${rejectedJunk}（实习/全职的区分在二次筛选）`);
  // 把被滤的岗位名写出来 —— 不然"有一个没爬到"就得靠猜
  if (rejectedNames.length) {
    log(`  被滤岗位: ${rejectedNames.join('、')}${rejectedArea > rejectedNames.length ? ' 等' : ''}`);
  }
  // 把候选清单推给界面（界面可以逐条预览、勾选想投的）
  ipcEmit({
    t: 'candidates',
    jobs: jobs.map(j => ({ job: j.job, company: j.company, area: j.area, url: j.url })),
    stats: { total: jobs.length, rejectedArea, rejectedJunk },
  });
  }

  // ---------- 只读：打开详情页，抓 JD 正文 + 招聘者活跃度 ----------
  // collect 模式专用，一条消息都不发。
  // 活跃度只能在这里读 —— 列表卡片上没有这个信息（15 张卡片里 0 张有）。
  async function readJobDetail(job, attempt) {
    const desc = `「${job.job}」#${attempt}`;
    if (!await gotoWithGuard(job.url, desc, {
      verifyJs: DETAIL_LOADED_JS,
      maxAttempts: 2,
      referer: listReferer(),
      job,
    })) return null;

    // 拟人阅读（设置页可调：滚动 1~2 次 + 中间停顿，长 JD 多滚一次）。
    // 原来：滚一次 → 立刻读 —— 时序太机械（真人看 JD 是"滚 → 停 → 再看"）；
    // 读文本本身不受滚动位置影响，这纯是行为节奏信号。
    await humanWheelScroll(rt.page, paceRand('readScrollMinPx', 'readScrollMaxPx', 300, 700), { backRatio: 0.4 }).catch(() => {});
    // 轻量探测 JD 长度（本地读，无感），决定要不要多滚一次
    const jdProbeLen = await evalT(() => {
      const sels = ['.job-sec-text', '.job-detail-section .text', '.job-detail-section', '.detail-content', '.job-sec'];
      let n = 0;
      for (const s of sels) { const el = document.querySelector(s); if (el) n = Math.max(n, (el.innerText || '').length); }
      return n;
    }).catch(() => 0);
    await sleep(paceRand('readPauseMinMs', 'readPauseMaxMs', 1000, 2000));   // 看一会儿
    if (jdProbeLen > 800) {         // 长 JD：多滚一段（1.5 倍距离）再看
      await humanWheelScroll(rt.page, Math.round(paceRand('readScrollMinPx', 'readScrollMaxPx', 300, 700) * 1.5), { backRatio: 0.3 }).catch(() => {});
      await sleep(paceRand('readPauseMinMs', 'readPauseMaxMs', 1000, 2000));
    }

    const info0 = await evalT(() => {
      // JD 正文：按优先级找，都不行就退化成整页文本
      const sels = ['.job-sec-text', '.job-detail-section .text', '.job-detail-section', '.detail-content', '.job-sec'];
      let jd = '';
      for (const s of sels) {
        document.querySelectorAll(s).forEach(el => { jd += ' ' + (el.innerText || ''); });
        if (jd.trim().length > 80) break;
      }
      if (jd.trim().length < 80 && document.body) jd = document.body.innerText;

      const full = document.body ? document.body.innerText : '';

      // 薪资：列表页被字体混淆（抓出来全是 0），详情页是明文 —— 但数字由 JS 异步填充，
      // 刚加载完可能只有壳（"-元/天"），抓不到数字由外层轮询补抓。
      // 选择器修正：真实元素 class 就是 `salary`（精确类名选中它、不会选中右栏
      // 推荐的 `similar-job-salary`）；原来写的 `.job-_salary` 页面上根本没这个元素。
      let salary = '';
      const salSels = ['.salary', '.job-salary'];
      for (const s of salSels) {
        const el = document.querySelector(s);
        const t = el ? ((el.innerText || el.textContent || '')).trim() : '';
        if (t && /\d/.test(t) && !/^0+$/.test(t.replace(/\D/g, ''))) { salary = t.replace(/\s+/g, ' '); break; }
      }
      if (!salary) {
        const sm = full.slice(0, 400).match(/\d+(\.\d+)?\s*[-–~·]\s*\d+(\.\d+)?\s*(K|k|万|W|w|元\/(天|月|日))/);
        if (sm) salary = sm[0].replace(/\s+/g, '');
      }

      // 详细地址：详情页「工作地址」模块（.location-address），列表页只给到区
      let addr = '';
      const addrEl = document.querySelector('.location-address');
      if (addrEl) addr = (addrEl.innerText || '').replace(/\s+/g, ' ').trim();

      // 公司规模/行业：右栏「公司基本信息」（行序：公司名 / 规模 / 行业 / 查看全部职位）
      let companySize = '', industry = '';
      const scEl = document.querySelector('.sider-company');
      if (scEl) {
        const lines = (scEl.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        const li = lines.findIndex(l => /\d+\s*[-−~]\s*\d+人|少于\d+人|\d+人以上/.test(l));
        if (li >= 0) {
          companySize = lines[li];
          const nxt = lines.slice(li + 1).find(l => l && !/^查看/.test(l));
          if (nxt) industry = nxt;
        }
      }

      // 实习节奏：页头形如「北京 5天/周 3个月 本科」→ 每周天数（5 = 双休）/ 实习月数
      let daysPerWeek = 0, months = 0;
      const banEl = document.querySelector('.job-banner');
      const ban = banEl ? (banEl.innerText || '') : '';
      const dw = ban.match(/(\d+)\s*天\s*\/\s*周/);
      if (dw) daysPerWeek = parseInt(dw[1], 10) || 0;
      const mo = ban.match(/(\d+)\s*个月/);
      if (mo) months = parseInt(mo[1], 10) || 0;

      return {
        jd: jd.replace(/\s+/g, ' ').slice(0, 3000), salary, addr,
        companySize, industry, daysPerWeek, months,
      };
    }).catch(() => ({ jd: '', salary: '', addr: '', companySize: '', industry: '', daysPerWeek: 0, months: 0 }));

    // 招聘者活跃度：与「刷新活跃度」模式共用同一套页面侧读取（lib/job-active.js）。
    // 单独一次 evaluate：结构化定位 .boss-active-time / .boss-online-tag，读不到再留证。
    const act = await evalT(readActiveInPage).catch(() => ({ active: '', activeRaw: '' }));
    info0.active = act.active;
    info0.activeRaw = act.activeRaw;

    // 薪资数字是 JS 异步填充的：没等到就再等再抓（最多 3 轮 × 1.2s）
    for (let s = 0; s < 3 && !(info0.salary && /\d/.test(info0.salary)); s++) {
      await sleep(1200);
      info0.salary = await evalT(() => {
        const el = document.querySelector('.salary') || document.querySelector('.job-salary');
        const t = el ? (el.textContent || '').trim() : '';
        return /\d/.test(t) && !/^0+$/.test(t.replace(/\D/g, '')) ? t : '';
      }).catch(() => '');
    }
    // 活跃度同款补抓（多数页面 2 秒内就有，但连续快速翻页时偶发读到空壳）：
    // 没读到就再等再抓，最多 3 轮 × 1.2s —— 照抄上面薪资那一套。
    for (let s = 0; s < 3 && !info0.active; s++) {
      await sleep(1200);
      const r = await evalT(readActiveInPage).catch(() => ({ active: '', activeRaw: '' }));
      info0.active = r.active;
      if (r.active) info0.activeRaw = '';
    }
    if (info0.active) info0.activeRaw = '';   // 补抓到了就清掉留证字段，免得池子里两头都有值
    return info0;
  }

  // ---------- 模式：只收集（读 JD + 生成招呼语，一条消息都不发）----------
  // 界面工作台用这个模式：先让你看到每个岗位的 JD、招聘者活跃度、以及定制好的招呼语，
  // 你自己勾选、编辑，然后再调 send 模式发送。这样账号最安全 —— 发出去之前你都看过。
  async function runCollectMode(jobs) {
    // 配额算「新增」：池子里已有的重复岗位不占名额，自动继续
    // 往后读补位，直到补满或搜到的候选卡片读完（"除非爬不到了"）。
    // （例：池子已有 10 个、要爬 5 个，前 5 个里 2 个重复 → 继续往后补 2 个新的）
    const targetNew = FORCE_MAX > 0 ? FORCE_MAX : jobs.length;
    log(`开始逐个读取 JD（目标新增 ${targetNew} 个，重复自动补位，不发送任何消息）…`);
    ipcEmit({ t: 'collect-start', total: targetNew });

    // 已爬过的岗位直接跳过，不重复读 JD。
    // 去重原来只在最后写池子时做（读了再丢），"停了重新爬"会把刚爬过的岗位
    // 再完整读一遍（每个 4~11 秒 + 一次 BOSS 请求），用户体感就是"停止后
    // 没法接着爬、只能干等它重跑"。这里提前用池子里的 URL 建集合跳过。
    const alreadyInPool = loadPoolKeys();

    let okCount = 0;
    let skipExisting = 0;
    let stoppedEarly = false;   // 用户停止/安全熔断导致的提前退出（区别于"卡片读完"）
    const collectResults = [];
    // 遍历全部候选卡片；早停条件是「新增数达标」（不是「处理过 N 个」）——
    // 重复的跳过不占配额、读不到的也不算，循环自然往后补位
    for (let i = 0; i < jobs.length && okCount < targetNew; i++) {
      const job = jobs[i];

      try { await checkpoint(); }
      catch (e) {
        if (e && e.name === 'StoppedError') { log('已按你的要求停止', 'WARN'); stoppedEarly = true; break; }
        throw e;
      }

      // 【登录态早退】每个 job 开始前查一次，BOSS 踢登录了就立刻停
      // 此时页面已稳定（刚读过上一个 job 的 JD + 延时等待），完整检测可靠
      if (await checkLoginKick(`读取「${job.job}」前`, true)) { stoppedEarly = true; break; }

      // 已在池子里 → 跳过（勾选/招呼语/发送状态都是用户资产，绝不重爬覆盖）；
      // 跳过不占新增配额，循环继续往后补位
      if (alreadyInPool.has(poolKey(job.url))) {
        skipExisting++;
        log(`  「${job.job}」已在池子里，跳过（继续补位，还差 ${targetNew - okCount} 个）`, '·');
        ipcEmit({ t: 'collect-progress', index: okCount + 1, total: targetNew, current: job.job, skipped: true });
        continue;
      }

      if (sec.stop) {
        log(`安全熔断：本次运行已触发 ${SECURITY_STOP_AT} 次安全验证，为保护账号提前收手（已收 ${okCount} 个）`, 'ERR');
        ipcEmit({ t: 'error', msg: '安全熔断：一次运行内多次触发安全验证，已自动停止。建议今天少爬或隔天再试' });
        stoppedEarly = true;
        break;
      }

      console.log('');
      console.log(cyan(`  ▶ [新增 ${okCount + 1}/${targetNew}] ${job.job} @ ${job.company || '?'}`));
      ipcEmit({ t: 'collect-progress', index: okCount + 1, total: targetNew, current: job.job });

      let info = null;
      for (let a = 1; a <= 2 && !info; a++) {
        info = await readJobDetail(job, a).catch(() => null);
        if (!info && a < 2) {
          // 换新标签页再试，避免旧页状态残留
          try {
            const np = await rt.ctx.newPage();
            // attachPage / crashed 已由 connectBrowser 挂到共享的 rt 上，
            // 这里真正把 rt.page 切到新标签，重试不再空转。
            rt.attachPage(np);
            await np.bringToFront().catch(() => {});
            await rt.page.close().catch(() => {});
            rt.page = np;
            rt.crashed = false;
          } catch (_) {}
          await sleep(1200);
        }
      }

      if (!info || !info.jd) {
        log(`  读不到 JD，标记为失败`, 'WARN');
        ipcEmit({
          t: 'candidate',
          job: {
            url: job.url, job: job.job, company: job.company || '', area: job.area || '',
            salary: job.salary || '', jd: '', active: '', greeting: '', matched: '', addr: '',
            companySize: '', industry: '', daysPerWeek: 0, months: 0, failed: true,
          },
        });
        continue;
      }

      const g = await buildGreeting(job.job, info.jd);
      // 匹配到的经历名不进日志（没信息量），record 里保留 matched 字段供追溯
      log(`  JD ${info.jd.length} 字｜活跃度「${info.active || '未显示'}」${!info.active && info.activeRaw ? `（招聘者区块原文：${info.activeRaw}）` : ''}`, 'OK');

      const record = {
        url: job.url, job: job.job, company: job.company || '', area: job.area || '',
        addr: info.addr || '', companySize: info.companySize || '', industry: info.industry || '',
        daysPerWeek: info.daysPerWeek || 0, months: info.months || 0,
        salary: info.salary || job.salary || '', tags: job.tags || '',
        jd: info.jd.slice(0, 1200),
        jdLen: info.jd.length,
        active: info.active,
        // 活跃度读不到时的「留证」：招聘者区块原文（≤60 字），用来分清
        // 「BOSS 本来就没展示」还是「又没读到」；读到值时不写（见 readJobDetail 收尾）
        activeRaw: info.activeRaw || '',
        greeting: g.text,
        matched: g.matchedName,
        score: g.score,
        source: g.source,
      };
      // 【收藏来源】打标 src:'fav' —— 界面在岗位名前加「★」，
      // agent 也能一眼认出"这条是用户自己收藏的岗位"（只贴标签，不改别的逻辑）
      if (SOURCE === 'fav') record.src = 'fav';
      collectResults.push(record);
      ipcEmit({ t: 'candidate', job: record });
      okCount++;

      // 节奏加固（宁愿慢不要快）：真人看一个岗位详情至少几秒，
      // 爬得太快正是弹安全验证的主因。间隔随机化，下限抬高到 4 秒
      await sleep(nextCollectDelaySec() * 1000);   // 长尾：4~7 秒为主，偶尔 7~11 秒
    }

    // 没达标时区分原因：候选卡片读完（"爬不到了"）还是被停止
    const exhausted = okCount < targetNew && !stoppedEarly;
    log(`收集完成：新增 ${okCount} / 目标 ${targetNew} 个岗位拿到了 JD 和招呼语`
      + (skipExisting ? `（另跳过 ${skipExisting} 个重复的）` : '')
      + (exhausted ? `；候选卡片已读完（共 ${jobs.length} 个）` : ''), 'OK');
    // 落盘：按岗位 ID 合并进池子（不覆盖上一轮 —— 「少量多次、攒着统一筛」）
    // 已存在的岗位一律跳过：用户改过的招呼语/勾选/发送状态绝不被重爬污染
    const { added, dupSkipped } = mergeIntoPool(collectResults, targetNew, okCount);
    if (dupSkipped > 0) log(`池子里已有 ${dupSkipped} 个重复岗位，跳过（招呼语/勾选保持原样）`, '·');
    // 【收藏来源】收藏岗"默认过二筛"：把本轮真正新进池的收藏岗位回传，
    // 服务端合进勾选副本并广播（面板立刻勾上）。只在采集这一刻勾一次 —— 之后你手动
    // 取消就是取消，不会被下次采集反复勾回来。
    // （collectResults 里的岗位都已被 alreadyInPool 过滤过 → 全是本轮新进池的）
    if (SOURCE === 'fav') {
      const favUrls = collectResults.filter(r => r.src === 'fav').map(r => r.url);
      if (favUrls.length) ipcEmit({ t: 'fav-checked', urls: favUrls });
    }
    ipcEmit({ t: 'collect-done', ok: okCount, total: targetNew, added, skipped: skipExisting, exhausted });
    await waitEnter();
    await rt.closer();
    return;
  }

  return { waitForCards, runExpectsMode, collectJobs, readJobDetail, runCollectMode };
};
