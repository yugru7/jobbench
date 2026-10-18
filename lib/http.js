/**
 * HTTP 基础件：JSON 响应 / 请求体解析 / 本机来源白名单 / 静态文件服务
 * ----------------------------------------------------------------------------
 * 从 server.js 拆出的基础模块。端口在装配时注入（白名单按端口拼），
 * 保证与旧 server.js 里按 PORT 拼白名单的行为一致。
 */
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

module.exports = ({ port, publicDir }) => {
  // 安全加固：只受理来自本机的请求 —— Host / Origin 白名单。
  //   · Host 白名单挡 DNS rebinding：恶意域名解析到 127.0.0.1 时 Host 是攻击者域名，直接 403
  //   · Origin 白名单挡跨站盲 POST：浏览器跨站请求必带 Origin，白名单外一律 403
  //     （不带 Origin 的请求放行：命令行 / agent / curl 都属此类）
  const ALLOWED_HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1', 'localhost']);
  const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  function json(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  function readBody(req) {
    return new Promise((resolve) => {
      let buf = '';
      req.on('data', (c) => { buf += c; if (buf.length > 4 * 1024 * 1024) req.destroy(); });
      req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (_) { resolve({}); } });
    });
  }
  // 本机来源白名单：Host / Origin 不合法直接 403（返回 false 表示已拒绝）
  function checkOrigin(req, res) {
    const host = req.headers.host || '';
    if (!ALLOWED_HOSTS.has(host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 仅允许本机面板访问');
      return false;
    }
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 来源不允许');
      return false;
    }
    return true;
  }
  function serveStatic(res, rel) {
    const file = path.join(publicDir, rel);
    // 路径穿越加固：带尾部分隔符防止 public-xxx 之类的前缀绕过
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('404'); return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  }

  return { json, readBody, checkOrigin, serveStatic };
};
