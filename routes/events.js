/**
 * GET /api/events —— SSE 事件流（面板实时更新用的）
 * ----------------------------------------------------------------------------
 * 回放策略：只有「断线重连」才回放断档期间的事件 ——
 * EventSource 重连会自动带 Last-Event-ID，全新打开页面不带。
 */
module.exports = (deps) => async (req, res) => {
  const { clients, framesAfter } = deps;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const lastId = parseInt(req.headers['last-event-id'] || '0', 10) || 0;
  if (lastId > 0) {
    for (const frame of framesAfter(lastId)) {
      try { res.write(frame); } catch (_) {}
    }
  }
  clients.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => { clearInterval(hb); clients.delete(res); });
  return;
};
