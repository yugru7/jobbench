/**
 * 路由表：key = 「方法 + 空格 + 路径」，value = (req,res,body) => ...
 * ----------------------------------------------------------------------------
 * 每个文件是一个 API 组，通过 deps 取用基础模块（state / broadcast / 文件读写 …）。
 */
module.exports = (deps) => {
  // 同组多路由共用同一处理函数（内部按 method / path 分支）
  const collected = require('./collected')(deps);
  const knowledge = require('./knowledge')(deps);
  const prompt = require('./prompt')(deps);
  const config = require('./config')(deps);

  return {
    'GET /api/bootstrap': require('./bootstrap')(deps),

    'GET /api/collected': collected,
    'POST /api/collected/clear': collected,
    'POST /api/collected/clear-sent': collected,
    'POST /api/collected/delete': collected,

    'POST /api/checked': require('./checked')(deps),
    'POST /api/greetings': require('./greetings')(deps),
    'GET /api/events': require('./events')(deps),
    'POST /api/expects': require('./expects')(deps),
    'POST /api/collect': require('./collect')(deps),
    'POST /api/send': require('./send')(deps),
    'POST /api/pause': require('./pause')(deps),
    'POST /api/resume': require('./resume')(deps),
    'POST /api/stop': require('./stop')(deps),
    'POST /api/close-browser': require('./close-browser')(deps),

    'GET /api/knowledge': knowledge,
    'POST /api/knowledge': knowledge,

    'GET /api/prompt': prompt,
    'POST /api/prompt': prompt,

    'GET /api/config': config,
    'POST /api/config': config,

    'GET /api/records': require('./records')(deps),
  };
};
