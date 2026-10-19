/**
 * 详情页的招聘者活跃度读取（页面侧唯一实现）
 * ----------------------------------------------------------------------------
 * BOSS 详情页的活跃度有两种 DOM，取决于招聘者此刻在不在线：
 *   ① 不在线：活跃度写在 span.boss-active-time 里，文本如「3日内活跃」「近半年活跃」；
 *   ② 在线：没有 .boss-active-time，改用 span.boss-online-tag，文本就是「在线」。
 * 两者都在 .job-boss-info 区块内（形如「庞女士 3日内活跃 中码科技 · 人事」）。
 *
 * 读取顺序：.boss-active-time → .boss-online-tag → .job-boss-info 区块文本 → 整页兜底。
 * 前两路是结构化定位：元素在就直接采纳它的 textContent 原文，不再用正则二次校验
 * （BOSS 的文案很杂：刚刚/今日/本周/本月/近期/N日周月年内或前 + 在线，枚举不全）。
 * 结构化元素都没命中（页面改版 / 只渲染了一半）才退化到正则，从区块 / 整页文本里捞。
 * 整页兜底放在最后：页面里有「在线职位及时沟通」「与在线Boss直接聊」这类干扰文案，
 * 先走区块就不会被它们污染。
 *
 * 仍读不到活跃度时，把 .job-boss-info 原文截 60 字作为留证（activeRaw）——
 * 事后能分清是「BOSS 本来就没展示活跃度」还是「又没读到」。
 *
 * lib/collect.js（采集详情页）与 lib/reread-active.js（刷新候选池活跃度）共用本文件，
 * 避免两套读取逻辑各自演化、走偏。用法：await page.evaluate(readActiveInPage)
 */

// 详情页「已加载完成」判据：详情页必有打招呼按钮，出现它才算渲染到位。
// 采集和刷新都用它判定 goto 之后页面可用（判定不完就重试）。
const DETAIL_LOADED_JS = `(function(){
  var t = document.body ? document.body.innerText : '';
  return /立即沟通|打招呼|继续沟通/.test(t);
})()`;

// 页面上下文里执行：返回 { active, activeRaw }
function readActiveInPage() {
  const clean = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  // 兜底路径（区块 / 整页）用的文案白名单：只认「N日/周/月/年内或前活跃 + 刚刚/今日/本周/本月/近期 + 近半年/半年前活跃」。
  // 特别注意：**「在线」不放进这个正则** —— 页面里有「在线职位及时沟通」「与在线Boss直接聊」这类
  // 干扰文案，放进整页兜底会把它们误当成活跃度（真·在线靠下面的 .boss-online-tag 结构化定位）。
  const RE = /(\d+\s*(?:日|天|周|个?月|年)(?:内|前)活跃|刚刚活跃|今日活跃|本周活跃|本月活跃|近期活跃|近?半年(?:内|前)?活跃)/;
  let active = '';

  // ① 招聘者不在线：活跃度元素，直接采纳原文
  const at = clean(document.querySelector('.boss-active-time'));
  if (at) active = at;

  // ② 招聘者在线：没有活跃度元素时才出现「在线」标签，同样直接采纳原文
  if (!active) {
    const ot = clean(document.querySelector('.boss-online-tag'));
    if (ot) active = ot;
  }

  // ③ 结构化元素都没命中：从招聘者区块文本里捞
  if (!active) {
    const infoEl = document.querySelector('.job-boss-info') || document.querySelector('[class*="boss-info"]');
    const m = infoEl ? (infoEl.textContent || '').match(RE) : null;
    if (m) active = m[1];
  }

  // ④ 最后才退化到整页文本
  if (!active) {
    const full = document.body ? document.body.innerText : '';
    const m = full.match(RE);
    if (m) active = m[1];
  }

  // 留证：仍读不到就把招聘者区块原文截一段
  let activeRaw = '';
  if (!active) {
    const infoEl = document.querySelector('.job-boss-info');
    if (infoEl) activeRaw = (infoEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  return { active, activeRaw };
}

module.exports = { readActiveInPage, DETAIL_LOADED_JS };
