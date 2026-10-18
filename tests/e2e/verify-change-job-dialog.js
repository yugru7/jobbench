/**
 * 回归：换职位沟通确认弹窗的检测与点击
 * 用法：node tests/verify-change-job-dialog.js（无需服务/登录态，纯本地页面）
 *
 * 本地模拟验证：换职位沟通确认弹窗的检测与点击
 * 复刻截图弹窗结构（「温馨提示：您与该Boss已沟通过，是否就新职位继续沟通？」），
 * 验证 confirmChangeJobDialog 的 4 个用例：
 *   1) 有弹窗（button 直接文本）→ 检测到并点掉（拟人点击）
 *   2) 嵌套结构 <button><span>沟通新职位</span></button> → 点到（冒泡）
 *   3) 带后缀「沟通新职位（测试）」→ 不误报（文案锚定 ^$）
 *   4) 弹窗隐藏（display:none）→ 不点
 */
const path = require('path');
let chromium;
try { ({ chromium } = require('patchright')); } catch (_) { ({ chromium } = require('playwright-core')); }
const { CHROME } = require('../../lib/utils');
const { confirmChangeJobDialog } = require('../../lib/page-helpers');

const HTML = (opts = {}) => `<!DOCTYPE html>
<html><head><style>
  body { font-family: sans-serif; margin: 0; padding: 40px; background: #f5f5f5; }
  .dialog-wrap { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: ${opts.hidden ? 'none' : 'flex'}; align-items: center; justify-content: center; z-index: 999; }
  .dialog { background: #fff; border-radius: 8px; width: 400px; padding: 24px; text-align: center; }
  .dialog .title { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  .dialog .content { font-size: 14px; color: #333; line-height: 1.6; }
  .dialog .note { color: #999; font-size: 12px; }
  .dialog .btns { margin-top: 20px; display: flex; gap: 12px; justify-content: center; }
  .dialog button { padding: 8px 24px; border-radius: 4px; border: 1px solid #ddd; background: #fff; cursor: pointer; font-size: 14px; }
  .dialog button.primary { background: #00a6a7; color: #fff; border-color: #00a6a7; }
</style></head>
<body>
  <div class="dialog-wrap" id="dlg">
    <div class="dialog">
      <div class="title">温馨提示</div>
      <div class="content">您与该Boss已沟通过，是否就新职位Agentic AI 算法实习生继续沟通？<br><span class="note">注：更换沟通职位将通知Boss</span></div>
      <div class="btns">
        <button id="btnCancel">取消</button>
        ${opts.nested
          ? `<button id="btnGo" class="primary"><span>沟通新职位</span></button>`
          : opts.suffix
            ? `<button id="btnGo" class="primary">沟通新职位（测试）</button>`
            : `<button id="btnGo" class="primary">沟通新职位</button>`}
      </div>
    </div>
  </div>
  <script>
    document.getElementById('btnGo').addEventListener('click', () => {
      // Patchright 下 evaluate 读不到页面变量 —— 用 DOM 属性中转计数
      document.body.setAttribute('data-click-go', String((+document.body.getAttribute('data-click-go') || 0) + 1));
      document.getElementById('dlg').style.display = 'none';
    });
  </script>
</body></html>`;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let pass = 0, fail = 0;
  const judge = (name, ok, extra) => {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
    ok ? pass++ : fail++;
  };

  // ---- 用例1：有弹窗（直接文本）----
  await page.setContent(HTML());
  const r1 = await confirmChangeJobDialog(page);
  const c1 = await page.evaluate(() => ({
    clicks: +(document.body.getAttribute('data-click-go') || 0),
    hidden: document.getElementById('dlg').style.display === 'none',
  }));
  judge('1) 有弹窗 → 返回 true 且点击生效', r1 === true && c1.clicks === 1 && c1.hidden, `r=${r1} clicks=${c1.clicks} hidden=${c1.hidden}`);

  // ---- 用例2：嵌套结构 ---- 
  await page.setContent(HTML({ nested: true }));
  const r2 = await confirmChangeJobDialog(page);
  const c2 = await page.evaluate(() => ({
    clicks: +(document.body.getAttribute('data-click-go') || 0),
    hidden: document.getElementById('dlg').style.display === 'none',
  }));
  judge('2) 嵌套 <button><span> → 冒泡点到', r2 === true && c2.clicks === 1 && c2.hidden, `r=${r2} clicks=${c2.clicks}`);

  // ---- 用例3：带后缀 → 不误报 ----
  await page.setContent(HTML({ suffix: true }));
  const r3 = await confirmChangeJobDialog(page);
  const c3 = await page.evaluate(() => +(document.body.getAttribute('data-click-go') || 0));
  judge('3) 带后缀「沟通新职位（测试）」→ 不点', r3 === false && c3 === 0, `r=${r3} clicks=${c3}`);

  // ---- 用例4：隐藏弹窗 → 不点 ----
  await page.setContent(HTML({ hidden: true }));
  const r4 = await confirmChangeJobDialog(page);
  const c4 = await page.evaluate(() => +(document.body.getAttribute('data-click-go') || 0));
  judge('4) 隐藏弹窗 → 不点', r4 === false && c4 === 0, `r=${r4} clicks=${c4}`);

  // ---- 用例5：延迟出现的弹窗（模拟点击沟通按钮后弹窗稍后出现）----
  await page.setContent(`<!DOCTYPE html><html><body><div id="host"></div>
  <script>
    setTimeout(() => {
      document.getElementById('host').innerHTML = '<div class="dialog"><button id="go">沟通新职位</button></div>';
      document.getElementById('go').addEventListener('click', () => {
        document.body.setAttribute('data-click-go', String((+document.body.getAttribute('data-click-go') || 0) + 1));
        document.getElementById('go').remove();
      });
    }, 1200);
  </script></body></html>`);
  // 模拟 greet.js waitForInput 的轮询：每 350ms 检测一次，弹窗出现后点掉
  let got = false;
  for (let i = 0; i < 12; i++) {
    const hasDlg = await page.evaluate(() => {
      for (const el of document.querySelectorAll('button, div, a, span')) {
        if ((el.textContent || '').trim() !== '沟通新职位') continue;
        const r = el.getBoundingClientRect();
        if (r.width > 5 && r.height > 5) return true;
      }
      return false;
    });
    if (hasDlg && await confirmChangeJobDialog(page)) { got = true; break; }
    await new Promise((r) => setTimeout(r, 350));
  }
  const c5 = await page.evaluate(() => +(document.body.getAttribute('data-click-go') || 0));
  judge('5) 延迟 1.2s 出现的弹窗 → 轮询检测并点掉', got && c5 === 1, `got=${got} clicks=${c5}`);

  await browser.close();
  console.log('');
  console.log(`结果：${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e.message); process.exit(2); });
