// 刷新 BOSS 筛选选项 + 区县 → data/filters.json（面板「岗位初筛」的筛选 chips 数据源）
// 用法：node update-filters.js             联网抓最新（无需登录）
//       node update-filters.js --from-raw  用 logs 里已存的原始响应本地重建（不联网）
//
// 抓两个同源接口（都是公开数据，不用登录）：
//   ① /wapi/zpgeek/pc/all/filter/conditions.json → 求职类型/薪资/经验/学历/规模/融资阶段 选项
//   ② /wapi/zpCommon/data/city.json              → 省→市→区县（区县码供「工作区域」用）
// 选项写成 {code,name} 形式；code 即 BOSS 搜索 URL 的参数值（见 lib/search.js）。
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./lib/data-dir');

const RAW_DIR = path.join(__dirname, 'logs');
const RAW_COND = path.join(RAW_DIR, 'filters-raw_conditions.json');
const RAW_CITY = path.join(RAW_DIR, 'city-raw_wapi_zpCommon_data_city_json.json');

// 筛选选项分组的候选键名（接口字段名可能变，命中哪个用哪个）
const OPT_GROUPS = {
  jobType: ['jobTypeList'],
  salary: ['salaryList'],
  experience: ['experienceList'],
  degree: ['degreeList'],
  scale: ['scaleList'],
  stage: ['stageList'],
};

async function fetchRaw() {
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
  const cond = await p.evaluate(async () => (await fetch('/wapi/zpgeek/pc/all/filter/conditions.json')).text());
  const city = await p.evaluate(async () => (await fetch('/wapi/zpCommon/data/city.json')).text());
  await b.close();
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(RAW_COND, cond, 'utf8');
  fs.writeFileSync(RAW_CITY, city, 'utf8');
  return { cond, city };
}

// 列表项 → { code, name }（salary 另带薪资区间，便于本地参考）
function toOptions(list) {
  if (!Array.isArray(list)) return [];
  return list.map(it => {
    if (!it || it.code == null) return null;
    const o = { code: String(it.code), name: String(it.name || it.subName || '') };
    if (it.lowSalary != null) o.lowSalary = it.lowSalary;
    if (it.highSalary != null) o.highSalary = it.highSalary;
    return o;
  }).filter(o => o && o.name);
}

(async () => {
  const fromRaw = process.argv.includes('--from-raw');
  let condText, cityText;
  if (fromRaw) {
    condText = fs.readFileSync(RAW_COND, 'utf8');
    cityText = fs.readFileSync(RAW_CITY, 'utf8');
  } else {
    ({ cond: condText, city: cityText } = await fetchRaw());
  }

  // ---- ① 筛选选项 ----
  const cond = JSON.parse(condText) || {};
  const zp = cond.zpData || cond.data || cond;
  const options = {};
  for (const [outKey, keys] of Object.entries(OPT_GROUPS)) {
    const list = keys.map(k => zp[k]).find(Array.isArray) || [];
    options[outKey] = toOptions(list);
  }
  const totalOpts = Object.values(options).reduce((s, a) => s + a.length, 0);
  if (!totalOpts) {
    console.log('筛选选项接口返回异常，未改动 data/filters.json。zpData 顶层键：'
      + Object.keys(zp).slice(0, 40).join(', '));
    process.exit(1);
  }
  // 接口的 jobTypeList 只给「全职 / 兼职」，不含「实习」（1902 = 实习有效）——
  // 本工具的典型场景是找实习，补上这个已知有效值（不覆盖接口给的其它值）
  if (Array.isArray(options.jobType) && !options.jobType.some(o => o.name.includes('实习'))) {
    options.jobType.push({ code: '1902', name: '实习' });
  }

  // ---- ② 区县（省→市→区县；districts 以「市 code」为键）----
  const cz = (JSON.parse(cityText) || {}).zpData || {};
  const districts = {};
  let distTotal = 0;
  for (const prov of (cz.cityList || [])) {
    for (const city of (prov.subLevelModelList || [])) {
      const subs = (city.subLevelModelList || [])
        .filter(d => d && d.code != null && d.name)
        .map(d => ({ code: String(d.code), name: d.name }));
      if (subs.length) { districts[String(city.code)] = subs; distTotal += subs.length; }
    }
  }
  const cityCount = Object.keys(districts).length;

  const out = {
    _source: `BOSS直聘 conditions.json + city.json（${fromRaw ? '本地重建' : '抓取'}）`,
    _note: 'options = 各筛选项 {code,name}（code 即搜索 URL 参数值）；districts = 市 code → 区县列表（供「工作区域」multiBusinessDistrict）。'
      + `共 ${totalOpts} 个选项 / ${cityCount} 个市有区县（${distTotal} 个区县）。`,
    options,
    districts,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'filters.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(`已更新 data/filters.json：选项 ${totalOpts} 个（${Object.entries(options).map(([k, v]) => k + ':' + v.length).join(' / ')}），区县 ${cityCount} 市 / ${distTotal} 个`);
})().catch(e => { console.log('失败: ' + e.message); process.exit(1); });
