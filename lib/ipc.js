/**
 * IPC 协议与暂停/停止控制（从 greet.js 外提，纯搬运）
 * ----------------------------------------------------------------------------
 * server.js 用子进程驱动本脚本时加 --ipc：
 *   事件 → stdout（前缀 @@IPC@@ + JSON 一行），界面实时显示
 *   指令 ← stdin（PAUSE / RESUME / STOP / SEND / SKIP / CLOSE），界面上的按钮
 * 不加这个参数时，脚本行为和以前完全一致（纯命令行）。
 *
 * 用法：const ipc = require('./lib/ipc')({ ipc: IPC, sleep });
 */
module.exports = (deps) => {
  const { ipc: IPC, sleep } = deps;
  const IPC_MARK = '@@IPC@@';

  function ipcEmit(obj) {
    if (!IPC) return;
    try { process.stdout.write(IPC_MARK + JSON.stringify(obj) + '\n'); } catch (_) {}
  }

  let ipcPaused = false, ipcStopped = false;
  const isPaused = () => ipcPaused;
  const isStopped = () => ipcStopped;

  // "逐个确认"模式下，脚本会停下来等界面发指令（SEND = 发出去 / SKIP = 跳过这个）
  let cmdWaiter = null;
  const hasCmdWaiter = () => !!cmdWaiter;

  if (IPC) {
    // 界面随时可能发指令，这里保持监听
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.on('line', (raw) => {
      const cmd = String(raw || '').trim().toUpperCase();

      // 一问一答类的指令，优先交给等待者
      if ((cmd === 'SEND' || cmd === 'SKIP' || cmd === 'CLOSE') && cmdWaiter) {
        const w = cmdWaiter;
        cmdWaiter = null;
        w(cmd);
        return;
      }

      if (cmd === 'PAUSE') {
        ipcPaused = true;
        ipcEmit({ t: 'state', status: 'paused' });
      } else if (cmd === 'RESUME') {
        ipcPaused = false;
        ipcEmit({ t: 'state', status: 'running' });
      } else if (cmd === 'STOP') {
        ipcStopped = true;
        ipcPaused = false;
        // 停的时候如果正卡在"等你确认"，也要把人叫醒
        if (cmdWaiter) { const w = cmdWaiter; cmdWaiter = null; w('STOP'); }
        ipcEmit({ t: 'state', status: 'stopping' });
      }
    });
    rl.on('close', () => {
      // 父进程没了就别傻等，直接收手，避免留孤儿进程
      if (!ipcStopped) { ipcStopped = true; }
      if (cmdWaiter) { const w = cmdWaiter; cmdWaiter = null; w('STOP'); }
    });
  }

  // 等界面给一个指令（SEND / SKIP / STOP），最长等 ms 毫秒
  function waitForCmdWithin(ms) {
    return new Promise((resolve) => {
      cmdWaiter = resolve;
      setTimeout(() => { if (cmdWaiter === resolve) { cmdWaiter = null; resolve('TIMEOUT'); } }, ms);
    });
  }
  function waitForCmd() {
    return waitForCmdWithin(30 * 60 * 1000);
  }
  function resolveCmd(v) {
    if (cmdWaiter) { const w = cmdWaiter; cmdWaiter = null; w(v); }
  }

  class StoppedError extends Error {
    constructor() { super('用户已停止'); this.name = 'StoppedError'; }
  }

  // 控制点：只在"岗位之间""关键词之间"这类安全位置调用。
  // 暂停 = 在这里原地等；停止 = 抛 StoppedError 让上层干净收尾。
  async function checkpoint() {
    while (ipcPaused && !ipcStopped) { await sleep(300); }
    if (ipcStopped) throw new StoppedError();
  }

  return { ipcEmit, waitForCmd, waitForCmdWithin, resolveCmd, checkpoint, StoppedError, isPaused, isStopped, hasCmdWaiter };
};
