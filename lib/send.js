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
    clickGreetButton, clickSendButton, fillGreeting, cancelChangeJobDialog, readQuotaDialog, dismissQuotaDialog,
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

    let sent = 0, skipped = 0, failed = 0, filled = 0, dupHR = 0;
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
        if (r === 'sent' || r === 'skipped' || r === 'filled' || r === 'dup-hr' || r === 'quota-stop') break;
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
      else if (r === 'dup-hr') dupHR++;
      else failed++;

      // 平台今日沟通额度用尽：不再往后面的岗位空跑
      if (r === 'quota-stop') {
        log(`平台今日沟通次数已用完（已与 ${todayCount()} 位沟通），本轮停止`, 'ERR');
        ipcEmit({ t: 'send-capped', capped: true, kept: 0, remaining: 0, reason: 'platform-quota' });
        break;
      }

      if (i < list.length - 1 && r === 'sent') {
        const d = nextDelaySec();
        log(`  等 ${d} 秒再继续…`);
        await sleep(d * 1000);
      } else if (i < list.length - 1) {
        await sleep(600 + Math.floor(Math.random() * 600));
      }
    }

    if (FILL_ONLY) log(`只填不发模式：${filled} 个岗位的招呼语已填进输入框，一个都没发送`, 'OK');
    else log(`发送完成：成功 ${sent} / 跳过 ${skipped} / 失败 ${failed}${dupHR ? ` / 已在沟通 ${dupHR}` : ''}`, 'OK');
    // 收尾补一次最终进度：send-progress 是每个岗位「处理前」发的，最后一个
    // 岗位的 skip/failed 结果只在总结里出现——不补这发面板计数就少 1
    ipcEmit({
      t: 'send-progress', index: list.length, total: list.length,
      current: '', company: '', sent, skipped, failed, filled, dupHR, final: true,
    });
    ipcEmit({ t: 'send-done', sent, skipped, failed, filled, dupHR, fillOnly: FILL_ONLY, dailyUsed: todayCount(), dailyCap: CFG.dailyCap });
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
    // （空招呼语 → 打标记的空输入框 → 误判"疑似手动发出"并误标 sent）
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
  //
  // 轮询期间顺手识别两种"挡路弹窗"：
  //   · 同一 HR 已在沟通（「是否就新职位继续沟通？」）→ 不重复发，交给调用方跳过并标记
  //   · 平台沟通额度提示（「还剩 N 次沟通机会」）→ 读出数字报给面板、点掉它、剩 0 立即停
  //
  // 【顺序很重要】弹窗必须先判、输入框必须后判 —— 同一 HR 已在沟通时 BOSS 会跳到
  // 聊天页（/web/geek/chat），而聊天页**本来就有消息输入框**；先判输入框会立刻返回成功，
  // 于是弹窗被无视、招呼语照旧打进输入框（真实踩过）。
  // 返回：{ ok:true } | { dupHR:true } | { quotaStop:true } | { ok:false }（超时）
  async function waitForInput(maxWaitMs = 9000, label = '') {
    const deadline = Date.now() + maxWaitMs;
    const pfx = label ? label + '：' : '';
    let quotaHits = 0;
    let inputSince = 0;   // 首次看到输入框的时刻（见下面的"稳定期"）
    while (Date.now() < deadline) {
      const st = await rt.page.evaluate(() => {
        const body = document.body ? document.body.innerText : '';

        // ① 同一 HR 已在沟通的弹窗：可见的「沟通新职位」按钮 + 页面有「已沟通过」文案
        //    （只按按钮文案判会误伤页面里其他同名入口，两个条件同时成立才认）
        if (/您与该Boss已沟通过|是否就新职位/.test(body)) {
          for (const el of document.querySelectorAll('button, div, a, span')) {
            if ((el.textContent || '').trim() !== '沟通新职位') continue;
            const r = el.getBoundingClientRect();
            if (r.width > 5 && r.height > 5) return { dupHR: true };
          }
        }

        // ② 平台沟通额度提示：文案锚定「还剩 N 次沟通机会」/「已与 N 位BOSS沟通」
        if (/次沟通机会/.test(body) || /位BOSS沟通/.test(body)) return { quota: true };

        // ③ 聊天输入框（放最后：聊天页常驻该输入框，不能让它盖住上面的弹窗判断）
        const list = document.querySelectorAll('textarea, div[contenteditable="true"]');
        for (const t of list) {
          const r = t.getBoundingClientRect();
          if (r.width < 10 || r.height < 10) continue;
          const ph = t.getAttribute('placeholder') || '';
          if (/搜索|搜职位|请输入职位/.test(ph)) continue;
          return { input: true };
        }
        return { input: false };
      }).catch(() => ({ input: false }));

      // 同一 HR 已在沟通：不点「沟通新职位」（点它 = 把招呼语重复发给该 HR 的另一个岗位）
      if (st.dupHR) {
        await cancelChangeJobDialog(rt.page);
        return { dupHR: true };
      }

      // 平台额度弹窗：读数字 → 报面板 → 点「好」关掉
      if (st.quota) {
        quotaHits++;
        if (quotaHits > 3) return { ok: false };   // 反复弹就放弃，按超时处理，别死循环
        const q = await readQuotaDialog(rt.page);
        if (!q) await dismissQuotaDialog(rt.page);
        if (q && (q.used != null || q.remaining != null)) {
          const parts = [];
          if (q.used != null) parts.push(`已与 ${q.used} 位 BOSS 沟通`);
          if (q.remaining != null) parts.push(`还剩 ${q.remaining} 次沟通机会`);
          log(`${pfx}平台额度提示：${parts.join('，')}`, q.remaining != null && q.remaining <= 5 ? 'WARN' : '·');
          ipcEmit({ t: 'quota', used: q.used, remaining: q.remaining, job: label });
          if (q.remaining != null && q.remaining <= 0) return { quotaStop: true };
        } else {
          log(`${pfx}平台弹了额度提示，但没读到数字`, 'WARN');
        }
        await sleep(500);
        continue;
      }

      // 输入框要"稳定"一小段才算数：
      // 点「立即沟通」后 BOSS 先渲染聊天页（输入框立刻在），弹窗晚 200~600ms 才出现；
      // 一看到输入框就返回会漏掉随后弹出的「已在沟通」框（真实踩过）。
      if (st.input) {
        if (!inputSince) {
          inputSince = Date.now();
          await sleep(700);       // 观察窗：等弹窗有机会渲染出来
          continue;
        }
        if (Date.now() - inputSince >= 650) return { ok: true };
        await sleep(150);
        continue;
      }
      inputSince = 0;

      await sleep(350);
    }
    return { ok: false };
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

  // 清掉我们填进去的招呼语（fillGreeting 会给输入框打 data-greet-box 标记）。
  // 只动那只框，不碰页面其他内容，也不触发任何点击。
  async function clearGreetBox() {
    await rt.page.evaluate(() => {
      const el = document.querySelector('[data-greet-box="1"]');
      if (!el) return;
      if (el.value !== undefined) {
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      }
    }).catch(() => {});
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
    // 期间：同一 HR 已在沟通 → 跳过并标记；平台额度弹窗 → 读数字报面板、剩 0 立即停
    const wait = await waitForInput(9000, desc);
    if (wait.dupHR) {
      log(`${desc}：该 HR 已在沟通中（这是 TA 的另一个岗位），不重复发 —— 已标记，以后不再尝试`, 'SKIP');
      ipcEmit({ t: 'dup-hr', url: item.url, job: item.job, company: item.company || '' });
      fs.appendFileSync(SENT_FILE, `${localDateTime()} | ${item.job} | ${item.company || ''} | 该 HR 已在沟通，跳过\n`);
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'dup-hr';
    }
    if (wait.quotaStop) {
      log(`${desc}：平台今日沟通次数已用完，停止发送`, 'ERR');
      ipcEmit({ t: 'quota-stop', job: item.job });
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'quota-stop';
    }
    if (!wait.ok) {
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
    // 【填字前复核】弹窗可能比输入框晚渲染，稳定期也不一定稳吃到：
    // 真出现「同一 HR 已在沟通」就立刻取消、标记、跳过 —— 一个字都不填。
    if (await cancelChangeJobDialog(rt.page)) {
      log(`${desc}：该 HR 已在沟通中（这是 TA 的另一个岗位），不重复发 —— 已标记，以后不再尝试`, 'SKIP');
      ipcEmit({ t: 'dup-hr', url: item.url, job: item.job, company: item.company || '' });
      fs.appendFileSync(SENT_FILE, `${localDateTime()} | ${item.job} | ${item.company || ''} | 该 HR 已在沟通，跳过\n`);
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'dup-hr';
    }

    const usedMode = pickFillMode();   // mix 模式下每条随机一次
    let filledOk = false;
    for (let t = 0; t < 4 && !filledOk; t++) {
      if (t > 0) await sleep(600);
      filledOk = await fillGreeting(rt.page, hi, { mode: usedMode });
    }

    // 【填字后复核】填的过程中弹窗才出现（极慢网络）：把刚填进去的字撤掉再跳过，
    // 绝不让「已填好、等人点发送」这一步落在同一个 HR 的第二个岗位上。
    if (filledOk && await cancelChangeJobDialog(rt.page)) {
      await clearGreetBox();
      log(`${desc}：填字后才发现该 HR 已在沟通 —— 已撤销输入并跳过`, 'SKIP');
      ipcEmit({ t: 'dup-hr', url: item.url, job: item.job, company: item.company || '' });
      fs.appendFileSync(SENT_FILE, `${localDateTime()} | ${item.job} | ${item.company || ''} | 该 HR 已在沟通，跳过\n`);
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'dup-hr';
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

    // 4. 等面板出现（轮询代替固定等待；同一 HR 已在沟通 → 跳过并标记，额度用完 → 停）
    const wait = await waitForInput(6000, desc);
    if (wait.dupHR) {
      log(`${desc}：该 HR 已在沟通中（这是 TA 的另一个岗位），不重复发 —— 已标记，以后不再尝试`, 'SKIP');
      ipcEmit({ t: 'dup-hr', url: job.url, job: job.job, company: job.company || '' });
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'dup-hr';
    }
    if (wait.quotaStop) {
      log(`${desc}：平台今日沟通次数已用完，停止发送`, 'ERR');
      ipcEmit({ t: 'quota-stop', job: job.job });
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'quota-stop';
    }
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
    // 填字前复核弹窗（同 sendOne）
    if (await cancelChangeJobDialog(rt.page)) {
      log(`${desc}：该 HR 已在沟通中（这是 TA 的另一个岗位），不重复发 —— 已标记，以后不再尝试`, 'SKIP');
      ipcEmit({ t: 'dup-hr', url: job.url, job: job.job, company: job.company || '' });
      await rt.page.keyboard.press('Escape').catch(() => {});
      return 'dup-hr';
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
  let guardHits = 0, resetHits = 0, blacklisted = 0, dupHR = 0;
  let quotaStop = false;
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

      if (result === 'sent' || result === 'skipped' || result === 'dup-hr' || result === 'quota-stop') break;

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
        // 【提速】原来等 2~4 秒，1 秒足够让风控窗口过去
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
    if (result === 'dup-hr') dupHR++;
    // 平台今日沟通额度用尽：不再往后面的岗位空跑
    if (result === 'quota-stop') { quotaStop = true; break; }

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
  if (dupHR > 0) {
    log(`其中 ${dupHR} 个岗位的 HR 已在沟通中（TA 的另一个岗位），没有重复发 —— 已标记，以后不再尝试`);
  }
  if (quotaStop) {
    log(`平台今日沟通次数已用完（已与 ${todayCount()} 位沟通），提前收工`, 'ERR');
  }

  ipcEmit({
    t: 'done', sent, skipped: 0, blacklisted, stopped, dupHR, quotaStop,
    total: jobs.length, dailyUsed: done + sent, dailyCap: CFG.dailyCap,
  });
  return sent;
  }

  return { runSendMode, autoGreetAll };
};
