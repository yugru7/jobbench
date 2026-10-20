/**
 * 回归：发送链路上的两种弹窗
 * 用法：node tests/e2e/verify-change-job-dialog.js（无需服务/登录态，纯本地页面）
 *
 * 覆盖两个改动后的行为：
 *   A. 同一 HR 已在沟通（「是否就新职位继续沟通？」）
 *      → cancelChangeJobDialog 检测到并点「取消」，**绝不点「沟通新职位」**
 *   B. 平台沟通额度提示（「已与 N 位BOSS沟通，还剩 M 次沟通机会」+「好」）
 *      → readQuotaDialog 读出数字并关掉弹窗；没有该弹窗时返回 null
 *
 * 【测试纪律】每个用例都开新 page：同一个 page 上反复 setContent 时，
 * locator('div').filter(...) 这类复合定位器从第二次起就解析不到新文档的元素
 * （第一例永远正常），会得出"功能坏了"的假结论。
 */
const path = require('path');
let chromium;
try { ({ chromium } = require('patchright')); } catch (_) { ({ chromium } = require('playwright-core')); }
const { CHROME } = require('../../lib/utils');
const { cancelChangeJobDialog, readQuotaDialog } = require('../../lib/page-helpers');

// opts: hidden | nested | suffix
const DUP_HTML = (opts = {}) => `<!DOCTYPE html>
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
      <div class="content">您与该Boss已沟通过，是否就新职位「Agentic AI 算法实习生」继续沟通？<br><span class="note">注：更换沟通职位将通知Boss</span></div>
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
    const bump = (k) => document.body.setAttribute(k, String((+document.body.getAttribute(k) || 0) + 1));
    document.getElementById('btnGo').addEventListener('click', () => { bump('data-click-go'); document.getElementById('dlg').style.display = 'none'; });
    document.getElementById('btnCancel').addEventListener('click', () => { bump('data-click-cancel'); document.getElementById('dlg').style.display = 'none'; });
  </script>
</body></html>`;

// opts: hidden | noNumber | remaining（数字）| used（数字）
const QUOTA_HTML = (opts = {}) => `<!DOCTYPE html>
<html><head><style>
  body { font-family: sans-serif; margin: 0; padding: 40px; background: #f5f5f5; }
  .dialog-wrap { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: ${opts.hidden ? 'none' : 'flex'}; align-items: center; justify-content: center; z-index: 999; }
  .dialog { background: #fff; border-radius: 8px; width: 420px; padding: 24px; text-align: center; }
  .dialog .title { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  .dialog .content { font-size: 14px; color: #333; line-height: 1.6; }
  .dialog button { margin-top: 20px; padding: 8px 32px; border-radius: 4px; border: 1px solid #00a6a7; background: #00a6a7; color: #fff; cursor: pointer; font-size: 14px; }
</style></head>
<body>
  <div class="dialog-wrap" id="qdlg">
    <div class="dialog">
      <div class="title">温馨提示</div>
      <div class="content">${opts.noNumber
        ? '您今天的沟通次数已达上限，请明天再来'
        : `您今天已与${opts.used == null ? 120 : opts.used}位BOSS沟通，还剩${opts.remaining == null ? 30 : opts.remaining}次沟通机会哦`}</div>
      <button id="btnOk">好</button>
    </div>
  </div>
  <script>
    document.getElementById('btnOk').addEventListener('click', () => {
      document.body.setAttribute('data-click-ok', String((+document.body.getAttribute('data-click-ok') || 0) + 1));
      document.getElementById('qdlg').style.display = 'none';
    });
  </script>
</body></html>`;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  let pass = 0, fail = 0;
  const judge = (name, ok, extra) => {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
    ok ? pass++ : fail++;
  };
  // 每个用例独立开新 page（见文件头「测试纪律」）
  const withPage = async (html, fn) => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await p.setContent(html);
      return await fn(p);
    } finally {
      await p.close().catch(() => {});
    }
  };
  const dupState = (p) => p.evaluate(() => ({
    go: +(document.body.getAttribute('data-click-go') || 0),
    cancel: +(document.body.getAttribute('data-click-cancel') || 0),
    hidden: document.getElementById('dlg').style.display === 'none',
  }));

  // ============ A. 同一 HR 已在沟通 → 点「取消」，不重复发 ============
  {
    const r = await withPage(DUP_HTML(), async (p) => ({ r: await cancelChangeJobDialog(p), s: await dupState(p) }));
    judge('A1) 有弹窗 → 检测到、点「取消」、绝不点「沟通新职位」',
      r.r === true && r.s.cancel === 1 && r.s.go === 0 && r.s.hidden, JSON.stringify(r.s));
  }
  {
    const r = await withPage(DUP_HTML({ nested: true }), async (p) => ({ r: await cancelChangeJobDialog(p), s: await dupState(p) }));
    judge('A2) 嵌套 <button><span> → 仍能取消', r.r === true && r.s.cancel === 1 && r.s.go === 0, JSON.stringify(r.s));
  }
  {
    const r = await withPage(DUP_HTML({ suffix: true }), async (p) => ({ r: await cancelChangeJobDialog(p), s: await dupState(p) }));
    judge('A3) 带后缀「沟通新职位（测试）」→ 不误判', r.r === false && r.s.cancel === 0 && r.s.go === 0, JSON.stringify(r.s));
  }
  {
    const r = await withPage(DUP_HTML({ hidden: true }), async (p) => ({ r: await cancelChangeJobDialog(p), s: await dupState(p) }));
    judge('A4) 隐藏弹窗 → 不动作', r.r === false && r.s.cancel === 0, JSON.stringify(r.s));
  }
  {
    // 延迟 1.2s 出现（模拟点「立即沟通」后弹窗稍后渲染）→ 轮询能抓到
    const r = await withPage(`<!DOCTYPE html><html><body><div id="host"></div>
      <script>
        setTimeout(() => {
          document.getElementById('host').innerHTML = '<div><div>温馨提示</div><div>您与该Boss已沟通过，是否就新职位「X」继续沟通？</div>'
            + '<button id="ok2">取消</button><button id="go2">沟通新职位</button></div>';
          document.getElementById('ok2').addEventListener('click', () => document.body.setAttribute('data-c', '1'));
          document.getElementById('go2').addEventListener('click', () => document.body.setAttribute('data-g', '1'));
        }, 1200);
      </script></body></html>`, async (p) => {
      let seen = false;
      for (let i = 0; i < 12; i++) {
        if (await cancelChangeJobDialog(p)) { seen = true; break; }
        await new Promise((res) => setTimeout(res, 350));
      }
      const s = await p.evaluate(() => ({ c: document.body.getAttribute('data-c'), g: document.body.getAttribute('data-g') }));
      return { seen, s };
    });
    judge('A5) 延迟 1.2s 出现 → 轮询取消（且没点「沟通新职位」）', r.seen && r.s.c === '1' && !r.s.g, JSON.stringify(r.s));
  }

  // ============ B. 平台额度弹窗 ============
  {
    const r = await withPage(QUOTA_HTML({ used: 120, remaining: 30 }), async (p) => ({
      q: await readQuotaDialog(p),
      o: await p.evaluate(() => ({
        ok: +(document.body.getAttribute('data-click-ok') || 0),
        hidden: document.getElementById('qdlg').style.display === 'none',
      })),
    }));
    judge('B1) 截图文案（120 / 还剩 30）→ 读出数字并点「好」',
      r.q && r.q.used === 120 && r.q.remaining === 30 && r.o.ok === 1 && r.o.hidden, JSON.stringify(r));
  }
  {
    const q = await withPage(QUOTA_HTML({ used: 150, remaining: 0 }), (p) => readQuotaDialog(p));
    judge('B2) 还剩 0 → 正常读出（调用方据此停发）', q && q.remaining === 0, JSON.stringify(q));
  }
  {
    const q = await withPage(QUOTA_HTML({ noNumber: true }), (p) => readQuotaDialog(p));
    judge('B3) 无数字文案 → 返回 null（不瞎猜）', q === null, JSON.stringify(q));
  }
  {
    const q = await withPage(QUOTA_HTML({ hidden: true }), (p) => readQuotaDialog(p));
    judge('B4) 隐藏 → null', q === null, JSON.stringify(q));
  }
  {
    // 普通详情页文案不应误判
    const q = await withPage(`<!DOCTYPE html><html><body>
      <div>立即沟通</div><div>在线职位及时沟通</div><div>与在线Boss直接聊</div>
      <div>沟通新职位</div><textarea placeholder="请输入内容"></textarea></body></html>`, (p) => readQuotaDialog(p));
    judge('B5) 普通页面文案 → 不误判', q === null, JSON.stringify(q));
  }

  await browser.close();
  console.log('');
  console.log(`结果：${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e.message); process.exit(2); });
