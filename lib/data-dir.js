/**
 * 数据目录（data/）+ 一次性自动迁移
 * ----------------------------------------------------------------------------
 * 所有「用户数据 / 可再生成的配置数据」统一放在项目根目录的 data/ 下，与代码分离：
 *   data/config.json            运行配置
 *   data/knowledge.json         知识库（私有，不进仓库）
 *   data/knowledge.example.json 首次使用的示例知识库（随仓库附带）
 *   data/cities.json            BOSS 城市列表（随仓库附带，可 update-cities.js 刷新）
 *   data/filters.json           BOSS 筛选选项 + 区县（随仓库附带，可 update-filters.js 刷新）
 *
 * 【自动迁移】老版本把这些文件放在项目根目录。首次加载本模块时，若 data/ 里没有
 * 而根目录有同名文件，就搬进 data/ —— 只在「目标不存在」时搬，绝不覆盖 data/ 里的新数据。
 * 迁移是幂等的：搬过一次后就什么都不做了。
 *
 * 用法：const { DIR, DATA_DIR, migrate } = require('./lib/data-dir');
 * （模块加载时已自动执行一次 migrate，调用方通常无需再显式调用）
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(DIR, 'data');

// 需要从根目录搬进 data/ 的文件（含个人数据与随仓库附带的默认数据）
const FILES = [
  'config.json',
  'knowledge.json',
  'knowledge.example.json',
  'cities.json',
  'filters.json',
];

function migrate() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  for (const f of FILES) {
    const src = path.join(DIR, f);
    const dest = path.join(DATA_DIR, f);
    if (fs.existsSync(dest) || !fs.existsSync(src)) continue;   // 目标已有 / 源不存在 → 不动
    try {
      fs.renameSync(src, dest);   // 同盘移动，最快
    } catch (_) {
      // 跨盘 / 被占用时退化成「复制 + 删除」
      try { fs.copyFileSync(src, dest); fs.unlinkSync(src); } catch (_) {}
    }
  }
}

migrate();

module.exports = { DIR, DATA_DIR, migrate, FILES };
