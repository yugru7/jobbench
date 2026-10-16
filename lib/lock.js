/**
 * 单实例锁：防止两个任务同时跑、互相抢浏览器
 * ----------------------------------------------------------------------------
 * 【踩过的坑】快速点两次"开始"会拉起两个 greet.js，两个实例共用同一个 profile：
 *   一个抢到浏览器正常跑，另一个 launchPersistentContext 直接
 *   "Target page, context or browser has been closed" 崩掉 —— 界面就显示"出错了"。
 * 这里用 profile 目录下的锁文件保证全局只有一个实例在跑。
 *
 * 用法：const { acquireLock, releaseLock } = require('./lib/lock')(CFG.profileDir);
 *       process.on('exit', releaseLock);   // 进程退出自动释放
 */
const fs = require('fs');

module.exports = (profileDir) => {
  const LOCK_FILE = require('path').join(profileDir, 'greet.lock');

  function pidAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }   // EPERM = 进程在但没权限，也算活着
  }

  // 幂等标记：本进程是否已经释放过锁。
  // 【为什么必须幂等】"干完活立刻放锁"后，进程可能还要保活浏览器很久（最长 1 小时），
  // 期间 process.on('exit') 兜底还会再调一次 releaseLock —— 重复调用不能报错、
  // 更不能误删已经属于别人的锁。
  let released = false;

  function acquireLock() {
    try {
      fs.mkdirSync(profileDir, { recursive: true });
      if (fs.existsSync(LOCK_FILE)) {
        const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10) || 0;
        // 上个实例被强杀时来不及删锁，这里按 pid 判断是否残留（进程已死 → 锁是陈旧的，直接接管）
        if (pid && pid !== process.pid && pidAlive(pid)) return { ok: false, pid };
      }
      fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
      released = false;   // 重新拿到锁 → 重置幂等标记
      return { ok: true };
    } catch (_) { return { ok: true }; }   // 锁机制本身出问题不要挡主流程
  }

  // 释放锁（幂等）：已释放过 → 直接返回；否则只在"锁文件确实是本进程 pid"时才删。
  function releaseLock() {
    if (released) return;
    try {
      if (fs.existsSync(LOCK_FILE) &&
          fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) {
        fs.rmSync(LOCK_FILE, { force: true });
      }
      released = true;
    } catch (_) { released = true; }
  }

  return { acquireLock, releaseLock };
};
