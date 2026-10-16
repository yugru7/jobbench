/**
 * 验证「启动异常红字降级」（2026-10-13 已定）：
 * 用法：先启动 server.js，再 node tests/verify-degrade-ui.js
 * 用路由拦截还原原始 bug 现场（bootstrap 的 checkedUrls 返回对象而非数组），
 * 断言：① 整页错误卡片不再出现 ② 标题后出现红色提示 ③ 页面主体（页签）照常渲染
 * 跑两组对照：正常响应 / 异常响应
 */
const path = require('path');
const DIR = path.join(__dirname, '..', '..');

let chromium;
try { ({ chromium } = require('patchright')); } catch (_) { ({ chromium } = require('playwright-core')); }
const { CHROME } = require('../../lib/utils');

const URL = 'http://127.0.0.1:7788/';

async function probe(page, label, corrupt) {
  if (corrupt) {
    await page.route('**/api/bootstrap', async (route) => {
      const resp = await route.fetch();
      const json = await resp.json();
      json.checkedUrls = { at: 'test', urls: [] };   // 还原 bug ①：非数组
      // 还原 bug ②：省份列表元素缺 cities 字段（现有防御拦不住的坏数据，
      // 会在 boot 的城市渲染段抛 TypeError → 应该走红字降级而不是整页崩）
      json.cities = { hot: [], provinces: [{ code: '110000', name: '测试省' }] };
      await route.fulfill({ json });
    });
  } else {
    await page.unroute('**/api/bootstrap');
  }
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2600);

  const st = await page.evaluate(() => {
    const errEl = document.getElementById('hdrError');
    const wrap = document.querySelector('.wrap');
    const tabs = document.querySelector('.tabs');
    return {
      fatalCard: !!(wrap && /连不上本地服务/.test(wrap.innerText)),
      errShown: !!(errEl && errEl.offsetWidth > 0 && errEl.style.display !== 'none'),
      errText: errEl ? (errEl.textContent || '').slice(0, 60) : '',
      tabsVisible: !!(tabs && tabs.offsetWidth > 0),
      tabCount: tabs ? tabs.querySelectorAll('a,button').length : 0,
      bodySnippet: (document.body.innerText || '').slice(0, 60).replace(/\s+/g, ' '),
    };
  });

  console.log(`\n【${label}】`);
  console.log('  整页错误卡片出现:', st.fatalCard, st.fatalCard ? '❌' : '✅');
  console.log('  标题后红字提示:', st.errShown ? `✅ ${JSON.stringify(st.errText)}` : '（无）');
  console.log('  页签正常渲染:', st.tabsVisible ? `✅ ${st.tabCount} 个` : '❌');
  console.log('  页首文本:', st.bodySnippet);
  return st;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME || undefined, headless: false, args: ['--no-proxy-server'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const normal = await probe(page, '对照：正常 bootstrap', false);
  const broken = await probe(page, '模拟：bootstrap 字段异常（原始 bug 现场）', true);

  // 第三组：读取红字元素状态（由上面的坏数据真实触发，不用手动调函数 ——
  // Patchright 下 evaluate 在隔离执行上下文，读不到页面全局函数）
  const manual = await page.evaluate(() => {
    const el = document.getElementById('hdrError');
    return {
      shown: !!(el && el.offsetWidth > 0 && el.style.display !== 'none'),
      text: el ? (el.textContent || '') : '',
      inHeader: !!(el && el.closest('header')),
      afterTitle: !!(el && el.previousElementSibling && el.previousElementSibling.tagName === 'H1'),
      fatalCard: /连不上本地服务/.test((document.querySelector('.wrap') || {}).innerText || ''),
    };
  });
  console.log('\n【坏数据触发的红字降级】');
  console.log('  红字显示:', manual.shown ? '✅' : '❌', '| 文案:', JSON.stringify(manual.text));
  console.log('  位于 header 内:', manual.inHeader ? '✅' : '❌', '| 紧跟标题:', manual.afterTitle ? '✅' : '❌');
  console.log('  未整页崩:', manual.fatalCard ? '❌' : '✅');

  await page.screenshot({ path: path.join(DIR, 'logs', 'ui-degrade-test.png') }).catch(() => {});

  console.log('\n===== 判定 =====');
  const ok =
    !normal.fatalCard && !normal.errShown && normal.tabsVisible &&
    !broken.fatalCard && broken.tabsVisible &&
    manual.shown && manual.inHeader && manual.afterTitle && !manual.fatalCard;
  console.log(ok ? 'PASS：异常数据不崩（内部防御生效）+ 红字组件工作 + 正常时无红字' : 'FAIL：见上表');

  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(9); });
