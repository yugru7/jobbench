/**
 * 回归：设置页单位换算「说人话」层（反馈：术语看不懂）
 * 用法：node tests/verify-settings-units.js（纯函数，无需启动服务）
 *
 * 界面显示：秒 / 百分数   ←→   config 存储：毫秒 / 0~1 小数
 * 换算只在设置页一层做，config 与 greet.js 零改动。
 * 关键性质：往返一致（cfg → view → cfg 必须回到原值），否则用户改一次就漂移。
 */
const fs = require('fs');
const path = require('path');

// 从 actions.js 真实提取换算函数（不复制粘贴，避免测的和跑的不是同一份）
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'actions.js'), 'utf8');
const start = src.indexOf('const toView =');
const end = src.indexOf('// 进设置页时拉当前值');
if (start < 0 || end < 0 || end <= start) {
  console.log('❌ 无法定位 toView/toCfg（actions.js 结构变了？先同步这个测试）');
  process.exit(1);
}
const mod = {};
new Function('module', 'exports', src.slice(start, end) + '\nmodule.exports = { toView, toCfg };')(mod);
const { toView, toCfg } = mod.exports;

let pass = 0, fail = 0;
const ok = (c, name, extra) => { c ? (pass++, console.log('  ✅ ' + name + (extra ? '  ' + extra : ''))) : (fail++, console.log('  ❌ ' + name + (extra ? '  ' + extra : ''))); };

// config 键, config 值, 期望界面值, 说明
const CASES = [
  ['clickPauseMinMs', 0, 0, '点击前停留下限 0ms → 显示 0 秒'],
  ['clickPauseMaxMs', 2000, 2, '点击前停留上限 2000ms → 显示 2 秒'],
  ['readPauseMinMs', 1000, 1, '阅读停顿下限 1000ms → 显示 1 秒'],
  ['readPauseMaxMs', 2000, 2, '阅读停顿上限 2000ms → 显示 2 秒'],
  ['delayTailRatio', 0.25, 25, '发送长尾 0.25 → 显示 25%'],
  ['collectDelayTailRatio', 0.25, 25, '爬取长尾 0.25 → 显示 25%'],
  ['delayMinSec', 4, 4, '秒类字段原样'],
  ['readScrollMinPx', 300, 300, '像素类字段原样'],
];

console.log('===== config 值 → 界面显示 =====');
for (const [k, cfg, exp, desc] of CASES) ok(toView(k, cfg) === exp, desc, '实际 ' + toView(k, cfg));

console.log('\n===== 往返一致（界面填回去必须回到原值）=====');
for (const [k, cfg] of CASES) {
  const v = toView(k, cfg), back = toCfg(k, v);
  ok(back === cfg, k, `界面填 ${v} → config ${back}（原 ${cfg}）`);
}

console.log('\n===== 边界 =====');
ok(toCfg('delayTailRatio', 100) === 1, '比例填 100% → 1（= 100%）');
ok(toCfg('delayTailRatio', 5) === 0.05, '比例填 5% → 0.05');
ok(toCfg('delayTailRatio', 0) === 0, '比例填 0% → 0（合法：完全关掉长尾）');
ok(toCfg('delayTailRatio', 150) === 1, '比例填 150% → 钳到 1');
ok(toCfg('readPauseMinMs', 2.5) === 2500, '秒填 2.5 → 2500ms');
ok(toCfg('clickPauseMinMs', 0.1) === 100, '秒填 0.1 → 100ms（亚秒精度不丢）');
ok(toCfg('readPauseMinMs', 'abc') === 'abc', '非法输入原样透传（服务端钳制兜底）');

console.log('\n===== 汇总 =====');
console.log('PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);