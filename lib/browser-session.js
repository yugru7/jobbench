/**
 * 浏览器会话：连接/启动/复用/保活 Chrome（从 greet.js 的 connectBrowser() 外提，纯搬运）
 * ----------------------------------------------------------------------------
 * CDP 模式连接"真实 Chrome"，独立模式用 Patchright 自管 Chrome；任务结束后默认保持浏览器开着。
 * 用法：const { connectBrowser } = require('./lib/browser-session')(deps);
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sleep, rnd, withoutProxy, CHROME, cyan, gray, white, red } = require('./utils');

module.exports = (deps) => {
  const {
    rt, CFG, USE_CDP, CDP_PORT, ENGINE_NAME, chromium, killChromeUsingProfile,
    CLOSE_BROWSER, KEEP_OPEN_MAX_MS, log, ipcEmit, checkpoint, waitForCmdWithin,
  } = deps;

  // 【血泪教训 1】Chrome 的窗口遮挡检测会把后台窗口的渲染进程冻结，
  // 表现为：goto 返回 200，但页面永远是 <html><head></head><body></body></html> 全白。
  // 必须禁用这些节流机制。
  //
  // 【血泪教训 2】绝对不要加 --disable-blink-features=AutomationControlled！
  // 这是最反直觉的一个坑：它本意是"隐藏自动化特征"，但 BOSS 专门检测这个标志位被禁用，
  // 反而判定为自动化 → 直接喂空页。实测：
  //   加了这个参数 → 0 个岗位 / 空页
  //   不加         → 17 个岗位 / 正常
  const NO_THROTTLE_ARGS = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ];

  // 【A + 同标签翻页】找出一个「已经停在 BOSS 上」的标签页（取最后建的那个，
  // 最接近你眼前正在看的那个）。列表页 / 详情页都算 —— 复用它，下一轮就在原地翻页。
  function reuseBossPage(ctx) {
    try {
      const hit = ctx.pages().filter((p) => {
        try { return /zhipin\.com/.test(p.url() || ''); } catch (_) { return false; }
      });
      return hit.length ? hit[hit.length - 1] : null;
    } catch (_) { return null; }
  }

  // 【A + 同标签翻页】启动 Chrome 时用的是 about:blank，会留下一个空白标签。
  // 没有 BOSS 标签页可复用时就拿它当工作页，避免窗口上平白多挂一个空标签。
  function blankPage(ctx) {
    try {
      const hit = ctx.pages().filter((p) => {
        try { const u = p.url() || ''; return u === 'about:blank' || u.startsWith('chrome://newtab'); } catch (_) { return false; }
      });
      return hit.length ? hit[0] : null;
    } catch (_) { return null; }
  }

  async function connectBrowser() {
  // 【A + 同标签翻页】这个浏览器是不是"本来就热着"（复用来的）。
  // 是 → 跳过预热：Chrome 已经是热的、登录态是活的，再把页面 goto 到普通网站纯属白等，
  //      还会把 BOSS 那个标签页翻走再翻回来（真人不会这样操作）。
  // 否 → 全新启动的冷浏览器，照旧预热（老注释：不预热直接开 BOSS，卡片会明显变少）。
  let warmBrowser = false;
  if (USE_CDP) {
    // CDP 模式：连接"真实 Chrome"，比 Playwright 自己起浏览器更难被风控识别。
    // 脚本自己负责启动 Chrome（带调试端口），不要求用户先手动开。
    const endpoint = `http://127.0.0.1:${CDP_PORT}`;

    async function cdpAlive() {
      try {
        const r = await withoutProxy(() => fetch(`${endpoint}/json/version`));
        return r.ok;
      } catch (_) { return false; }
    }

    // 杀掉占用我们这个自动化 profile 的 Chrome（只杀这些，绝不动用户日常 Chrome）
    function killOurChrome() {
      return new Promise((resolve) => {
        // 原来用 -like '*路径*' 并把反斜杠写成 \\ —— PowerShell 的 -like
        // 里反斜杠不是转义符，于是模式变成"必须含双反斜杠"，实际一个都匹配不上、杀不掉。
        // 症状：日志打「重启调试 Chrome」，其实 Chrome 没重启，白白等 5 秒才继续。
        // 改用 .Contains()：纯字面量匹配，不牵扯通配符转义。
        const safeDir = CFG.profileDir.replace(/'/g, "''");
        const ps = spawn('powershell', ['-NoProfile', '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${safeDir}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
        ], { stdio: 'ignore' });
        ps.on('exit', () => resolve());
        ps.on('error', () => resolve());
        setTimeout(resolve, 8000);
      });
    }

    // 【提速】只在必要时才重启 Chrome。
    // 之前每次运行都无条件重启，白等 10 秒。
    // 现在用一个标记文件记录"当前这个 Chrome 是用正确参数启动的"。
    const LAUNCH_MARK = path.join(CFG.profileDir, '.greet-launched');

    // 开跑前先清一次「残留 Chrome」：
    //   调试端口不通、却有 chrome 占着我们这个 profile（上次异常退出 / 独立模式遗留）——
    //   先把它清掉再启动，避免残留实例和新实例抢同一个 profile。
    //   只杀命令行里带我们这个 profile 路径的 chrome.exe，不动你日常的 Chrome。
    //   端口通时不清 —— 那是我们自己的调试 Chrome（要复用，就地翻页设计）。
    if (!await cdpAlive()) {
      const stray = killChromeUsingProfile();
      if (stray > 0) {
        log(`开跑前清掉 ${stray} 个占着 profile 的残留 Chrome，等它退出…`, '·');
        await sleep(rnd(1500, 2500));
      }
    }

    if (await cdpAlive()) {
      const marked = fs.existsSync(LAUNCH_MARK);
      if (marked) {
        warmBrowser = true;
        log('复用已在运行的调试 Chrome（参数正确，跳过重启）', 'OK');
      } else {
        log('重启调试 Chrome（启用抗节流参数，登录态会保留）…');
        await killOurChrome();
        for (let i = 0; i < 10 && await cdpAlive(); i++) await sleep(500);
        warmBrowser = await cdpAlive();   // 没杀成 → 还是那个已经热着的浏览器
      }
    }

    if (!await cdpAlive()) {
      warmBrowser = false;             // 全新启动 → 浏览器是冷的，需要预热
      if (!CHROME) { console.error('找不到 Chrome，无法启动'); process.exit(1); }

      // （残留 Chrome 已在上面「开跑前清残留」里处理过，这里不用再清）
      log(`启动 Chrome（调试端口 ${CDP_PORT}）…`);

      // 清掉上次异常退出的锁，否则 Chrome 会复用旧实例、端口起不来
      for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try { fs.rmSync(path.join(CFG.profileDir, f), { force: true }); } catch (_) {}
      }

      const child = spawn(CHROME, [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${CFG.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        ...NO_THROTTLE_ARGS,
        'about:blank',
      ], { detached: true, stdio: 'ignore' });
      child.unref();

      for (let i = 0; i < 40; i++) {
        await sleep(700);
        if (await cdpAlive()) { log(`Chrome 就绪（${(i + 1) * 0.7}s）`, 'OK'); break; }
      }

      // 打标记：下次直接复用，不再重启
      try { fs.writeFileSync(LAUNCH_MARK, String(Date.now()), 'utf8'); } catch (_) {}
    }

    try {
      rt.browser = await withoutProxy(() => chromium.connectOverCDP(endpoint, { timeout: 25000 }));
    } catch (e) {
      console.log('');
      console.log(red('  CDP 连接失败：' + e.message.slice(0, 120)));
      console.log('');
      console.log(white('  排查：'));
      console.log(gray('    1. 确认 Chrome 没有被完全关掉'));
      console.log(gray('    2. 端口被占用的话换一个：node greet.js --cdp-port 9333'));
      console.log(gray('    3. 或改用独立模式：node greet.js --no-cdp'));
      console.log('');
      process.exit(1);
    }

    const contexts = rt.browser.contexts();
    rt.ctx = contexts[0];
    // 【A + 同标签翻页】优先复用「已经停在 BOSS 上的那个标签页」，
    // 而不是每轮新开一个 —— 于是下一轮的 page.goto 就变成在同一个标签里就地翻页，
    // 浏览器窗口全程不关不重开（旧做法每轮 kill + relaunch：既费时，又像个机器）。
    const bossPage = reuseBossPage(rt.ctx);
    if (bossPage) {
      rt.page = bossPage;
      // 顺手收掉启动时留下的空白页（about:blank / 新标签页），免得一直挂在窗口上
      try {
        for (const p of rt.ctx.pages()) {
          if (p === bossPage) continue;
          const u = p.url() || '';
          if (u === 'about:blank' || u.startsWith('chrome://newtab')) await p.close().catch(() => {});
        }
      } catch (_) {}
      log('复用已有的 BOSS 标签页（下一轮就地翻页）', 'OK');
    } else {
      // 没有 BOSS 标签页（比如你手动关了）：优先拿启动时那个空白页当工作页，别再多开一个
      rt.page = blankPage(rt.ctx) || await rt.ctx.newPage();
      log('没有 BOSS 标签页，从空白页开始', 'OK');
    }

    // 【A + 同标签翻页】收尾**不再关页面** —— 这是本方案的关键：
    //   ① 窗口和标签保持原样，下一轮直接在同一个标签里翻页（不再"关掉再重开"）；
    //   ② 「只填不发」填进输入框的招呼语、以及你手动点发送，都靠这个页面活着。
    //   Chrome 是 detached（--remote-debugging-port + unref）起的，node 进程退出它不会死
    //   —— 已实测确认（探针退出后端口仍在、窗口仍在）。所以这里什么都不用做。
    //   真要关浏览器走面板「关闭 BOSS」→ routes/close-browser.js 的 killKeptBrowser()。
    // 【血泪教训】CDP 模式下绝对不要调 browser.close()：文档说是"断开连接"，
    //   实测它会把整个 Chrome 关掉。进程退出时 CDP 连接自动断开，浏览器毫发无损。
    rt.closer = async () => {
      // 告诉面板「浏览器还开着」—— 面板据此点亮「浏览器：已打开」并进入空闲态
      ipcEmit({ t: 'browser-kept' });
    };
    log('已连上，用你的真实登录态', 'OK');
  } else {
    // ---------- 默认路径：Patchright 自己启动并管理 Chrome ----------
    if (!CHROME) { console.error('找不到 Chrome'); process.exit(1); }

    // 清掉上次异常退出留下的锁，否则 Chrome 会拒绝启动
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.rmSync(path.join(CFG.profileDir, f), { force: true }); } catch (_) {}
    }

    // 上次任务留下的浏览器还开着的话，先关掉（profile 被占着，新的起不来）
    const killed = killChromeUsingProfile();
    if (killed > 0) {
      log(`已关闭上次遗留的浏览器（${killed} 个进程），等它完全退出…`);
      // Stop-Process 是异步生效的，立刻启动会撞上还没释放的 profile 锁
      await sleep(rnd(2200, 3200));
    }

    log(`启动浏览器（${ENGINE_NAME}）…`);
    try {
      rt.ctx = await chromium.launchPersistentContext(CFG.profileDir, {
        executablePath: CHROME,
        headless: false,
        viewport: null,                    // 跟随真实窗口尺寸，方便你在浏览器里手动操作
        args: NO_THROTTLE_ARGS,
        ignoreDefaultArgs: ['--enable-automation'],
      });
    } catch (e) {
      // 必须走 log()（会同时推给界面），不然界面上只看到"退出了"却不知道为什么
      log(`浏览器启动失败：${e.message.slice(0, 140)}`, 'ERR');
      ipcEmit({ t: 'error', msg: '浏览器启动失败：' + e.message.slice(0, 140) });
      console.log('');
      console.log(white('  排查：'));
      console.log(gray('    1. 把已经开着的那个自动化 Chrome 窗口关掉（profile 被占用）'));
      console.log(gray(`    2. 确认 profile 目录存在：${CFG.profileDir}`));
      console.log('');
      process.exit(1);
    }
    rt.page = await rt.ctx.newPage();

    // ---------- 收尾：默认「保持浏览器开着」 ----------
    // 为什么不能关：招呼语是页面状态，关掉就没了。
    // 你要能看着输入框里的内容自己点发送，所以任务结束后浏览器必须留着。
    // 实测确认 Node 进程一退，launchPersistentContext 起的 Chrome 就跟着死，
    // 所以这里不是"不调 close"就行，得让进程继续活着等指令。
    rt.closer = async () => {
      if (CLOSE_BROWSER) {
        await Promise.race([rt.ctx.close().catch(() => {}), sleep(4000)]);
        return;
      }
      console.log('');
      console.log(cyan('  ============================================================'));
      console.log(cyan('   浏览器保持开着 —— 你可以去浏览器里查看内容、手动点发送'));
      console.log(gray('   要关闭它，在界面上点「关闭 BOSS」'));
      console.log(cyan('  ============================================================'));
      console.log('');
      ipcEmit({ t: 'browser-kept' });

      const cmd = await waitForCmdWithin(KEEP_OPEN_MAX_MS);

      if (cmd === 'TIMEOUT') log('保持超时（1 小时），自动关闭 BOSS', 'WARN');
      else log('收到关闭指令，正在关闭 BOSS…');
      await Promise.race([rt.ctx.close().catch(() => {}), sleep(5000)]);
      ipcEmit({ t: 'browser-closed' });
    };
    log('浏览器已就绪，使用你保存的登录态', 'OK');
  }

  // 把标签页置前，避免被 Chrome 当作后台页降级
  await rt.page.bringToFront().catch(() => {});

  // attachPage / crashed 原来定义在本函数内部（模块作用域外），
  // 别的模块（send/collect/login-guard）里"失败换新标签重试"时调用它会抛
  // ReferenceError 被 catch(_){} 吞掉 —— 结果新标签建出来就丢掉、rt.page 也没切，
  // 重试全程在坏页上空转（白等最久）。现在挂到共享的 rt 上，换页真正生效。
  rt.crashed = false;
  rt.attachPage = function (p) {
    p.on('crash', () => { rt.crashed = true; log('页面崩溃', 'ERR'); });
  };
  rt.attachPage(rt.page);

  // 预热：先访问一个普通网站。
  // 实测不预热直接开 BOSS，首页渲染会明显变慢（卡片少甚至只有 1 张）。
  // 随机化预热站 —— 原来固定 example.com，那是自动化
  // 脚本的典型特征（真人几乎不访问它）；换成常见中文站随机选
  // 去掉 www.163.com —— 视频/广告重页面，冷启动那一刻 GPU/CPU
  // 峰值最高；实测崩溃就发生在预热 163 之后。只留轻量站。
  const WARMUP_SITES = [
    'https://www.baidu.com',
    'https://cn.bing.com',
  ];
  if (warmBrowser) {
    log('浏览器已是热的（复用来的），跳过预热', 'OK');
  } else {
    const warmupUrl = WARMUP_SITES[rnd(0, WARMUP_SITES.length - 1)];
    log(`预热浏览器（${warmupUrl.replace(/^https:\/\//, '')}）…`);
    // 预热/登录阶段原本没有任何检查点：用户点「停止」要等 12 秒
    // 强杀才生效（表现为"点了没停"）。这两处 checkpoint 让停止在 1~2 秒内响应。
    await checkpoint();
    await rt.page.goto(warmupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(rnd(1800, 3200));
  }
  }

  return { connectBrowser };
};
