/**
 * 发送 / 打招呼（从 greet.js 外提，纯搬运）
 * ----------------------------------------------------------------------------
 * runSendMode()：按界面清单逐个填/发送（只填不发、逐个确认流程）；
 * sendOne()：发送单个岗位；autoGreetAll()/greetOneJob()：命令行「逐个打招呼」。
 * 用法：const send = require('./lib/send')(deps);
 */
const fs = require('fs');
const { sleep, localDateTime, cyan } = require('./utils');

module.exports = (deps) => {
  const {
    rt, CFG, SENT_FILE, SEND_LIST_FILE, CONFIRM_EACH, FILL_ONLY,
    log, ipcEmit, checkpoint, StoppedError, isStopped, waitForCmd, hasCmdWaiter,
    buildGreeting, listReferer, paceRand, nextDelaySec, todayCount, waitEnter,
    clickGreetButton, clickSendButton, fillGreeting, confirmChangeJobDialog,
    gotoWithGuard, realUrl, loadSkipList, markFail, sec, SECURITY_STOP_AT,
  } = deps;

  // 招呼语填充模式（config.fillMode）：
  //   mix    每条随机「hybrid 分块粘贴」或「type 逐字」（默认，行为分布更自然）
  //   hybrid 全部走分块粘贴 + 真人修饰（1.5~3 秒/条）
  //   paste  全部走整段一次粘贴（最快 ~0.6 秒，但命中反爬 paste 检测的风险最高）
  //   type   全部走逐字输入（6~9 秒/条）
  const FILL_MODE = ['mix', 'hybrid', 'paste', 'type'].includes(CFG.fillMode) ? CFG.fillMode : 'mix';

  // mix 模式：每条按概率掷一次。hybrid 稍多（60%）—— 真人也是"大多复制、偶尔手打"，
  // 且 type 单条慢 3 倍，偏少一点整体才不会拖。
  function pickFillMode() {
    if (FILL_MODE !== 'mix') return FILL_MODE;
    return Math.random() < 0.6 ? 'hybrid' : 'type';
  }

  // ---------- 模式：按清单发送（清单由界面生成）----------
  // 到这里已经连上浏览器了。不搜索，直接按清单逐个发。
  async function runSendMode() {
    if (!SEND_LIST_FILE || !fs.existsSync(SEND_LIST_FILE)) {
      log('没找到发送清单文件，退出', 'ERR');
      ipcEmit({ t: 'send-done', sent: 0, skipped: 0, failed: 0, error: '清单文件不存在' });
      await rt.closer();
      return;
    }

    let list = [];
    try { list = JSON.parse(fs.readFileSync(SEND_LIST_FILE, 'utf8')); }
    catch (e) {
      log('发送清单解析失败：' + e.message, 'ERR');
      ipcEmit({ t: 'send-done', sent: 0, skipped: 0, failed: 0, error: e.message });
      await rt.closer();
      return;
    }
    if (!Array.isArray(list) || !list.length) {
      log('发送清单是空的，退出', 'WARN');
      ipcEmit({ t: 'send-done', sent: 0, skipped: 0, failed: 0, error: '清单为空' });
      await rt.closer();
      return;
    }

    log(`待发送 ${list.length} 个岗位（${FILL_ONLY ? '只填不发模式' : CONFIRM_EACH ? '逐个确认模式' : '自动发送模式'}）`);
    ipcEmit({ t: 'send-start', total: list.length, confirmEach: CONFIRM_EACH });

    let sent = 0, skipped = 0, failed = 0, filled = 0;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];

      try { await checkpoint(); }
      catch (e) {
        if (e && e.name === 'StoppedError') { log('已停止', 'WARN'); break; }
        throw e;
      }

      if (sec.stop) {
        log(`安全熔断：本次运行已触发 ${SECURITY_STOP_AT} 次安全验证，为保护账号停止发送`, 'ERR');
        ipcEmit({ t: 'error', msg: '安全熔断：一次运行内多次触发安全验证，已自动停止发送' });
        break;
      }

      console.log('');
      console.log(cyan(`  ▶ [${i + 1}/${list.length}] ${item.job} @ ${item.company || '?'}`));
      ipcEmit({
        t: 'send-progress', index: i + 1, total: list.length,
        current: item.job, company: item.company || '', sent, skipped, failed, filled,
      });

      let r = 'failed';
      for (let a = 1; a <= 2; a++) {
        r = await sendOne(item).catch(e => {
          if (e && e.name === 'StoppedError') throw e;
          log(`  出错：${String(e.message).slice(0, 80)}`, 'ERR');
          return 'failed';
        });
        if (r === 'sent' || r === 'skipped' || r === 'filled') break;
        // 失败就换新标签页再试一次
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
        await sleep(1000);
      }

      if (r === 'sent') sent++;
      else if (r === 'filled') filled++;
      else if (r === 'skipped') skipped++;
      else failed++;

      if (i < list.length - 1 && r === 'sent') {
        const d = nextDelaySec();
        log(`  等 ${d} 秒再继续…`);
        await sleep(d * 1000);
      } else if (i < list.length - 1) {
        await sleep(600 + Math.floor(Math.random() * 600));
      }
    }

    if (FILL_ONLY) log(`只填不发模式：${filled} 个岗位的招呼语已填进输入框，一个都没发送`, 'OK');
    else log(`发送完成：成功 ${sent} / 跳过 ${skipped} / 失败 ${failed}`, 'OK');
    // 收尾补一次最终进度：send-progress 是每个岗位「处理前」发的，最后一个
    // 岗位的 skip/failed 结果只在总结里出现——不补这发面板计数就少 1
    ipcEmit({
      t: 'send-progress', index: list.length, total: list.length,
      current: '', company: '', sent, skipped, failed, filled, final: true,
    });
    ipcEmit({ t: 'send-done', sent, skipped, failed, filled, fillOnly: FILL_ONLY, dailyUsed: todayCount(), dailyCap: CFG.dailyCap });
    await waitEnter();
    await rt.closer();
    return;
  }

  // ---------- 单个岗位打招呼（带内部重试）----------
  // 返回 'sent' | 'skipped' | 'guard' | 'reset'
  //
  // 【关键】BOSS 会在任意时刻把页面重置成 about:blank（反爬）。
  // 所以每一步操作前都要确认页面还在，一旦被重置就整体重来。
  async function pageAlive() {
    const u = await realUrl();
    return !!u && /zhipin\.com/.test(u) && !/about:blank/.test(u);
  }

  // 判断"用户是不是已经在浏览器里自己点了发送"
  // 【踩过的坑】旧版只要页面上有任意一个空 textarea 就判定"已发送"，
  // 结果填完 1 秒就被误判（页面上还有别的空输入框，或输入框被 React 重渲染）。
  // 现在只认"我们填过的那只框"（fillGreeting 打的 data-greet-box 标记）。
  async function inputCleared(hi) {
    // 空文本永远不算"已发出"：无字可清，清空判定会全程为真
    // （实测：空招呼语 → 打标记的空输入框 → 误判"疑似手动发出"并误标 sent）
    if (!hi || !String(hi).trim()) return false;
    return await rt.page.evaluate((text) => {
      const boxes = [...document.querySelectorAll('textarea, div[contenteditable="true"]')];
      // 只要还有输入框留着这段招呼语，就一定没发出去
      for (const el of boxes) {
        const v = (el.value !== undefined ? el.value : el.innerText) || '';
        if (text && v.includes(text)) return false;
      }
      // 只认填过的那只框：它空了 = 发出去了
      const marked = document.querySelector('[data-greet-box="1"]');
      if (marked) {
        const v = (marked.value !== undefined ? marked.value : marked.innerText) || '';
        return v.trim().length === 0;
      }
      // 标记框没了（页面重渲染）：用"消息列表里出现了这段招呼语"兜底
      if (text) {
        const body = document.body ? document.body.innerText : '';
        return body.includes(text);
      }
      return false;
    }, hi).catch(() => false);
  }

  // 等聊天输入框真的出现。
  // 【踩过的坑】点完"立即沟通"后面板有展开动画，固定等 900ms 经常不够，
  // 会误报"没找到输入框"。改成轮询等，出现就立刻继续。
  async function waitForInput(maxWaitMs = 9000, label = '') {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const st = await rt.page.evaluate(() => {
        const list = document.querySelectorAll('textarea, div[contenteditable="true"]');
        for (const t of list) {
          const r = t.getBoundingClientRect();
          if (r.width < 10 || r.height < 10) continue;
          const ph = t.getAttribute('placeholder') || '';
          if (/搜索|搜职位|请输入职位/.test(ph)) continue;
          return { input: true };
        }
        // 「换职位沟通」确认弹窗：文本恰为「沟通新职位」的可见元素（文案锚定，防误匹配）
        for (const el of document.querySelectorAll('button, div, a, span')) {
          if ((el.textContent || '').trim() !== '沟通新职位') continue;
          const r = el.getBoundingClientRect();
          if (r.width > 5 && r.height > 5) return { input: false, dialog: true };
        }
        return { input: false };
      }).catch(() => ({ input: false }));
      if (st.input) return true;
      // 弹窗出现 → 拟人点击「沟通新职位」继续（点掉后输入框才会出现）
      if (st.dialog && await confirmChangeJobDialog(rt.page)) {
        log(`${label ? label + '：' : ''}已确认「换职位沟通」（该 Boss 之前沟通过，继续）`, '·');
        await sleep(500);   // 弹窗关闭 + 面板打开
        continue;
      }
      await sleep(350);
    }
    return false;
  }

  // 在"逐个确认"期间盯着浏览器：你手动点了发送就自动继续下一个
  async function pollManualSend(hi) {
    for (let i = 0; i < 2600; i++) {          // 约 30 分钟
      await sleep(700);
      if (isStopped()) return 'STOP';
      if (!hasCmdWaiter()) return new Promise(() => {});   // 界面已经给了指令，这条分支作废
      if (!await pageAlive()) return new Promise(() => {});
      if (await inputCleared(hi)) return 'MANUAL';
    }
    return 'TIMEOUT';
  }

  // ---------- 发送单个岗位的招呼语 ----------
  // 返回 'sent' | 'skipped' | 'failed'
  async function sendOne(item) {
    const desc = `「${item.job}」`;

    if (!await gotoWithGuard(item.url, desc, {
      verifyJs: `(function(){
        var t = document.body ? document.body.innerText : '';
        return /立即沟通|打招呼|继续沟通/.test(t);
      })()`,
      maxAttempts: 2,
      referer: listReferer(),
      job: item,
    })) return 'failed';

    if (!await pageAlive()) { log(`${desc}：页面被重置`, 'WARN'); return 'failed'; }

    // 拟人停顿（设置页可调，默认 0~2 秒）：真人点开岗位会扫一眼再决定沟通；
    // 原来页面一就绪就点（<1 秒），是发送主路径上最明显的时序特征
    await sleep(paceRand('clickPauseMinMs', 'clickPauseMaxMs', 0, 2000));

    // 点"立即沟通"
    if (!await clickGreetButton(rt.page)) {
      log(`${desc}：没有沟通按钮（可能已沟通过），跳过`, 'SKIP');
      return 'skipped';
    }
    if (!await pageAlive()) { log(`${desc}：面板打开后页面被重置`, 'WARN'); return 'failed'; }

    // 等输入框真的出现（面板有动画，固定等待会误报）；
    // 期间若弹出「换职位沟通」确认框会自动点「沟通新职位」继续
    const boxReady = await waitForInput(9000, desc);
    if (!boxReady) {
      if (!await pageAlive()) { log(`${desc}：等输入框时页面被重置`, 'WARN'); return 'failed'; }
      log(`${desc}：等了 9 秒输入框还没出现，跳过`, 'SKIP');
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'skipped';
    }

    // 把招呼语填进输入框（再给几次机会，输入框刚出现时可能还没拿到焦点）
    const hi = (item.greeting || '').trim() || (await buildGreeting(item.job, item.jd || '')).text;
    // 空招呼语直接跳过（别填空气——空框会被误判"已发送"）
    if (!hi || !hi.trim()) {
      log(`${desc}：没有可用的招呼语（greeting 与 JD 均为空），跳过`, 'SKIP');
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'skipped';
    }
    const usedMode = pickFillMode();   // mix 模式下每条随机一次
    let filledOk = false;
    for (let t = 0; t < 4 && !filledOk; t++) {
      if (t > 0) await sleep(600);
      filledOk = await fillGreeting(rt.page, hi, { mode: usedMode });
    }
    if (!filledOk) {
      log(`${desc}：输入框出现了但文字没填进去，跳过`, 'SKIP');
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'skipped';
    }
    const modeName = usedMode === 'hybrid' ? '分块粘贴' : usedMode === 'paste' ? '整段粘贴' : '逐字输入';
    log(`${desc}：招呼语已填进输入框（${hi.length} 字 · ${modeName}）`, '·');

    // ---- 【只填不发】填好就停，绝不碰发送按钮 ----
    // 你在浏览器里自己点发送；脚本检测到输入框清空（= 已发出）就自动进下一个。
    // 这是默认方式 —— 主动权全在你手里。
    if (FILL_ONLY) {
      // 记一条「已填入到输入框」—— 记录页是时间线：填入一条，发送成功再记一条
      fs.appendFileSync(SENT_FILE, `${localDateTime()} | ${item.job} | ${item.company || ''} | 已填入到输入框\n`);
      ipcEmit({
        t: 'awaiting', url: item.url, job: item.job, company: item.company || '', greeting: hi, manualOnly: true,
      });
      log(`${desc}：招呼语已填进输入框 —— 请在浏览器里点发送，发完我自动进下一个`, 'WAIT');

      const cmd = await Promise.race([waitForCmd(), pollManualSend(hi)]);
      if (cmd === 'STOP') throw new StoppedError();

      if (cmd === 'MANUAL') {
        fs.appendFileSync(SENT_FILE, `${localDateTime()} | ${item.job} | ${item.company || ''} | 已发送\n`);
        log(`✓ 招呼语已发（你在浏览器里手动点的）：${item.job}`, 'OK');
        ipcEmit({ t: 'sent', url: item.url, job: item.job, company: item.company || '', greeting: hi, manual: true });
        await sleep(700);
        return 'sent';
      }

      // SKIP（界面点了跳过）或超时
      log(`${desc}：已跳过`, 'SKIP');
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'skipped';
    }

    // ---- 逐个确认模式：界面点「发送」，或你直接在浏览器里点 ----
    if (CONFIRM_EACH) {
      ipcEmit({
        t: 'awaiting', url: item.url, job: item.job, company: item.company || '', greeting: hi,
      });
      log(`${desc}：已填好，等你确认 —— 在界面点「发送」，或直接在浏览器里点发送`, 'WAIT');

      // 一边等界面指令，一边盯着浏览器：
      // 你要是在浏览器里自己点了发送，输入框会清空，脚本识别到就自动进入下一个。
      const cmd = await Promise.race([waitForCmd(), pollManualSend(hi)]);

      if (cmd === 'STOP') throw new StoppedError();
      if (cmd === 'MANUAL') {
        fs.appendFileSync(SENT_FILE, `${localDateTime()} | ${item.job} | ${item.company || ''} | 已发送\n`);
        log(`✓ 招呼语已发（你在浏览器里手动点的）：${item.job}`, 'OK');
        ipcEmit({ t: 'sent', url: item.url, job: item.job, company: item.company || '', greeting: hi, manual: true });
        await sleep(700);
        return 'sent';
      }
      if (cmd === 'SKIP' || cmd === 'TIMEOUT') {
        log(`${desc}：已跳过`, 'SKIP');
        await rt.page.keyboard.press('Escape').catch(() => {});
        return 'skipped';
      }

      await sleep(500);
      // 兜底：SEND 回来后如果你已经手动发过了，也算成功
      if (await inputCleared(hi)) {
        fs.appendFileSync(SENT_FILE, `${localDateTime()} | ${item.job} | ${item.company || ''} | 已发送\n`);
        log(`✓ 招呼语已发（你在浏览器里手动点的）：${item.job}`, 'OK');
        ipcEmit({ t: 'sent', url: item.url, job: item.job, company: item.company || '', greeting: hi, manual: true });
        await rt.page.keyboard.press('Escape').catch(() => {});
        await sleep(700);
        return 'sent';
      }
    }

    // 点发送（发送按钮是 div.send-message）
    if (await clickSendButton(rt.page)) {
      fs.appendFileSync(SENT_FILE, `${localDateTime()} | ${item.job} | ${item.company || ''} | 已发送\n`);
      log(`✓ 招呼语已发：${item.job} @ ${item.company || '?'}`, 'OK');
      ipcEmit({ t: 'sent', url: item.url, job: item.job, company: item.company || '', greeting: hi });
      await rt.page.keyboard.press('Escape').catch(() => {});
      await sleep(700);
      return 'sent';
    }

    if (await inputCleared(hi)) {
      fs.appendFileSync(SENT_FILE, `${localDateTime()} | ${item.job} | ${item.company || ''} | 已发送\n`);
      log(`✓ 招呼语已发（疑似手动发出）：${item.job}`, 'OK');
      ipcEmit({ t: 'sent', url: item.url, job: item.job, company: item.company || '', greeting: hi });
      return 'sent';
    }

    if (!await pageAlive()) { log(`${desc}：发送前页面被重置`, 'WARN'); return 'failed'; }
    log(`${desc}：没找到发送按钮，跳过`, 'SKIP');
    return 'skipped';
  }

  // ---------- 逐个打招呼（命令行 auto 模式）----------
  // sent 由 greetOneJob 自增、autoGreetAll 读取（与 CLI 的 auto 模式一致）
  let sent = 0;

  async function greetOneJob(job, attempt) {
    const desc = `「${job.job}」#${attempt}`;

    // 1. 打开详情页
    if (!await gotoWithGuard(job.url, desc, {
      verifyJs: `(function(){
        var t = document.body ? document.body.innerText : '';
        return /立即沟通|打招呼|继续沟通/.test(t);
      })()`,
      maxAttempts: 2,
      referer: listReferer(),
      job,
    })) return 'guard';

    // 2. 立刻抓 JD 正文（约 200ms），用于生成个性化招呼语。
    // 必须抢在风控重置页面前完成。
    const jdText = await rt.page.evaluate(() => {
      const sels = ['.job-sec-text', '.job-detail-section .text', '.job-detail-section', '.detail-content', '.job-sec'];
      let out = '';
      for (const s of sels) {
        document.querySelectorAll(s).forEach(el => { out += ' ' + (el.innerText || ''); });
        if (out.trim().length > 80) break;
      }
      // 兜底：整页文本（含公司简介、职位描述）
      if (out.trim().length < 80 && document.body) out = document.body.innerText;
      return out.replace(/\s+/g, ' ').slice(0, 3000);
    }).catch(() => '');

    const g = await buildGreeting(job.job, jdText);
    log(`${desc}：JD ${jdText.length} 字 → 匹配「${g.matchedName}」(分 ${g.score})`, '·');
    // 让界面能看到"这条到底发了什么"
    ipcEmit({ t: 'greeting', job: job.job, company: job.company || '', text: g.text, matched: g.matchedName, source: g.source });

    if (!await pageAlive()) { log(`${desc}：页面在操作前被重置`, 'WARN'); return 'reset'; }

    // 拟人停顿（设置页可调，默认 0~2 秒）：同 sendOne，点击前模拟"扫一眼"
    await sleep(paceRand('clickPauseMinMs', 'clickPauseMaxMs', 0, 2000));

    // 3. 点"立即沟通"
    const clicked = await clickGreetButton(rt.page);
    if (!clicked) {
      if (!await pageAlive()) { log(`${desc}：点击时页面被重置`, 'WARN'); return 'reset'; }
      log(`${desc}：没有沟通按钮（可能已沟通过）`, 'SKIP');
      return 'skipped';
    }
    log(`${desc}：已点开沟通面板`, '·');

    // 4. 等面板出现（轮询代替固定等待：面板有动画 + 可能要处理「换职位沟通」确认框）
    await waitForInput(6000, desc);
    await sleep(400 + Math.floor(Math.random() * 300));   // 面板动画收尾
    if (!await pageAlive()) { log(`${desc}：面板打开后页面被重置`, 'WARN'); return 'reset'; }

    // 5. 填个性化招呼语
    const hi = g.text;
    // 空招呼语直接跳过（同 sendOne 的说明）
    if (!hi || !hi.trim()) {
      log(`${desc}：没有可用的招呼语（greeting 与 JD 均为空），跳过`, 'SKIP');
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'skipped';
    }
    if (!await fillGreeting(rt.page, hi, { mode: pickFillMode() })) {
      if (!await pageAlive()) { log(`${desc}：填字前页面被重置`, 'WARN'); return 'reset'; }
      log(`${desc}：没找到输入框`, 'SKIP');
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'skipped';
    }

    await sleep(400 + Math.floor(Math.random() * 300));
    if (!await pageAlive()) { log(`${desc}：填字后页面被重置`, 'WARN'); return 'reset'; }

    // 6. 点发送
    if (await clickSendButton(rt.page)) {
      sent++;
      fs.appendFileSync(SENT_FILE, `${localDateTime()} | ${job.job} | ${job.company || ''} | 已发送\n`);
      log(`✓ 招呼语已发：${job.job} @ ${job.company || '?'} [${g.matchedName}]`, 'OK');
      return 'sent';
    }

    if (!await pageAlive()) { log(`${desc}：发送前页面被重置`, 'WARN'); return 'reset'; }
    log(`${desc}：没找到发送按钮`, 'SKIP');
    return 'skipped';
  }

  // ---------- 逐个打招呼 ----------
  async function autoGreetAll(jobs, maxJobs, done) {
  let guardHits = 0, resetHits = 0, blacklisted = 0;
  const skipMap = loadSkipList();
  const skipThreshold = CFG.skipFailedAfter || 2;
  const maxAttemptsPerJob = CFG.jobRetryPerJob || 2;

  let stopped = false;
  for (const job of jobs) {
    // 暂停/停止在这里生效：只在两个岗位之间，绝不会打断正在进行的点击
    try { await checkpoint(); }
    catch (e) {
      if (e && e.name === 'StoppedError') { stopped = true; log('已按你的要求停止', 'WARN'); break; }
      throw e;
    }

    if (sent >= maxJobs) { log(`本次上限 ${maxJobs} 已到，停`); break; }
    if (done + sent >= CFG.dailyCap) { log(`今日上限已到，停`); break; }

    // 黑名单：这个岗位之前反复失败，跳过（省时间）
    const failCount = skipMap.get(job.url) || 0;
    if (failCount >= skipThreshold) {
      blacklisted++;
      continue;
    }

    console.log('');
    console.log(cyan(`  ▶ [已发 ${sent}/${maxJobs}] ${job.job} @ ${job.company || '?'}`));
    ipcEmit({
      t: 'progress', sent, blacklisted, maxJobs, total: jobs.length,
      current: job.job, company: job.company || '', area: job.area || '',
    });

    let result = 'skipped';
    for (let attempt = 1; attempt <= maxAttemptsPerJob; attempt++) {
      result = await greetOneJob(job, attempt);

      if (result === 'sent' || result === 'skipped') break;

      if (result === 'reset') {
        resetHits++;
        // 换新标签页，避免旧页状态残留
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
        // 【提速】原来等 2~4 秒，实测 1 秒足够让风控窗口过去
        await sleep(900 + Math.floor(Math.random() * 500));
        continue;
      }

      if (result === 'guard') {
        guardHits++;
        break;   // guard 已在内部处理过，换下一个岗位
      }
    }

    // 失败/被重置的岗位记入黑名单，累计够次数就不再尝试
    if (result === 'reset') {
      markFail(skipMap, job.url);
    }

    if (guardHits >= 3) { log('安全验证连出 3 次，今天先收手', 'ERR'); break; }

    // 拟人间隔
    if (result === 'sent' && sent < maxJobs) {
      const d = nextDelaySec();
      log(`  等 ${d} 秒再继续…`);
      await sleep(d * 1000);
    } else {
      // 【提速】失败换岗不再多等，立刻下一个
      await sleep(600 + Math.floor(Math.random() * 600));
    }
  }

  if (blacklisted > 0) {
    log(`本次跳过黑名单岗位 ${blacklisted} 个（累计失败 ${skipThreshold} 次以上）`);
  }

  ipcEmit({
    t: 'done', sent, skipped: 0, blacklisted, stopped,
    total: jobs.length, dailyUsed: done + sent, dailyCap: CFG.dailyCap,
  });
  return sent;
  }

  return { runSendMode, autoGreetAll };
};
