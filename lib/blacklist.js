/**
 * 黑名单：反复失败的岗位不再浪费时间
 * ----------------------------------------------------------------------------
 * 格式：每行 "jobUrl|失败次数"。调用点决定几算"反复失败"。
 *
 * 用法：const { loadSkipList, saveSkipList, markFail } = require('./lib/blacklist')(skipFile);
 */
const fs = require('fs');

module.exports = (skipFile) => {
  function loadSkipList() {
    const map = new Map();
    if (!fs.existsSync(skipFile)) return map;
    fs.readFileSync(skipFile, 'utf8').split('\n').forEach(line => {
      const [url, n] = line.split('|');
      if (url && url.trim()) map.set(url.trim(), parseInt(n || '0', 10));
    });
    return map;
  }

  function saveSkipList(map) {
    const out = Array.from(map.entries()).map(([u, n]) => `${u}|${n}`).join('\n');
    try { fs.writeFileSync(skipFile, out, 'utf8'); } catch (_) {}
  }

  function markFail(map, url) {
    map.set(url, (map.get(url) || 0) + 1);
    saveSkipList(map);
  }

  return { loadSkipList, saveSkipList, markFail };
};
