// 工作台端到端测试：走界面用的 API，跑一次 collect，验证事件流
// collect 模式绝不会发送任何消息
const BASE = 'http://127.0.0.1:7788';
const lines = [];
const P = (s) => { lines.push(s); console.log(s); };
let done = false;
let browserKept = false;
let myRid = -1;   // 每次任务有自增 id，服务端事件都带 rid —— 用它过滤回放的旧事件

async function main() {
  P('=== 工作台端到端测试（collect，不发送）===');

  const ctrl = new AbortController();
  const sse = (async () => {
    try {
      const res = await fetch(BASE + '/api/events', { signal: ctrl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const chunk of parts) {
          const line = chunk.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch (_) { continue; }

          if (ev.t === 'run-started') myRid = ev.rid;
          if (myRid < 0 || ev.rid !== myRid) continue;   // 回放的旧事件，跳过

          if (ev.t === 'log') P(`  [${ev.tag || '·'}] ${ev.msg}`);
          else if (ev.t === 'candidates') P(`  [候选] ${ev.jobs.length} 个`);
          else if (ev.t === 'browser-kept') {
            P('  [浏览器保持打开] ✓ —— 这就是修复点');
            browserKept = true;
            // 验证完保持行为就关掉
            (async () => {
              await new Promise(r => setTimeout(r, 1500));
              const cr = await fetch(BASE + '/api/close-browser', { method: 'POST' });
              P('  → close-browser 返回: ' + JSON.stringify(await cr.json()));
            })();
          }
          else if (ev.t === 'browser-closed') { P('  [浏览器已关闭] ✓'); }
          else if (ev.t === 'candidate') {
            P(`  [岗位] ${ev.job.job} @ ${ev.job.company} | ${ev.job.area} | ${ev.job.salary || '无薪资'}`);
            P(`         活跃度=${ev.job.active || '未显示'} | 匹配=${ev.job.matched} | JD=${ev.job.jdLen}字`);
            P(`         招呼语：${ev.job.greeting}`);
          }
          else if (ev.t === 'collect-progress') P(`  [进度 ${ev.index}/${ev.total}] ${ev.current}`);
          else if (ev.t === 'collect-done') { P(`  [完成] ${ev.ok}/${ev.total}`); }
          else if (ev.t === 'run-exit') { P(`  [退出] code=${ev.code}`); ctrl.abort(); return; }
          else P(`  [${ev.t}] ${JSON.stringify(ev).slice(0, 130)}`);
        }
      }
    } catch (e) { if (e.name !== 'AbortError') P('  SSE 错误: ' + e.message); }
  })();

  await new Promise(r => setTimeout(r, 700));
  P('启动 collect…');
  const r = await fetch(BASE + '/api/collect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keywords: ['前端开发实习'], maxJobs: 3, cityCode: '101010100', cityName: '北京' }),
  });
  P('  → ' + JSON.stringify(await r.json()));

  const t0 = Date.now();
  // 等 collect-done 之后，还要等到 browser-kept / browser-closed / run-exit
  while (!done && Date.now() - t0 < 240000) await new Promise(r => setTimeout(r, 800));
  await sse.catch(() => {});

  P('');
  P('=== 浏览器保活检查 ===');
  P(browserKept ? '✅ 任务结束后浏览器保持打开（修复生效）' : '❌ 没等到 browser-kept 事件');

  // 校验落盘
  const col = await (await fetch(BASE + '/api/collected')).json();
  P('');
  P(`=== 落盘检查：${(col.jobs || []).length} 个岗位 ===`);
  (col.jobs || []).forEach((j, i) => P(`  ${i + 1}. ${j.job} @ ${j.company} | 活跃度 ${j.active} | 招呼语 ${j.greeting.length} 字`));

  const fs = require('fs');
  fs.writeFileSync(require('path').join(__dirname, '..', '..', 'logs', 'test-workbench.txt'), lines.join('\n'), 'utf8');
  process.exit(0);
}
main().catch(e => { P('异常: ' + e.message); process.exit(1); });
