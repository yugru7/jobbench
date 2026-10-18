/**
 * 回归：真实 BOSS 页面上的弹窗检测器
 * 用法：node tests/verify-change-job-dialog-live.js（需登录态 profile，会开浏览器窗口）
 *
 * 真实 BOSS 页面验证：弹窗检测器不误报 + 检测/点击链路在真实页面工作
 * 1) 打开真实岗位详情页 → 检查页面本来有没有「沟通新职位」文案（误报风险）
 * 2) 注入复刻截图结构的模拟弹窗 → confirmChangeJobDialog 检测+拟人点击 → 弹窗消失
 * 3) 再检测一次 → false（无残留误判）
 * 只读页面 + 注入假弹窗，不点任何真实按钮，零副作用。
 */
const path = require('path');
let chromium;
try { ({ chromium } = require('patchright')); } catch (_) { ({ chromium } = require('playwright-core')); }
const { CHROME } = require('../../lib/utils');
const { confirmChangeJobDialog } = require('../../lib/page-helpers');
const CFG = require('../../data/config.json');

const NO_THROTTLE_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
];

(async () => {
  const ctx = await chromium.launchPersistentContext(CFG.profileDir, {
    executablePath: CHROME,
    headless: false,
    viewport: null,
    args: NO_THROTTLE_ARGS,
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = await ctx.newPage();

  // 打开真实岗位详情页（统计数据分析实习生，未发送、有 JD）
  await page.goto('https://www.zhipin.com/job_detail/efb4e512447ac3240nZ_2NS6F1BV.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 3500));
  console.log('页面已打开:', page.url().slice(0, 70));

  // [1] 误报检查：真实页面本来有没有「沟通新职位」可见文案
  const before = await page.evaluate(() => {
    const hits = [];
    for (const el of document.querySelectorAll('button, div, a, span')) {
      if ((el.textContent || '').trim() !== '沟通新职位') continue;
      const r = el.getBoundingClientRect();
      if (r.width > 5 && r.height > 5) hits.push({ tag: el.tagName, cls: String(el.className).slice(0, 60) });
    }
    return hits;
  });
  console.log('[1] 页面原有「沟通新职位」可见元素:', before.length, before.length ? JSON.stringify(before) : '（无误报风险 ✅）');

  // [2] 注入模拟弹窗（复刻截图结构）
  await page.evaluate(() => {
    const wrap = document.createElement('div');
    wrap.id = '__test_dlg';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:99999';
    wrap.innerHTML = '<div style="background:#fff;border-radius:8px;width:400px;padding:24px;text-align:center;font-family:sans-serif">'
      + '<div style="font-size:16px;font-weight:600;margin-bottom:12px">温馨提示</div>'
      + '<div style="font-size:14px;color:#333;line-height:1.6">您与该Boss已沟通过，是否就新职位Agentic AI 算法实习生继续沟通？<br>'
      + '<span style="color:#999;font-size:12px">注：更换沟通职位将通知Boss</span></div>'
      + '<div style="margin-top:20px;display:flex;gap:12px;justify-content:center">'
      + '<button style="padding:8px 24px;border:1px solid #ddd;background:#fff;border-radius:4px;cursor:pointer">取消</button>'
      + '<button id="__t_go" style="padding:8px 24px;border:1px solid #00a6a7;background:#00a6a7;color:#fff;border-radius:4px;cursor:pointer">沟通新职位</button>'
      + '</div></div>';
    document.body.appendChild(wrap);
    document.getElementById('__t_go').addEventListener('click', () => {
      document.body.setAttribute('data-test-dlg-clicked', '1');
      wrap.remove();
    });
  });
  console.log('[2] 模拟弹窗已注入');

  // [3] 检测 + 拟人点击
  const t0 = Date.now();
  const r1 = await confirmChangeJobDialog(page);
  const ms = Date.now() - t0;
  const after = await page.evaluate(() => ({
    clicked: document.body.getAttribute('data-test-dlg-clicked'),
    gone: !document.getElementById('__test_dlg'),
  }));
  console.log('[3] 检测+点击 →', r1, '| 耗时', ms, 'ms | 点击生效:', after.clicked === '1', '| 弹窗消失:', after.gone);

  // [4] 弹窗消失后再检测 → false
  const r2 = await confirmChangeJobDialog(page);
  console.log('[4] 无弹窗再检测 →', r2, r2 === false ? '✅ 无残留误判' : '❌');

  const pass = before.length === 0 && r1 === true && after.clicked === '1' && after.gone && r2 === false;
  console.log('');
  console.log(pass ? 'PASS：真实页面无误报 + 检测/点击链路工作 ✅' : 'FAIL：见上');

  await ctx.close().catch(() => {});
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('脚本异常:', e.message.slice(0, 200)); process.exit(2); });
