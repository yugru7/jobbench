/**
 * 「打开 BOSS」模式（--mode=open）
 * ----------------------------------------------------------------------------
 * 只把浏览器带起来并停在 BOSS直聘，**不跑任何采集/发送**。
 * 用途：给用户一个「带登录态的浏览器入口」—— 想自己上 BOSS 逛/聊天/投递时，
 *   从面板一键打开。用的是任务同一个 profile（config.profileDir），所以登录态
 *   就存在那份 profile 里：关掉浏览器、关掉面板都不会丢，下次任务照旧复用。
 *
 * CDP 模式下 Chrome 是 detached 起的（见 lib/browser-session.js），本进程退出它不会死
 *   —— 所以这里做完直接返回，浏览器留在屏幕上给用户自己用。
 */
const BOSS_HOME = 'https://www.zhipin.com/';

module.exports = (deps) => {
  const { rt, log } = deps;

  function currentUrl() {
    try { return (rt.page && rt.page.url()) || ''; } catch (_) { return ''; }
  }

  async function runOpenMode() {
    const page = rt.page;
    if (!page) { log('没有可用标签页，无法打开 BOSS', 'WARN'); return; }

    // 已经停在 BOSS 上就别动它（用户可能正停在某个岗位/聊天页），只把它拉到前台；
    // 不是 BOSS 页面（空白页 / 上次停在别处）才导航到首页。
    if (/zhipin\.com/.test(currentUrl())) {
      log('你已经停在 BOSS 上了，直接拉到前台', 'OK');
    } else {
      log('打开 BOSS直聘 首页…');
      try {
        await page.goto(BOSS_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        log('打开首页失败：' + String((e && e.message) || e).slice(0, 80), 'WARN');
      }
    }

    try { await page.bringToFront(); } catch (_) {}
    log('BOSS 已打开（浏览器保持为你开着）', 'OK');
  }

  return { runOpenMode };
};
