/**
 * 页面操作助手（纯 Playwright 操作，零状态依赖）
 * ----------------------------------------------------------------------------
 * 【血泪教训】点击必须用 Playwright 原生 locator().click()。
 * 实测对比（同一职位、同一账号）：
 *   locator().click()        → 面板正常打开，页面稳定 ✅
 *   evaluate(el => el.click()) → 触发风控，页面被重置成 about:blank ❌
 * BOSS 的 JS 能区分"可信事件"和"JS 合成事件"，后者直接判定为机器人。
 */

// 按可见文案点元素：labels 依次尝试，preferButton=true 时优先 button
async function clickByText(page, labels, preferButton = false) {
  for (const label of labels) {
    const sels = preferButton
      ? ['button', 'a']
      : ['a', 'button', 'div[class*="btn"]', 'span[class*="btn"]'];

    for (const sel of sels) {
      try {
        const loc = page.locator(sel).filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
        if (await loc.count() === 0) continue;
        await humanClick(page, loc, { timeout: 6000 });   // 拟人：轨迹 + 随机落点 + 按压时长
        return true;
      } catch (_) { /* 换下一种选择器 */ }
    }
  }
  return false;
}

// 先按已知的好选择器点，再退化到文案匹配
async function clickGreetButton(page) {
  // BOSS 职位详情页的打招呼按钮（实测可用）
  const known = ['a.btn-startchat', 'div.btn-startchat-wrap', 'a[class*="startchat"]'];
  for (const sel of known) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() === 0) continue;
      await humanClick(page, loc, { timeout: 8000 });
      return true;
    } catch (_) {}
  }
  // 退路：按文案找
  return await clickByText(page, ['立即沟通', '打招呼', '继续沟通']);
}

// 点发送。
// 【血泪教训】BOSS 的发送按钮是 <div class="send-message">，不是 button 也不是 a。
// 用文案匹配 "发送" 在 button/a 里永远找不到。
async function clickSendButton(page) {
  const known = ['div.send-message', '.send-message', '[class*="send-message"]'];
  for (const sel of known) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() === 0) continue;
      await humanClick(page, loc, { timeout: 8000 });
      return true;
    } catch (_) {}
  }
  // 退路：按文案找（含 div）
  for (const label of ['发送', '发送消息']) {
    try {
      const loc = page.locator('div, button, a, span').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).last();
      if (await loc.count() === 0) continue;
      await humanClick(page, loc, { timeout: 6000 });
      return true;
    } catch (_) {}
  }
  return false;
}

// 「已沟通过该 Boss，是否就新职位继续沟通」确认弹窗（换职位沟通）。
// 场景：与该 Boss 沟通过其他职位后，对它的**新职位**点「立即沟通」——BOSS 弹
// 「温馨提示：您与该Boss已沟通过，是否就新职位继续沟通？」（「取消」/「沟通新职位」）。
// 不点掉它，聊天输入框永远不会出现（实测 2026-10-12：同一 Boss 换职位投递连续
// 2 次失败被跳过；截图确认了弹窗文案）。
// 单次检测：页面上有「沟通新职位」按钮就拟人点击返回 true；没有/点失败返回 false。
// 由调用方的等待循环反复调用（没弹窗的岗位零额外等待）。
async function confirmChangeJobDialog(page) {
  try {
    // 文案锚定 ^$：只有文本**恰为**「沟通新职位」的元素才匹配
    // （弹窗外层容器的文本含更多内容，不会误匹配）
    const btn = page.locator('button, div, a, span')
      .filter({ hasText: /^\s*沟通新职位\s*$/ })
      .last();
    if (await btn.count() === 0) return false;
    if (!await btn.isVisible().catch(() => false)) return false;
    await humanClick(page, btn, { timeout: 5000 });
    return true;
  } catch (_) { return false; }
}

// ---------- 招呼语填充：hybrid（默认）/ paste / type ----------
// 【2026-10-12 调研 + 实测定稿】
// 1) 开源拟人打字库（humanization-playwright 600CPM、cloakbrowser humanize、
//    humanize-automation）全是「逐字 + 随机延迟」方向 —— 越像人越慢，
//    100 字中文要 10 秒，解决不了「21 岗跑 7 分钟」的诉求，且都是 Python 栈。
//    结论：不引入依赖，只提炼思路。
// 2) 也不能整段一次粘贴：反爬厂商公开把 paste 列为最高收益检测信号
//    （webdecoy：单 paste + 零击键 = agent 信号；TransmitSecurity 用
//     inputType=insertFromPaste 做 input-method 分析）。
// 3) 反直觉的事实：Playwright 的 type() 对**中文**走 Input.insertText，
//    不产生 keydown —— 原来 6 秒的逐字输入在检测眼里是「100 个 input、
//    0 次击键」，和粘贴属于同一类问题，只是摊平在时间上。
// → 所以取混合：分块粘贴（块间真人停顿）+ 粘贴后人工修饰（真实 Backspace
//   + 补字）+ 发送前停顿。既有击键流又有 paste 事件，
//   耗时从 6~9 秒降到 1.5~3 秒。
const fillPause = (ms) => new Promise((r) => setTimeout(r, ms));
const fillRnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// 按标点把文案切成 n 块（尽量在标点处断开，像"分几次粘 / 分几次改"）
function splitChunks(text, n) {
  if (n <= 1 || text.length < 30) return [text];
  const size = Math.ceil(text.length / n);
  const out = [];
  let start = 0;
  for (let k = 1; k < n; k++) {
    const ideal = start + size;
    let cut = -1, bestD = 1e9;
    const lo = Math.max(start + 10, ideal - 15);
    const hi = Math.min(text.length - 10, ideal + 15);
    for (let i = lo; i <= hi; i++) {
      if (/[，。；、！？：,.!?;:]/.test(text[i])) {
        const d = Math.abs(i - ideal);
        if (d < bestD) { bestD = d; cut = i + 1; }
      }
    }
    if (cut < 0) cut = ideal;
    out.push(text.slice(start, cut));
    start = cut;
  }
  out.push(text.slice(start));
  return out.filter((s) => s.length);
}

// 写剪贴板：现代 clipboard API 优先（需授权），execCommand 兜底
// 授权只做一次（2026-10-13：实测每次粘贴都 grantPermissions 会白花 2~3 次 CDP 往返）
let clipboardGrantedAt = '';
async function writeClipboard(page, text) {
  try {
    const origin = new URL(page.url()).origin;
    if (clipboardGrantedAt !== origin) {
      await page.context()
        .grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
        .catch(() => {});
      clipboardGrantedAt = origin;
    }
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    return true;
  } catch (_) {}
  try {
    await page.evaluate((t) => {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('data-greet-tmp', '1');
      ta.style.cssText = 'position:fixed;top:-2000px;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, t.length);
      document.execCommand('copy');
      ta.remove();
    }, text);
    return true;
  } catch (_) {}
  return false;
}

// 逐字输入（type 模式）：5~15ms/字符，粘不了时的兜底路径
async function fillByType(page, el, text) {
  try {
    for (const ch of text) {
      await el.type(ch, { timeout: 3000 });
      await fillPause(5 + Math.floor(Math.random() * 10));
    }
    return true;
  } catch (_) { return false; }
}

// 分块粘贴 + 真人修饰
async function fillByPaste(page, el, text, chunksN) {
  const chunks = splitChunks(text, chunksN);
  for (let i = 0; i < chunks.length; i++) {
    if (!await writeClipboard(page, chunks[i])) return false;
    // 【实测教训 2026-10-13】粘贴前绝对不能 click：点击会把光标定位到输入框
    // 中心（实测 43 字文本点在第 26 字处），第二块会插进文本中间 → 内容错乱。
    // 正确做法：只 focus 保持焦点，再把光标强制移到末尾。
    await el.focus().catch(() => {});
    await el.evaluate((e) => {
      if (e.value != null && e.setSelectionRange) { e.setSelectionRange(e.value.length, e.value.length); return; }
      if (e.isContentEditable) {
        const r = document.createRange();
        r.selectNodeContents(e);
        r.collapse(false);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
    }).catch(() => {});
    await page.keyboard.press('Control+V');
    if (i < chunks.length - 1) await fillPause(fillRnd(200, 600));
  }
  // 真人修饰：60% 概率改一下（删掉末字再补回）—— 让输入框留下真实击键痕迹
  if (Math.random() < 0.6) {
    await fillPause(fillRnd(150, 450));
    await page.keyboard.press('Backspace');
    await fillPause(fillRnd(120, 380));
    // 直接用 keyboard 对当前焦点输入（不重新 focus 元素，避免 contenteditable 光标被重置），
    // 末字给真实打字节奏；按码点取末字避免 emoji 被拆半
    const lastChar = [...text].pop() || '';
    await page.keyboard.type(lastChar, { delay: fillRnd(30, 80) }).catch(() => {});
  }
  await fillPause(fillRnd(250, 700));   // 粘完"看一眼"再发送
  return true;
}

// 读输入框当前内容（用于填充后校验）
async function boxText(el) {
  return await el
    .evaluate((e) => (e.value != null ? e.value : (e.innerText || '')))
    .catch(() => '');
}

// 把招呼语填进聊天输入框（跳过搜索框，认"聊天框特征"）
// opts.mode: 'hybrid'（默认，分块粘贴+修饰）| 'paste'（整段一次）| 'type'（逐字）
async function fillGreeting(page, text, opts = {}) {
  // 【2026-10-13 防御】空招呼语不填：填了也没意义，且空框会被「输入框已清空」
  // 检测误判成"已发送"（实测：greeting 与 JD 都为空时误报 + 误标 sent）
  if (!text || !String(text).trim()) return false;
  const mode = opts.mode || 'hybrid';
  // 优先用实测可用的 textarea（BOSS 聊天框 placeholder="请简短描述您的问题"）
  const candidates = [
    'textarea',
    'div[contenteditable="true"]',
    'input[type="text"]',
  ];

  for (const sel of candidates) {
    try {
      const all = page.locator(sel);
      const n = await all.count();
      for (let i = 0; i < n; i++) {
        const el = all.nth(i);
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        const ph = (await el.getAttribute('placeholder').catch(() => '')) || '';
        if (/搜索|搜职位|请输入职位/.test(ph)) continue;   // 跳过搜索框
        // 聊天框特征：placeholder 含"描述/问题"，或类名含 chat/edit
        const cls = (await el.getAttribute('class').catch(() => '')) || '';
        const isChat = /描述|问题|打招呼|消息/.test(ph) || /chat|edit|send|message/i.test(cls);
        if (!isChat && sel !== 'textarea') continue;

        await humanClick(page, el, { timeout: 5000, paddingRatio: 0.35 });   // 点输入框也走拟人轨迹

        let okFill = false;
        if (mode === 'type') {
          okFill = await fillByType(page, el, text);
        } else {
          // paste=整段一次（最快、风险最高）；hybrid=随机 2~3 块
          okFill = await fillByPaste(page, el, text, mode === 'paste' ? 1 : fillRnd(2, 3));
          if (!okFill) okFill = await fillByType(page, el, text);   // 剪贴板不可用 → 退回逐字
        }

        // 内容校验：必须与目标【严格一致】（去空白比较）—— 宁可退回 fill 也不能发错内容。
        // 长度阈值不够：分块粘贴若错位，长度照样够但文字是乱的（2026-10-13 实测）。
        const want = text.replace(/\s/g, '');
        const got = (await boxText(el)).replace(/\s/g, '');
        if (!okFill || got !== want) {
          await el.fill(text, { timeout: 5000 }).catch(() => {});
        }
        // 给"填过的这只框"打标记：后续判断"是否已发送"只认它，避免页面上别的空输入框造成误判
        await el.evaluate(e => e.setAttribute('data-greet-box', '1')).catch(() => {});
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// ---------- 拟人滚动（2026-10-12 已定「宁愿慢不要快」+ 平滑不跳格）----------
// 真人滚轮 = 小步长连续拨轮 + 速度包络（起手慢/中间快拨/收尾慢）+ 偶尔回弹。
// page.evaluate(scrollBy) 页面滚了但输入设备层零信号；mouse.wheel 是可信事件。
const scrollPause = (ms) => new Promise(r => setTimeout(r, ms));
// 近似高斯（3 次均匀随机求和），抖动/微动用
const gauss = (sd) => (Math.random() + Math.random() + Math.random() - 1.5) * sd * 1.6;

/**
 * 在当前页面上做一段拟人滚轮滚动（v3：借鉴 shy-mouse-playwright 的算法要点，MIT）。
 * @param {Page} page
 * @param {number} maxPx 本次滚动总距离（px）
 * @param {object} opt { backRatio = 0.3 回弹概率, triggerRatio = 0.75 触发概率 }
 *   —— 触发概率（2026-10-12 已定：6~8 成，取 0.75）：不是每次都滚，
 *   真人也有不滚的时候；跳过时什么都不做，行为不可预测性本身就是拟人的一部分
 *
 * v3 算法要点（来自 shy-mouse-playwright 调研）：
 *   步数 = 对数难度（Fitts 式）+ 疲劳系数（动作多了变慢变钝）
 *   步长 = 混合缓动（60% easeInOutCubic + 40% 对数减速）→ 起手步大、自然渐停
 *   间隔 = 鼠标报告率模拟（60~144Hz，时间相关而非固定/独立随机）
 *   滚动中 18% 概率鼠标微动（高斯小幅挪动，真人手不会完全静止）
 *   滚动前 60% 概率先把鼠标平滑移到视口内随机悬停点
 */
async function humanWheelScroll(page, maxPx, opt = {}) {
  const backRatio = opt.backRatio ?? 0.3;
  const triggerRatio = opt.triggerRatio ?? 0.75;
  if (Math.random() > triggerRatio) return;   // 这轮不滚

  try {
    const vp = page.viewportSize() || { width: 1280, height: 800 };
    humanWheelScroll._pos = humanWheelScroll._pos || { x: vp.width * 0.5, y: vp.height * 0.5 };

    // 滚动前：60% 概率先把鼠标平滑移到视口内的悬停点（shy-mouse 的 preScrollMouseMovement）
    if (Math.random() < 0.6) {
      const tx = vp.width * (0.25 + Math.random() * 0.5);
      const ty = vp.height * (0.15 + Math.random() * 0.7);
      await page.mouse.move(tx, ty, { steps: 8 + Math.floor(Math.random() * 10) }).catch(() => {});
      humanWheelScroll._pos = { x: tx, y: ty };
      await scrollPause(100 + Math.random() * 300);
    }

    // 步数：对数难度（距离越远拨越多，Fitts 式）+ 疲劳系数（动作多了变慢变钝）
    const scrollID = Math.log2(maxPx / 100 + 1);
    let numSteps = Math.max(4, Math.round(8 * scrollID));
    humanWheelScroll._acts = (humanWheelScroll._acts || 0) + 1;
    if (humanWheelScroll._acts > 20) {
      numSteps = Math.round(numSteps * Math.min(1 + (humanWheelScroll._acts - 20) * 0.02, 1.4));
    }
    numSteps = Math.min(numSteps, 28);

    // 鼠标报告率（60~144Hz）：时间相关（相邻间隔关联），不是固定也不是独立随机
    let phase = Math.random();
    const pollDelay = () => {
      phase = Math.random() * 0.7 + phase * 0.3;
      if (phase < 0.65) return Math.max(6, 10 + gauss(1.5));   // ~100Hz 典型
      if (phase < 0.82) return 7 + Math.random() * 2;          // 120~144Hz 快拨
      return 12 + Math.random() * 5;                            // 60~85Hz 慢段
    };

    // 每一步：混合缓动（60% easeInOutCubic + 40% 对数减速）→ 步长渐小、自然渐停
    let done = 0;
    for (let i = 1; i <= numSteps; i++) {
      const remaining = maxPx - done;
      if (remaining < 8) break;
      const p = i / numSteps;
      const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const logDec = 1 - Math.log10(1 + 9 * p);
      const blended = eased * 0.6 + logDec * 0.4;
      let step = remaining * (1 - blended) * 0.3 + 4;
      step += gauss(Math.min(6, remaining * 0.12));             // 高斯抖动
      step = Math.max(8, Math.min(180, step));
      await page.mouse.wheel(0, step).catch(() => {});
      done += step;
      // 滚动中 18% 概率鼠标微动（真人手不会完全静止）
      if (Math.random() < 0.18) {
        const mx = Math.max(0, Math.min(vp.width - 1, humanWheelScroll._pos.x + gauss(2.5)));
        const my = Math.max(0, Math.min(vp.height - 1, humanWheelScroll._pos.y + gauss(2.5)));
        await page.mouse.move(mx, my).catch(() => {});
        humanWheelScroll._pos = { x: mx, y: my };
      }
      await scrollPause(pollDelay() * (1 + (humanWheelScroll._acts > 20 ? (humanWheelScroll._acts - 20) * 0.01 : 0)));
    }

    // 偶尔回弹：滚过头往回一点（真人很常见）
    if (Math.random() < backRatio) {
      await scrollPause(150 + Math.floor(Math.random() * 250));
      await page.mouse.wheel(0, -(60 + Math.floor(Math.random() * 90))).catch(() => {});
    }
  } catch (_) {}
}

// ---------- 拟人点击（2026-10-13）----------
// 算法参考 ghost-cursor-playwright（MIT，周下载 17.8k）的要点，提炼自研、不引依赖：
//   · 它会把鼠标位置注入页面全局（window.mousePos / window.mouseTarget）—— 增加可检测面；
//   · 自带自动滚动/元素校验/idle 随机移动等一堆我们不需要的功能；
//   · 本项目已有先例：humanWheelScroll 同样是提炼 shy-mouse-playwright 的算法自研。
// 提炼的三个要点：
//   1) 路径 = 三次贝塞尔：两个控制点随机落在连线的【同一侧】（单侧才不会出 S 形），
//      偏移幅度随距离 clamp（近距离微弯、远距离弯到 ~120px）
//   2) 点数 ≈ Fitts 式（距离越远点越多，10~24 个）—— 等价于真人鼠标的采样密度
//   3) 落点 = 元素内随机点 + padding（不点边缘；真人不会每次都戳正中心）
// 外加原 locator.click() 完全没有的两个维度 —— 这是最明显的机器特征
// （原生 click = 鼠标瞬移 + 0ms 抬起）：
//   · 到达后瞄准停顿 60~200ms
//   · 按压时长 50~120ms（mousedown → mouseup）
// 安全兜底：按下前用 elementFromPoint 校验鼠标下的元素确实是目标（防止被固定栏/
// 弹窗遮挡时点到别的东西上），不通过就退回原生 click。

// 取元素内的随机落点（paddingRatio 越大越靠中心）
function randomPointInBox(box, paddingRatio = 0.25) {
  const padX = Math.min(box.width * paddingRatio, Math.max(0, box.width / 2 - 2));
  const padY = Math.min(box.height * paddingRatio, Math.max(0, box.height / 2 - 2));
  return {
    x: box.x + padX + Math.random() * Math.max(1, box.width - 2 * padX),
    y: box.y + padY + Math.random() * Math.max(1, box.height - 2 * padY),
  };
}

// 三次贝塞尔采样（返回不含起点的路径点，带轻微抖动）
function bezierPath(from, to, n) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const spread = Math.min(Math.max(dist, 2), 200) * 0.6;   // 控制点偏移幅度
  const side = Math.random() < 0.5 ? 1 : -1;                // 单侧
  const nx = dy / dist, ny = -dx / dist;                    // 单位法线
  const off = () => (0.35 + Math.random() * 0.65) * side * spread;
  const c1 = { x: from.x + dx * 0.33 + nx * off(), y: from.y + dy * 0.33 + ny * off() };
  const c2 = { x: from.x + dx * 0.66 + nx * off(), y: from.y + dy * 0.66 + ny * off() };
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, mt = 1 - t;
    const x = mt * mt * mt * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * to.x;
    const y = mt * mt * mt * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * to.y;
    pts.push({ x: Math.max(1, Math.round(x + gauss(1.2))), y: Math.max(1, Math.round(y + gauss(1.2))) });
  }
  return pts;
}

// 拟人鼠标移动（复用 humanWheelScroll._pos 作为全程共享的鼠标位置）
async function humanMove(page, to) {
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const from = humanWheelScroll._pos || {
    x: Math.round(vp.width * (0.3 + Math.random() * 0.4)),
    y: Math.round(vp.height * (0.3 + Math.random() * 0.4)),
  };
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < 4) {   // 已经在落点上：只做一次微小抖动（连续点同一区域时）
    await page.mouse.move(to.x, to.y).catch(() => {});
    humanWheelScroll._pos = to;
    return;
  }
  const n = Math.round(Math.min(24, Math.max(10, 8 + Math.log2(dist / 100 + 1) * 7)));
  for (const p of bezierPath(from, to, n)) {
    await page.mouse.move(p.x, p.y).catch(() => {});
    await scrollPause(3 + Math.random() * 9);   // 采样间隔 ~80-160Hz 量级
  }
  humanWheelScroll._pos = to;
}

// 拟人点击：走轨迹 → 停一下 → 按下（保持一点时长）→ 抬起
async function humanClick(page, locator, opts = {}) {
  const timeout = opts.timeout || 8000;
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    const box = await locator.boundingBox({ timeout: 2500 }).catch(() => null);
    if (!box || box.width < 2 || box.height < 2) throw new Error('no-box');

    const vp = page.viewportSize() || { width: 1280, height: 800 };
    let to = randomPointInBox(box, opts.paddingRatio ?? 0.25);
    // 落点必须在视口内（元素部分出屏时收回到中心）
    if (to.x < 2 || to.y < 2 || to.x > vp.width - 2 || to.y > vp.height - 2) {
      to = {
        x: Math.min(Math.max(box.x + box.width / 2, 4), vp.width - 4),
        y: Math.min(Math.max(box.y + box.height / 2, 4), vp.height - 4),
      };
    }

    await humanMove(page, to);
    // 落下前校验：鼠标下最顶层的元素必须是目标（或目标的祖先/后代），防遮挡点错
    const onTarget = await locator.evaluate((el, pt) => {
      const top = document.elementFromPoint(pt.x, pt.y);
      return !!top && (top === el || el.contains(top) || top.contains(el));
    }, to).catch(() => false);
    if (!onTarget) throw new Error('covered');

    await scrollPause(60 + Math.random() * 140);   // 瞄准停顿
    await page.mouse.down();
    await scrollPause(50 + Math.random() * 70);    // 按压时长
    await page.mouse.up();
  } catch (_) {
    // 退回原生 click（拿不到 box / 被遮挡 / 页面异常）。原生点击后鼠标位置不可知，
    // 清掉共享位置，下次 humanMove 会重新选一个起点。
    await locator.click({ timeout }).catch(() => {});
    humanWheelScroll._pos = null;
  }
}

// 外部自己动了鼠标（如 search.js 的 mouse.move(0,0) 强制移开 hover）时，
// 同步一下共享位置，避免下次 humanMove 的轨迹起点错得太离谱
function noteMousePos(x, y) {
  humanWheelScroll._pos = { x, y };
}

module.exports = { clickByText, clickGreetButton, clickSendButton, fillGreeting, humanWheelScroll, humanClick, noteMousePos, confirmChangeJobDialog };
