/**
 * Sentinel = 一个 slot 独占的 PID/mount/network/uts/ipc namespace 集合的"占位进程"。
 *
 * 为什么需要 sentinel，而不是每次 exec 现建 namespace：
 * namespace 本身创建很快（微秒级），但要保持"这组 namespace 一直存在，
 * 好让同一租约的第二次 exec 还能进到同一个地方"，就需要有个东西**一直活着**
 * 占住这组 namespace —— 只要还有一个进程在里面，内核就不会回收它。
 * `sleep infinity` 就是这个占位进程，它什么也不干，只是把 namespace 焊住。
 *
 * 一个绕不开的内核细节（CLONE_NEWPID 的特殊性）：
 * unshare(CLONE_NEWPID) 之后，**调用者自己不会被移进新的 PID namespace**——
 * 只有它之后 fork 出来的子进程才会。所以 `unshare --pid --fork -- sleep infinity`
 * 跑出来是两个进程：
 *   - unshare 本体（父）：还在**外层** PID namespace，但已经进入了新的
 *     mount/net/uts/ipc namespace（这几个 unshare() 一调用就立刻切换，不等 fork）
 *   - sleep infinity（子）：新 PID namespace 里的 1 号进程，同时因为是 fork 出来的，
 *     自动带着父进程已经切换过的那套 mount/net/uts/ipc namespace
 *
 * 所以 nsenter 的目标必须是**子进程**——只有它的 /proc/<pid>/ns/pid 指向新 namespace；
 * 父进程的 ns/pid 还是外层那个。子进程的 ns/mnt|net|uts|ipc 与父进程相同，
 * 所以盯住子进程一个 PID 就够了，五个 namespace 全对。
 *
 * 子进程的 PID（外层视角的号码）拿不到"参数传回"这种便宜手段——PID 是
 * namespace 相关的数字，子进程自己用 getpid() 只会看到"1"。只能反过来，
 * 从外层读 `/proc/<父pid>/task/<父pid>/children`（Linux 暴露的子进程列表，
 * 读的人在哪个 namespace 就是哪个 namespace 视角的号码）。
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

/** 反复读 children 列表，直到子进程出现（fork+exec 之间有微小的时间差） */
async function findChildPid(parentPid, { retries = 100, delayMs = 20 } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const raw = await readFile(`/proc/${parentPid}/task/${parentPid}/children`, 'utf8')
      const child = raw.trim().split(/\s+/).filter(Boolean)[0]
      if (child) return Number(child)
    } catch {
      // /proc 还没就绪，或者 unshare 已经失败退出——继续重试直到超时
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return null
}

/**
 * 起一个 sentinel。成功时返回：
 *   - `parentPid`：unshare 本体的 pid（外层 namespace，用来杀整棵树）
 *   - `pid`：sleep infinity 的 pid（**nsenter 的目标**，五个 namespace 都在这）
 *   - `kill()`：销毁——杀 parentPid 即可，内核会连带杀掉子进程；
 *     子进程一死，namespace 引用计数归零，整组 namespace 被内核回收，
 *     没有"忘了清理"这个选项。
 *
 * @param {object} params
 * @param {import('../logger.js').Logger} params.logger
 * @param {number} [params.timeoutMs] 等子进程出现的超时
 */
export async function spawnSentinel({ logger, timeoutMs = 3000 } = {}) {
  // --mount-proc：给新 PID+mount namespace 配一份干净的 /proc，否则里面的 `ps`
  // 看到的还是宿主机的旧 /proc，namespace 隔离在用户可见层面就白做了。
  // `mount --make-rprivate /` 是另一个容易漏掉的细节：不加这句，本 namespace 里
  // 做的挂载操作在某些发行版的默认传播设置下会泄漏回宿主机的挂载表
  // （systemd 管理的系统默认把 / 设成 shared propagation）。
  //
  // 私有 /tmp、/dev/shm 不在这里挂 —— 见 slot-pool.js 的 mountPrivateTmp()：
  // 它必须排在工作区 bind mount **之后**，否则会把 bind 的源路径盖掉。
  const child = spawn(
    'unshare',
    [
      '--mount', '--uts', '--ipc', '--net', '--pid',
      '--fork', '--mount-proc',
      '--',
      '/bin/sh', '-c', 'mount --make-rprivate / 2>/dev/null; exec sleep infinity',
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const parentPid = child.pid
  let stderrBuf = ''
  child.stderr?.on('data', (chunk) => { stderrBuf += chunk.toString('utf8').slice(0, 2000) })

  const exitedEarly = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  const pid = await Promise.race([
    findChildPid(parentPid, { retries: Math.floor(timeoutMs / 20), delayMs: 20 }),
    exitedEarly.then(() => null),
  ])

  if (!pid) {
    try { process.kill(-parentPid, 'SIGKILL') } catch { /* 已经没了 */ }
    throw Object.assign(
      new Error(`sentinel 启动失败：拿不到子进程 pid（unshare 可能缺 capability 或已退出）。stderr: ${stderrBuf.trim() || '(空)'}`),
      { code: 'SENTINEL_SPAWN_FAILED' },
    )
  }

  logger?.info?.('sentinel 已就绪', { parentPid, sentinelPid: pid })

  return {
    parentPid,
    pid,
    async kill(signal = 'SIGKILL') {
      // 杀进程组（负号），parentPid 与它 fork 出的子进程通常在同一个组里；
      // 双保险再单独杀一次 sentinelPid，避免某些情况下进程组关系被打断。
      try { process.kill(-parentPid, signal) } catch { /* 已经没了 */ }
      try { process.kill(pid, signal) } catch { /* 已经没了 */ }
    },
  }
}
