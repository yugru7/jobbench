// 拆分后体检：重复顶层声明 / 关键符号归属 / 引用完整性
const fs = require('fs');
const path = require('path');
const PUB = path.join(__dirname, '..', '..', 'public', 'js');
const files = ['core.js', 'render.js', 'actions.js'];
const tops = {};
for (const f of files) {
  const src = fs.readFileSync(path.join(PUB, f), 'utf8');
  const names = new Set();
  src.split('\n').forEach((l) => {
    let m = l.match(/^(?:async )?function ([A-Za-z_$][\w$]*)/);
    if (m) names.add(m[1]);
    m = l.match(/^(?:let|const|var) ([A-Za-z_$][\w$]*)/);
    if (m) names.add(m[1]);
  });
  tops[f] = names;
}
const seen = new Map();
let dup = 0;
for (const [f, names] of Object.entries(tops)) {
  for (const n of names) {
    if (seen.has(n)) { console.log(`❌ 重复声明: ${n} (${seen.get(n)} 和 ${f})`); dup++; }
    else seen.set(n, f);
  }
}
console.log(dup === 0 ? `✅ 无重复顶层声明（共 ${seen.size} 个顶层符号）` : `发现 ${dup} 处重复`);

// 关键符号必须在位
const need = {
  'core.js': ['toast', 'api', 'esc', 'attr', 'BOOT'],
  'render.js': ['boot', 'renderRows', 'renderFetchRows', 'renderEditRows', 'applyState', 'handle', 'connect', 'pushLog', 'renderHead'],
  'actions.js': ['collect', 'send', 'stop', 'renderKnowledge', 'STARTING'],
};
for (const [f, list] of Object.entries(need)) {
  const miss = list.filter((n) => !tops[f].has(n));
  console.log(`${f}: ${miss.length ? '缺 ' + miss.join(',') : '✅ 全在'}`);
}

// boot 调用必须在 actions.js 末尾（否则脚本还没定义就跑）
const act = fs.readFileSync(path.join(PUB, 'actions.js'), 'utf8');
console.log(act.includes('boot()') ? '✅ actions.js 末尾有 boot() 启动调用' : '❌ 找不到 boot() 调用');

// CSS 兜底列宽必须与 COLS 数量一致 —— 不一致会让多出来那列落进隐式列、被压成一条竖线
const render = fs.readFileSync(path.join(PUB, 'render.js'), 'utf8');
const colsM = render.match(/const COLS = \[([\s\S]*?)\n\];/);
const cssTxt = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'style.css'), 'utf8');
const fbM = cssTxt.match(/grid-template-columns: var\(--tcols,([^;]+)\)/);
if (!colsM || !fbM) {
  console.log('❌ 找不到 COLS 定义或 CSS 兜底列宽');
} else {
  const nCols = (colsM[1].match(/\{ key:/g) || []).length;
  const nFb = (fbM[1].match(/[^\s()]+\([^)]*\)|[^\s()]+/g) || []).length;
  console.log(nCols === nFb ? `✅ 列数一致（${nCols} 列）` : `❌ 列数不一致：COLS=${nCols} / CSS 兜底=${nFb}`);
}

// CSS 变量完整性：所有 var(--x) 引用都必须能在 style.css 找到定义
// （改设计系统时旧变量名残留会静默失效，如 --border-soft / --muted —— 已踩过两次）
{
  const defs = new Set([...cssTxt.matchAll(/--([a-z0-9-]+)\s*:/g)].map(m => m[1]));
  const scan = {
    'style.css': cssTxt,
    'index.html': fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8'),
    'core.js': fs.readFileSync(path.join(PUB, 'core.js'), 'utf8'),
    'render.js': render,
    'actions.js': act,
  };
  const bad = new Set();
  for (const [name, txt] of Object.entries(scan)) {
    for (const m of txt.matchAll(/var\(--([a-z0-9-]+)/g)) {
      if (m[1] === 'tcols') continue;   // JS 运行时注入，未写在 :root
      if (!defs.has(m[1])) bad.add(`${name}: --${m[1]}`);
    }
  }
  console.log(bad.size === 0 ? '✅ CSS 变量引用全部有定义' : `❌ 未定义的 CSS 变量: ${[...bad].join(' / ')}`);
}