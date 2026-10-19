/**
 * 搜索 URL 构造 + 「意向岗位页签」操作 + 源头筛选拼参
 * ----------------------------------------------------------------------------
 * 用法：const { searchUrl, readExpectTabs, clickExpectTab } = require('./lib/search')(CFG, SOURCE);
 */
const { sleep } = require('./utils');
const { humanClick, noteMousePos } = require('./page-helpers');

module.exports = (CFG, source) => {
  // 源头筛选：把面板「岗位初筛」选的筛选条件拼进列表页 URL，让 BOSS 只返回符合的岗位
  // （不合条件的根本不进候选池，不用爬回来再本地筛）。键名本身就是 URL 参数名。
  //   工作区域 multiBusinessDistrict 只有「搜索」来源有（推荐/意向不吃）
  // 注：不含 salary —— BOSS 的薪资档位是月薪口径，对实习（日薪）无意义，已整组去掉
  const FILTER_KEYS = {
    search: ['multiBusinessDistrict', 'jobType', 'degree', 'scale', 'stage'],
    recommend: ['jobType', 'degree', 'scale', 'stage'],
    expect: ['jobType', 'degree', 'scale', 'stage'],
  };
  function filterQuery(src) {
    const sf = (CFG.sourceFilters && CFG.sourceFilters[src]) || {};
    let q = '';
    for (const k of (FILTER_KEYS[src] || [])) {
      // 只允许数字/逗号（区县码、档位码，含多选）—— 杜绝注入其它参数
      const v = String(sf[k] == null ? '' : sf[k]).replace(/[^0-9,]/g, '');
      if (!v || v === '0') continue;   // 空 / "0"（不限）→ 不加这个参数
      q += `&${k}=${v}`;
    }
    return q;
  }

  // 收藏来源：「个人中心 → 感兴趣 → 职位收藏」是 BOSS 的固定页面（不是可搜索的列表页），
  // 不吃城市 / 经验 / 筛选参数 —— 用户自己衡量后加进收藏的岗位，这里一个条件都不套
  // （先试试，不加任何限制）。URL 就是用户在 BOSS 里看到的那一页。
  const FAV_URL = 'https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=1&tag=4&ka=header-username';

  // 收藏页翻页：页面不显示分页控件、也不懒加载，只能改 URL 的 page 参数（page=2 确实会请求第 2 页）。
  // pageNo 只取正整数，杜绝拼出奇怪的 URL。
  function favUrl(pageNo) {
    const p = Math.max(1, parseInt(pageNo, 10) || 1);
    return FAV_URL.replace(/page=\d+/, `page=${p}`);
  }

  function searchUrl(kw) {
    // 收藏来源：固定 URL，直接返回（不拼 experience / 筛选，见上方说明）
    if (source === 'fav') return FAV_URL;
    // experience 参数直接让 BOSS 只返回"在校/应届"岗位，从源头卡掉社招岗
    const exp = CFG.experience ? `&experience=${CFG.experience}` : '';
    const flt = filterQuery(source);
    // 推荐模式：同一个列表页不带 query —— BOSS 直接展示按意向岗位推荐的流（界面顶栏「推荐」页签）
    if (source === 'recommend') return `https://www.zhipin.com/web/geek/job?city=${CFG.cityCode}${exp}${flt}`;
    // 意向页签模式：落地页用 /jobs（推荐流落地地址），之后靠点击页签切换列表
    if (source === 'expect') return `https://www.zhipin.com/web/geek/jobs?city=${CFG.cityCode}${exp}${flt}`;
    return `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(kw)}&city=${CFG.cityCode}${exp}${flt}`;
  }

  // 【expect 模式】读职位页上的意向岗位页签（用户在 BOSS 勾选的求职方向）
  // 「更多」下拉是懒渲染的：必须先 hover 展开才挂 DOM —— 读不到就展开一次再读。
  // 【踩过的坑】固定 sleep(800) 就读曾漏掉整个「更多」里的方向（6 个只
  // 读到 3 个 direct）—— 懒渲染慢时 DOM 还没挂上。改成 hover 后轮询等 DOM，
  // 带 click 兜底（hover 在某些窗口状态不触发）和移开再 hover 重试。
  async function readExpectTabs(page) {
    const pick = sels => page.evaluate(sel => {
      return [...document.querySelectorAll(sel)]
        .map(e => (e.innerText || '').trim().split('\n')[0].trim()).filter(Boolean);
    }, sels).catch(() => []);
    const direct = await pick('.expect-list .expect-item .text-content');
    const moreSel = '.dropdown-expect-list .expect-item .text-content';
    const filter = page.locator('.expect-select-filter').first();
    // 轮询等 DOM 出现（ms 间隔 × 次数）
    const pollMore = async (rounds = 25, gap = 200) => {
      for (let i = 0; i < rounds; i++) {
        const got = await pick(moreSel);
        if (got.length) return got;
        await sleep(gap);
      }
      return [];
    };
    let more = [];
    try {
      // 第 1 轮：hover 展开 + 轮询最多 5 秒
      await filter.hover({ timeout: 4000 });
      more = await pollMore(25, 200);
      // 第 2 轮：hover 不触发时点一下展开（某些窗口状态 hover 不派发事件）
      if (!more.length) {
        await humanClick(page, filter, { timeout: 3000 });
        more = await pollMore(15, 200);
      }
      // 第 3 轮：鼠标移开再移入，强制重派 hover
      if (!more.length) {
        await page.mouse.move(0, 0).catch(() => {});
        noteMousePos(0, 0);   // 同步共享位置（humanClick 的轨迹起点）
        await sleep(300);
        await filter.hover({ timeout: 4000 }).catch(() => {});
        more = await pollMore(15, 200);
      }
    } catch (_) {}
    return { direct, more };
  }

  // 【expect 模式】点一个意向页签（直接显示的或「更多」下拉里的），等列表真的切换
  // 页签是 javascript:; 前端路由，点击后 URL 不变、列表 AJAX 刷新 —— 靠第一张卡的文字变化判定切换完成
  // 返回空串 = 成功；否则返回错误描述（带出去 log，不吞异常）
  async function clickExpectTab(page, tabText) {
    const firstCardText = () => page.evaluate(() => {
      const el = document.querySelector('.job-name, .job-title');
      return el ? (el.innerText || '').trim().split('\n')[0] : '';
    }).catch(() => '');
    try {
      await sleep(2000);   // 等 goto 后的加载遮罩退场，点太快会被判 not actionable
      const before = await firstCardText();
      const direct = page.locator('.expect-list .expect-item', { hasText: tabText }).first();
      if (await direct.count() > 0 && await direct.isVisible().catch(() => false)) {
        await humanClick(page, direct, { timeout: 10000 });
      } else {
        // 在「更多」下拉里：hover 展开再点
        await page.locator('.expect-select-filter').first().hover();
        await page.waitForTimeout(800);
        await humanClick(page, page.locator('.dropdown-expect-list .expect-item', { hasText: tabText }).first(), { timeout: 10000 });
      }
      // 等第一张卡变化（before 为空时，任意卡片出现即算切换成功），最多 12 秒
      for (let i = 0; i < 24; i++) {
        await sleep(500);
        const now = await firstCardText();
        if (now && now !== before) return '';
      }
      return '点击后列表 12 秒内没切换';
    } catch (e) {
      return 'click: ' + (e && e.message ? e.message.slice(0, 80) : String(e));
    }
  }

  return { searchUrl, favUrl, readExpectTabs, clickExpectTab };
};
