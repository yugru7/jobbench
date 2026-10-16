/**
 * 知识库（我的经历）只读加载
 * ----------------------------------------------------------------------------
 * 由界面维护 knowledge.json，这里只做加载 + 格式兼容，绝不改写。
 * 文件不存在时返回 null（调用方按「未配置」处理）。
 *
 * 【设计原则】招呼语里的每一句都必须逐字来自你自己填的经历，
 * 脚本只做"挑选和拼接"，不做任何改写或编造 —— 面试被追问时才不会露馅。
 *
 * 用法：const { KNOWLEDGE, KNOWLEDGE_FILE, normalizeEntries } = require('./lib/knowledge')(dir);
 */
const fs = require('fs');
const path = require('path');

module.exports = (dir) => {
  const KNOWLEDGE_FILE = path.join(dir, 'knowledge.json');
  let KNOWLEDGE = null;
  try {
    if (fs.existsSync(KNOWLEDGE_FILE)) {
      KNOWLEDGE = JSON.parse(fs.readFileSync(KNOWLEDGE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[知识库] knowledge.json 解析失败，已忽略：' + e.message);
  }

  // 经历条目兼容：新格式 { title, content }；旧格式（有过 highlights 的）自动合并成一段内容
  // （AI 生成招呼语时用它拼素材；也兼容用户手里早期格式的文件）
  function normalizeEntries(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.map(en => {
      if (!en || typeof en !== 'object') return null;
      if (en.content) return en;
      // highlights 只在"确实是数组"时才遍历 —— 兼容旧格式的同时，兜住类型不对的输入
      const texts = (Array.isArray(en.highlights) ? en.highlights : [])
        .map(h => h && h.text).filter(Boolean);
      const head = [en.role, en.summary].filter(Boolean).join('：');
      return { title: en.title || '', content: [head].concat(texts).filter(Boolean).join('\n') };
    }).filter(en => en && String(en.content || '').trim());
  }

  return { KNOWLEDGE, KNOWLEDGE_FILE, normalizeEntries };
};
