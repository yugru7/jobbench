/**
 * Job Search Workbench（求职助手）· 本地服务
 * ----------------------------------------------------------------------------
 * 只负责「装配 + 分发」：静态文件 → 路由表 → 未命中 404。只监听 127.0.0.1。
 * 具体业务在 routes/*.js，基础能力在 lib/*.js（http / state / store / runner）。
 *
 * 两阶段工作台：
 *   ① collect  搜岗位 → 逐个读 JD + 招聘者活跃度 → 生成定制招呼语 → 推给界面
 *   ② send     按界面勾选的清单逐个填进 BOSS 输入框 → 按你选的方式发送
 *
 * 启动：node server.js      或双击 启动.bat
 */
const http = require('http');
const fs = require('fs');

const store = require('./lib/store');
const createState = require('./lib/state');
const createHttp = require('./lib/http');
const createRunner = require('./lib/runner');
const buildRoutes = require('./routes');

const PORT = parseInt(process.env.PANEL_PORT || '7788', 10);
const IPC_MARK = '@@IPC@@';
const NODE = process.execPath;
const DIR = store.paths.DIR;

// ---------- 装配依赖（deps）：路由与基础模块都从这里取用 ----------
const st = createState(store);
const runner = createRunner({ ...store, state: st.state, broadcast: st.broadcast, handleEvent: st.handleEvent, nextRunId: st.nextRunId, DIR, NODE, IPC_MARK });
const httpUtil = createHttp({ port: PORT, publicDir: store.paths.PUBLIC_DIR });

const deps = {
  ...store,
  state: st.state,
  broadcast: st.broadcast,
  clients: st.clients,
  framesAfter: st.framesAfter,
  handleEvent: st.handleEvent,
  startChild: runner.startChild,
  sendCmd: runner.sendCmd,
  stopChildAsync: runner.stopChildAsync,
  childAlive: runner.childAlive,
  getChild: runner.getChild,
  killKeptBrowser: runner.killKeptBrowser,
  json: httpUtil.json,
  readBody: httpUtil.readBody,
  IPC_MARK,
  NODE,
};

const routes = buildRoutes(deps);

// ---------- HTTP 服务：静态 → 路由分发 → 未命中 404 ----------
const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;

  // 本机来源白名单：Host / Origin 不合法直接 403
  if (!httpUtil.checkOrigin(req, res)) return;

  try {
    const handler = routes[`${req.method} ${p}`];
    if (handler) {
      const body = req.method === 'POST' ? await httpUtil.readBody(req) : {};
      return await handler(req, res, body);
    }
    if (p === '/' || p === '/index.html') return httpUtil.serveStatic(res, 'index.html');
    return httpUtil.serveStatic(res, p.replace(/^\/+/, ''));
  } catch (e) {
    return httpUtil.json(res, 500, { ok: false, error: e.message });
  }
});

const OPEN_BROWSER = process.argv.includes('--open');
server.listen(PORT, '127.0.0.1', () => {
  const u = `http://127.0.0.1:${PORT}`;
  console.log('');
  console.log('  ============================================================');
  console.log('   Job Search Workbench · 求职助手 工作台已启动');
  console.log('  ------------------------------------------------------------');
  console.log(`   界面地址：${u}`);
  console.log('   关闭这个窗口 = 停止服务（正在跑的任务也会一起结束）');
  console.log('  ============================================================');
  console.log('');
  if (OPEN_BROWSER) {
    require('child_process').exec(`start "" "${u}"`, { shell: 'cmd.exe' }, () => {});
  }

  // ---- CLI 兜底：agent 若绕过 HTTP 直接命令行跑 greet.js，池子文件会被直接写 ----
  // 轮询 mtime（3s），变了就广播 pool-refresh，保证面板数据跟得上。
  // （正常 HTTP 路径本来就实时推 SSE，这个只是兜底；发送进度等仍以 HTTP 路径为准）
  let poolMtime = 0;
  try { poolMtime = fs.existsSync(store.paths.COLLECT_FILE) ? fs.statSync(store.paths.COLLECT_FILE).mtimeMs : 0; } catch (_) {}
  setInterval(() => {
    try {
      if (!fs.existsSync(store.paths.COLLECT_FILE)) return;
      const m = fs.statSync(store.paths.COLLECT_FILE).mtimeMs;
      if (m === poolMtime) return;
      poolMtime = m;
      const data = store.readJson(store.paths.COLLECT_FILE, null);
      if (data && Array.isArray(data.jobs) && data.jobs.length) {
        st.broadcast({ t: 'pool-refresh', jobs: data.jobs, at: data.at || '' });
      }
    } catch (_) {}
  }, 3000);
});

process.on('SIGINT', () => {
  if (runner.childAlive()) { try { runner.getChild().kill(); } catch (_) {} }
  process.exit(0);
});
