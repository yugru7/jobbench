/**
 * 登录 / 安全验证 / 导航守卫（从 greet.js 外提，纯搬运）
 * ----------------------------------------------------------------------------
 * 只读登录态、扫码等待、安全验证（风控）处理与熔断、带验证的导航。
 * 用法：const guard = require('./lib/login-guard')(deps);
 */
const { sleep } = require('./utils');

module.exports = (deps) => {
  const { rt, log, ipcEmit, isGuardUrl, StoppedError, isStopped } = deps;

  // ---------- 登录检查 ----------
  // 【必须先确认登录】没登录就继续跑 = 白跑一趟还浪费机会。
  // 判定方法：BOSS 页面顶部，登录后显示的是你的名字，没登录显示"登录/注册"。
  async function checkLogin() {
    return await rt.page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      const hasLoginEntry = /登录\/注册|立即登录/.test(t.slice(0, 1500));
      return { loggedIn: !hasLoginEntry && t.length > 300, bodyLen: t.length };
    }).catch(() => ({ loggedIn: false, bodyLen: 0 }));
  }

  // 没登录就打开登录页等你扫码，最多等 10 分钟；登录成功自动继续
  async function ensureLogin() {
    let st = await checkLogin();
    if (st.loggedIn) { log('登录态有效', 'OK'); return true; }

    log('检测到未登录 —— 打开登录页等你扫码（最多等 10 分钟）', 'WARN');
    await rt.page.goto('https://www.zhipin.com/web/user/?ka=header-login', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    }).catch(() => {});
    await rt.page.bringToFront().catch(() => {});
    ipcEmit({ t: 'login-needed' });

    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      if (isStopped()) throw new StoppedError();
      // 用户主动把登录页关了（不是面板 stop）：page 被 close = 放弃登录，立刻退出
      try { if (rt.page.isClosed()) { log('登录页已被关闭，本轮结束', 'WARN'); ipcEmit({ t: 'login-closed' }); return false; } } catch (_) {}
      // 确保真的离开了登录路径才判定为"可能已登录"
      // 竞态：BOSS 弹新 tab 登录，用户关了那个 tab 但 rt.page 还指向原 tab，
      // 原 tab 的 bodyLen 可能还 > 300（缓存），checkLogin 会误判为已登录。
      // 所以多一道闸门：URL 必须真的不在 /web/user/ 登录路径下
      const u = await realUrl();
      const onLoginPath = /\/web\/user\/|\/login|\/passport|\/account|\/signin/.test(u);
      if (onLoginPath) continue;   // 还在登录页，再等一轮
      if (!/zhipin\.com/.test(u)) continue;
      st = await checkLogin();
      if (st.loggedIn) {
        log('登录成功，继续', 'OK');
        ipcEmit({ t: 'login-ok' });
        return true;
      }
    }
    log('等了 10 分钟还没登录成功，本次结束', 'ERR');
    ipcEmit({ t: 'login-timeout' });
    return false;
  }

  // ---------- 运行中登录态守卫 ----------
  // 爬取中途如果 BOSS 把你踢回登录页（风控 / 会话过期），继续跑只会拿到空数据。
  // 检测到就立刻停，emit kicked-login 事件让面板显示警告。
  // 两种场景都挡：
  //   A) 开始时 ensureLogin 失败（用户关了登录 tab） → ensureLogin 已 return false
  //   B) 爬取中途被踢（最常见）→ 这里检测，collect.js 循环里调
  //
  // strict=false（快速路径，goto 完立刻用）：只查 URL 是否落登录路径 —— URL 是同步的，
  // goto(domcontentloaded) 完立刻可靠；**不查 bodyLen** —— 页面还在加载 bodyLen 小是正常的。
  // strict=true（稳定路径，每个 job 前用）：同时查 URL + bodyLen + 登录入口 ——
  // 此时页面已稳定渲染完，bodyLen 检测可靠，能抓到"URL 没变但内容是登录壳"的场景。
  async function isKickedToLogin(strict = false) {
    try {
      const u = await rt.page.evaluate(() => (typeof location !== 'undefined' ? location.href : '')).catch(() => '');
      // 1) URL 落到登录路径 → 肯定被踢了（goto 完立刻可靠）
      if (/\/web\/user\/|\/login|\/passport|\/account|\/signin/.test(u)) return true;
      if (!strict) return false;   // 快速路径：到这里就停
      // 2) 严格检测：URL 在 BOSS 域名内但 body 显示登录入口 / bodyLen 异常短
      if (/zhipin\.com/.test(u)) {
        const st = await rt.page.evaluate(() => {
          const t = document.body ? document.body.innerText : '';
          const hasLoginEntry = /登录\/注册|立即登录|扫码登录/.test(t.slice(0, 1500));
          return { bodyLen: t.length, hasLoginEntry };
        }).catch(() => ({ bodyLen: 0, hasLoginEntry: true }));
        if (st.hasLoginEntry || st.bodyLen < 200) return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  // ---------- 安全验证处理 ----------
  // ---------- 账号安全（风控自保） ----------
  // BOSS 弹安全验证 = 风控黄牌。策略：过验证后先冷却再继续；一次运行内
  // 触发满 2 次就自动收手 —— 账号被限制的代价远大于少爬一批岗位。
  const sec = { hits: 0, stop: false };
  const SECURITY_STOP_AT = 2;
  const cooldownMs = () => 60000 + Math.floor(Math.random() * 60000);   // 60~120 秒随机

  async function passGuard(label) {
    if (sec.stop) {
      log('安全熔断已触发：为保护账号，本轮不再处理验证，直接收手', 'ERR');
      return false;
    }
    const onGuard = isGuardUrl(await realUrl());
    const onPage = !onGuard && await isSecurityPage();
    if (!onGuard && !onPage) return true;

    // 面板模式：提示打给界面（黑控制台没人看得见），轮询等用户在浏览器里手动完成。
    // 【踩过的坑】旧版在这里等「黑窗口按回车」（waitEnter）—— 服务托管跑的时候
    // 根本没人能按，等于干等 25 秒后误报失败；用户手点过了纯属赶巧。
    log('BOSS 弹了安全验证 —— 请在浏览器窗口里手动完成（滑块拖到底 / 按提示点选），最多等 5 分钟', 'WARN');
    ipcEmit({ t: 'security', on: true });

    const deadline = Date.now() + 5 * 60 * 1000;
    let solved = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      const u = await realUrl();
      if (onGuard) {
        // URL 守卫场景：离开守卫页回到 zhipin 即算过（页面可能还在跳转，不查页内内容）
        if (!isGuardUrl(u) && /zhipin\.com/.test(u)) { solved = true; break; }
      } else if (!(await isSecurityPage())) {
        solved = true; break;
      }
    }
    ipcEmit({ t: 'security', on: false });
    if (solved) {
      sec.hits++;
      if (sec.hits >= SECURITY_STOP_AT) sec.stop = true;
      const cd = cooldownMs();
      log(`${label}：验证已过。冷却 ${Math.round(cd / 1000)} 秒再继续（刚被风控盯上，缓一缓更安全）`, 'OK');
      await sleep(cd);
      return true;
    }
    log(`${label}：等了 5 分钟验证仍未通过，本次尝试放弃（后续会重试）`, 'WARN');
    return false;
  }

  // 页内真实 URL。page.url() 反映的是浏览器侧记录，可能和实际渲染的内容不一致。
  async function realUrl() {
    return await rt.page.evaluate(() => (typeof location !== 'undefined' ? location.href : '')).catch(() => '');
  }

  // 页内安全验证：URL 不变，验证内容直接渲染在页面里。
  // 加长度闸门（<800 字）：防误伤 JD 里恰好提到「安全验证/滑块」的正常岗位页
  async function isSecurityPage() {
    return await rt.page.evaluate(() => {
      const t = document.body ? (document.body.innerText || '') : '';
      if (t.length > 800) return false;
      return /安全验证|环境异常|完成验证|拖动滑块/.test(t);
    }).catch(() => false);
  }

  // 导航到目标页并确认"真的到了"。
  //
  // 【踩过的坑】存在两种假成功：
  //   1. page.goto() 返回 200、page.url() 显示已在 BOSS，
  //      但页内 location.href 还是上一页（DOM 也是上一页的）。
  //   2. 页内 location.href 确实到了 BOSS，但约 30 秒后
  //      BOSS 的反爬会把页面弹回上一页（中间经过 /web/user/）。
  //      → 所以"URL 到了"不算成功，必须以"目标内容出现"为准。
  async function gotoWithGuard(url, desc, opts = {}) {
    const { expectSelector = null, verifyJs = null, maxAttempts = 4, referer, onOffline } = opts;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // referer：详情页导航时带上列表页地址（补「列表→详情」跳转链，见 listReferer 注释）；
        // 不传时 undefined = 浏览器默认行为（搜索页导航就用默认，不带）
        await rt.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000, referer });
      } catch (e) {
        log(`${desc}：goto 抛错（${e.message.slice(0, 50)}），重试`, 'WARN');
        await sleep(700);
        continue;
      }

      // 轮询：等目标内容出现（400ms 一次）
      // 【关键修复】不能一看到非 zhipin 的 URL 就判定"被弹回"：
      // 页面在导航提交前会短暂显示 about:blank（约 0.5~2 秒），
      // 误判会立刻放弃重试 —— 大量时间浪费在这。
      // 正确做法：只有在"确实见过 zhipin 页"之后又连续离开，才算真被弹回。
      let ok = false;
      let sawZhipin = false, offStreak = 0;

      for (let i = 0; i < 50; i++) {
        await sleep(400);
        const u = await realUrl();

        // 撞安全验证 → 交给 passGuard 处理
        if (isGuardUrl(u)) {
          if (!await passGuard(`${desc}(第${attempt}次)`)) break;
          continue;
        }

        if (/zhipin\.com/.test(u)) {
          sawZhipin = true;
          offStreak = 0;
          // 验证内容直接渲染在页内（URL 不变）的情况：页面稳定后检测，同样交给 passGuard 等人工
          if (i >= 8 && i % 5 === 3 && await isSecurityPage()) {
            if (!await passGuard(`页内安全验证`)) break;
          }
          // 快速识别岗位已下架/失效，直接跳过不浪费等待时间
          const pageText = await rt.page.evaluate(() => document.body ? document.body.innerText.slice(0, 500) : '').catch(() => '');
          if (/职位已下线|职位不存在|岗位已下架|该职位正在审核|页面不存在|职位已关闭/.test(pageText)) {
            log(`${desc}：岗位已下架/失效，快速跳过`, 'SKIP');
            // 通知 server 从候选池里删掉这条 —— 面板表里实时消失
            if (opts.job) ipcEmit({ t: 'job-offline', url, job: opts.job.job, company: opts.job.company });
            // onOffline：让调用方知道"这次失败是岗位真没了"，好同步自己的内存副本
            // （server 已删磁盘，但调用方手里那份 doc 还留着它，下次整份写回会把它写回来）
            if (typeof onOffline === 'function') { try { onOffline(); } catch (_) {} }
            return false;
          }
        } else {
          if (u) offStreak++;
          // 真被弹回：曾到过 zhipin，且连续 3 次(1.2秒)离开
          if (sawZhipin && offStreak >= 3) break;
          // 还没到过 → 仍在加载，继续等
          continue;
        }

        if (expectSelector) {
          const n = await rt.page.evaluate(
            (sel) => document.querySelectorAll(sel).length, expectSelector
          ).catch(() => 0);
          if (n > 0) { ok = true; break; }
        } else if (verifyJs) {
          const v = await rt.page.evaluate((js) => {
            try { return !!eval(js); } catch (_) { return false; }
          }, verifyJs).catch(() => false);
          if (v) { ok = true; break; }
        } else {
          ok = true;
          break;
        }
      }

      if (ok) {
        log(`${desc} 就绪`, '·');
        return true;
      }

      const u = await realUrl();
      log(`${desc}：第 ${attempt} 次未成功（当前 ${u.slice(0, 55) || '空'}），重试`, 'WARN');

      // 换新标签页，避免旧页状态残留
      if (attempt >= 2 && attempt < maxAttempts) {
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
      // 【提速】原来等 3~6 秒，1~2 秒足够
      await sleep(1000 + Math.floor(Math.random() * 1000));
    }

    log(`${desc}：反复失败，跳过`, 'SKIP');
    return false;
  }

  return { checkLogin, ensureLogin, passGuard, realUrl, isSecurityPage, isKickedToLogin, gotoWithGuard, sec, SECURITY_STOP_AT };
};
