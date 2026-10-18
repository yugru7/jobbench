// 刷新 BOSS 城市列表 → data/cities.json（省份→城市两级，界面先选省再选市）
// 用法：node update-cities.js             联网抓最新（无需登录）
//       node update-cities.js --from-raw  用 logs 里已存的原始响应本地重建（不联网）
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./lib/data-dir');   // 数据文件统一放 data/
const RAW = path.join(__dirname, 'logs', 'city-raw_wapi_zpCommon_data_city_json.json');

async function fetchText() {
  const { chromium } = require('patchright');
  const CHROME_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const chrome = CHROME_PATHS.find(p => p && fs.existsSync(p));
  if (!chrome) throw new Error('找不到系统 Chrome');
  const b = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-proxy-server'] });
  const p = await (await b.newContext()).newPage();
  await p.goto('https://www.zhipin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(2500);
  const text = await p.evaluate(async () => (await fetch('/wapi/zpCommon/data/city.json')).text());
  await b.close();
  fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
  fs.writeFileSync(RAW, text, 'utf8');   // 留一份原始响应，--from-raw 可离线重建
  return text;
}

(async () => {
  const fromRaw = process.argv.includes('--from-raw');
  const text = fromRaw ? fs.readFileSync(RAW, 'utf8') : await fetchText();
  const z = (JSON.parse(text) || {}).zpData || {};
  if (!Array.isArray(z.cityList) || !z.cityList.length) {
    console.log('接口返回异常，未改动 cities.json：' + String(text).slice(0, 160));
    process.exit(1);
  }
  const hot = (z.hotCityList || [])
    .filter(c => c.name !== '全国' && c.code !== 100010000)   // 全国会让收集端「按城市过滤」失效
    .map(c => ({ code: String(c.code), name: c.name }));
  // 省 → 市 两级（市级下面还有区县，投递用不到，不收）
  const provinces = z.cityList
    .map(p => ({
      code: String(p.code), name: p.name,
      cities: (p.subLevelModelList || []).map(c => ({ code: String(c.code), name: c.name })),
    }))
    .filter(p => p.cities.length);
  const total = provinces.reduce((s, p) => s + p.cities.length, 0);
  const out = {
    _source: `BOSS直聘 /wapi/zpCommon/data/city.json（${fromRaw ? '本地重建' : '抓取'}）`,
    _note: `provinces = 省份→城市两级（共 ${provinces.length} 省 / ${total} 城）；hot = 热门城市（已剔除"全国"）；code 即 BOSS 搜索 URL 的 city 参数`,
    hot,
    provinces,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'cities.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(`已更新 data/cities.json：${provinces.length} 个省份 / ${total} 个城市（热门 ${hot.length}）`);
})().catch(e => { console.log('失败: ' + e.message); process.exit(1); });
