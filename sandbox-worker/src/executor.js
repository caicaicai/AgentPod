/**
 * 命令执行。所有命令都经 `nsenter` 注入到租约绑定的 slot（见
 * [namespace/slot-pool.js](namespace/slot-pool.js)）——没有"直接在 worker 自己的
 * namespace 里 spawn"这条路，那正是要去掉的隔离薄弱点。
 *
 * 沙盒的隔离性有多少，取决于这个文件里的几个细节：
 *
 *  1. **环境从零构造，不继承 worker 的 env。** worker 的 env 里有 SANDBOX_TOKEN；
 *     继承过去等于把"能在沙盒里执行任意命令"的钥匙交给被执行的命令本身。
 *  2. **HOME 指向 job 工作区。** 有技能会往 homedir 写数据
 *     （managed-skills/bot-send/scripts/message-store.mjs），
 *     HOME 若是全局的，A 用户写的消息记录 B 用户就能读到。
 *  3. **detached:true 建独立进程组，杀的时候杀整组。** 只 kill 子进程的话，
 *     它 spawn 出来的孙子进程会留下继续跑（还连着网络）。namespace 模式下这是
 *     双保险——即使进程组杀漏了，slot 回收时整个 PID namespace 也会被销毁。
 *  4. **输出有上限。** 一条 `yes` 就能把流打爆，撑死的是 agent service 不是沙盒。
 *  5. **`--setuid/--setgid` 必须是 nsenter 自己做，不能用 Node 的 spawn({uid})。**
 *     见 `buildNsenterInvocation` 的注释——顺序反了会导致 setns() 因权限不足直接失败。
 *  6. **进程要先把自己加进 slot 的 cgroup，再 exec 目标命令。** 见
 *     `buildSlotInvocation`——没有这一步，cpu/memory/pids 限额全都挂在一个空
 *     cgroup 上，配置看着齐全但一条都不生效。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { nsenterForkArgs } from './namespace/nsenter-compat.js'
import { buildCgroupJoinScript } from './namespace/cgroup.js'

/** SIGTERM 之后进程组还没死，就 SIGKILL */
function killTree(pid, signal) {
  try {
    process.kill(-pid, signal) // 负号 = 整个进程组
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // 已经没了
    }
  }
}

/**
 * 构造 job 的环境变量。**不继承 process.env。**
 * @param {object} params
 * @param {Record<string,string>} params.extraEnv 调用方追加的，键名受白名单约束
 */
export function buildJobEnv({ config, workspace, extraEnv = {} }) {
  const allow = new RegExp(config.envKeyAllow)

  const env = {
    PATH: config.jobPath,
    HOME: workspace.homeDir, // ← 见文件头 #2
    TMPDIR: workspace.tmpDir,
    PWD: workspace.rootDir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    SHELL: config.exec.shell,
    // 技能靠这几个找运行时（与桌面端注入的变量同名）
    AP_NODE_BIN: config.runtime.nodeBin,
    AP_PYTHON_BIN: config.runtime.pythonBin,
    ...(config.runtime.skillLibsDir ? { AP_SKILL_LIBS_DIR: config.runtime.skillLibsDir } : {}),
    ...(config.runtime.userSkillsDir ? { AP_USER_SKILLS_DIR: config.runtime.userSkillsDir } : {}),
  }

  const rejected = []
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (!allow.test(key)) {
      rejected.push(key)
      continue
    }
    if (value === undefined || value === null) continue
    env[key] = String(value)
  }
  return { env, rejected }
}

/**
 * 拼 ulimit 前缀。放在命令前面用 `;` 连接，而不是包一层 sh —— 少一层进程好追。
 *
 * 只设 `-f`（单文件大小上限）。**不设 `-u`（进程数）**——那按 uid 统计，
 * 现在进程数限额交给 cgroup 的 `pids.max`（按 slot 统计，见
 * [namespace/cgroup.js](namespace/cgroup.js)），两套机制并存只会让人分不清哪个生效了。
 *
 * 也**不设 `-v`**：它限制虚拟地址空间，而 Node / Python 一启动就映射一大片，
 * 一设就直接起不来。真正要的是 RSS 限制，cgroup 的 `memory.max` 给。
 */
export function buildUlimitPrefix(config) {
  const parts = []
  if (config.exec.maxFileSizeKb > 0) parts.push(`ulimit -f ${config.exec.maxFileSizeKb} 2>/dev/null || true`)
  return parts.length ? `${parts.join('; ')}; ` : ''
}

/** POSIX 单引号转义：把任意字符串变成一个 shell 里安全的单词 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

/**
 * 组装 `nsenter` 调用，把命令注入到 slot 的 namespace 里执行。
 *
 * 三个容易踩的坑，都在这一步解决：
 *   1. **uid 不能通过 Node 的 spawn({ uid }) 传。** 那是在 spawn 出的**这个进程自己**
 *      （也就是 nsenter 本身）身上 setuid，会发生在它真正 setns() 进入目标 namespace **之前**——
 *      setns 需要特权，降权之后就再也做不到了。必须让 nsenter 保持 root 把 setns 做完，
 *      再用它自带的 `--setuid/--setgid` 在 **exec 目标命令前** 的最后一刻降权，顺序才对。
 *   2. **`--pid` 需要"确实 fork 了"。** 不 fork 的话，nsenter 直接 execve 替换自己，
 *      不会真正成为目标 PID namespace 里的新成员。要不要显式传 `--fork` 由
 *      [namespace/nsenter-compat.js](namespace/nsenter-compat.js) 探测决定。
 *   3. **cwd 既不能用 Node spawn 的 `cwd`，也不能用 nsenter 的 `--wd`。**
 *      两者都在**调用方**（worker 自己的）mount namespace 里解析路径，而目标目录
 *      `/sandbox-root/work` 只存在于 slot 的 mount namespace 里。`--wd` 看名字像是
 *      为这个场景准备的，实际不是——它在 setns() **之前**就把目录 open 好，
 *      于是必然报 `nsenter: cannot open /sandbox-root/work: No such file or directory`，
 *      而且这个错误发生在命令跑起来之前，表现为"每条命令都没有输出"。
 *      在特权容器里实测确认过：`--wd=<slot 内路径>` 一定失败，改成让目标 shell
 *      自己 `cd` 就正常（降权之后同样正常）。所以 cwd 是拼进
 *      `shell -c` 的命令串里的，见 execCommand 里 `fullCommand` 的组装。
 *
 * 用 `-c` 而**不是** `-lc`：`-l` 会让 bash 以登录 shell 启动，去 source
 * `/etc/profile`、`/etc/profile.d/*` 和 `~/.bash_profile`。三个后果，没一个是想要的：
 *   1. `buildJobEnv` 白名单构造的环境（PATH/AP_NODE_BIN/…）会被这些脚本覆盖，
 *      那份"不继承 process.env"的白名单就形同虚设；
 *   2. `HOME` 指向 `/sandbox-root/home`，是 job **自己可写**的目录——job 往
 *      `~/.bash_profile` 写点东西，就能让它在这个租约后续的每一条命令里自动执行；
 *   3. 镜像里 `/etc/profile` 会去 source `/home/admin/env_set.sh`，job 的 uid 读不到，
 *      于是**每一条命令**的 stderr 都固定多出一行 `Permission denied`——技能拿到的
 *      每次输出里都掺着这条假错误，模型也会跟着当成真失败。
 */
export function buildNsenterInvocation({ slot, shell, fullCommand }) {
  return {
    cmd: 'nsenter',
    args: [
      '--target', String(slot.sentinel.pid),
      '--pid', '--mount', '--net', '--uts', '--ipc',
      ...nsenterForkArgs(),
      '--setuid', String(slot.uid),
      '--setgid', String(slot.gid),
      '--',
      shell, '-c', fullCommand,
    ],
  }
}

/**
 * 在 nsenter 之外再包一层：让进程**在 exec nsenter 之前先把自己写进 slot 的
 * cgroup**，这样它以及它之后 fork 出来的一切（nsenter 因 `--pid` 而 fork 的
 * 子进程、job 里起的所有孙子进程）都天然落在限额之内。
 *
 * 为什么不能 spawn 完再由 worker 把 pid 搬进去：`spawn()` 返回到 worker 写
 * `cgroup.procs` 之间有一个真实窗口，这期间子进程可能已经 fork 过了；而 cgroup
 * 归属只在 fork 时继承，事后搬父进程不会把已有的孩子带走——于是"限额生效与否"
 * 变成了一场赛跑。
 *
 * 用 `sh -c '<script>' sh <args...>` + `"$@"` 传参，而不是把 nsenter 命令行拼进
 * 脚本字符串：`fullCommand` 是模型给的任意文本，任何形式的字符串拼接都是一条
 * shell 注入路径。走位置参数则完全不经过 shell 的词法解析。
 *
 * 没有可用 cgroup 时（`procsFiles` 为空，说明这台机器压根没挂 cgroup，
 * `/healthz` 上会显示 `cgroupVersion: none`）就直接 spawn nsenter，不白包一层 sh。
 */
export function buildSlotInvocation({ slot, nsenterArgs }) {
  const procsFiles = slot?.cgroup?.procsFiles || []
  if (!procsFiles.length) return { cmd: 'nsenter', args: nsenterArgs }

  const script = `${buildCgroupJoinScript(procsFiles)}\nexec nsenter "$@"`
  // 外层刻意用 /bin/sh 而不是 config.exec.shell：这一层只是"写个文件再 exec"，
  // 要的是一定存在的 POSIX shell，跟 job 用哪个 shell 是两回事。
  return { cmd: '/bin/sh', args: ['-c', script, 'sh', ...nsenterArgs] }
}

/**
 * 跑一条命令，通过 onFrame 流式回帧。
 *
 * @param {object} params
 * @param {object} params.slot 租约绑定的 slot 描述符（来自
 *   [namespace/slot-pool.js](namespace/slot-pool.js)）。必填——所有执行都经 nsenter
 *   注入该 slot 的 PID/mount/net/uts/ipc namespace，没有别的路径。
 * @returns {Promise<{exitCode, signal, truncated, durationMs, outputBytes}>}
 */
export function execCommand({ config, logger, workspace, command, cwd = '', env: extraEnv = {}, timeoutMs, signal, onFrame, slot }) {
  if (!slot?.sentinel?.pid) {
    return Promise.reject(Object.assign(new Error('execCommand 需要一个有效的 slot（namespace 隔离是唯一的执行路径）'), { code: 'NO_SLOT' }))
  }

  const startedAt = Date.now()

  // cwd 只接受相对路径：agent 侧传过来的绝对路径在这个容器里没有意义，
  // 而且真让它生效就等于允许跳出工作区。
  const relativeCwd = String(cwd || '').trim()
  if (path.isAbsolute(relativeCwd)) {
    return Promise.reject(Object.assign(new Error('cwd 必须是相对工作区的路径'), { code: 'BAD_REQUEST' }))
  }
  const resolvedCwd = path.resolve(workspace.rootDir, relativeCwd)
  if (resolvedCwd !== workspace.rootDir && !resolvedCwd.startsWith(`${workspace.rootDir}${path.sep}`)) {
    return Promise.reject(Object.assign(new Error('cwd 逃出了工作区'), { code: 'BAD_REQUEST' }))
  }

  const { env, rejected } = buildJobEnv({ config, workspace, extraEnv })
  if (rejected.length) {
    // 不静默丢弃 —— 调用方多半是拼错了变量名，得让人看见
    logger.warn('调用方传入的环境变量不在白名单内，已丢弃', { rejected, allow: config.envKeyAllow })
  }

  const effectiveTimeout = Math.min(Number(timeoutMs) || config.exec.defaultTimeoutMs, config.exec.maxTimeoutMs)
  // cd 必须由**目标 namespace 里的 shell** 自己做（见 buildNsenterInvocation 注释 #3）。
  // `|| exit 1` 而不是让它默默跑在别的目录下：cwd 不对的话后面每一条相对路径都是错的。
  const fullCommand = `cd ${shellQuote(resolvedCwd)} || exit 1\n${buildUlimitPrefix(config)}${command}`

  const nsenter = buildNsenterInvocation({ slot, shell: config.exec.shell, fullCommand })
  const invocation = buildSlotInvocation({ slot, nsenterArgs: nsenter.args })

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(invocation.cmd, invocation.args, {
        // cwd 由目标 namespace 里的 shell 自己 cd（见 buildNsenterInvocation 注释 #3）。
        // Node 这层不能传 cwd —— resolvedCwd 在 worker 自己的 mount namespace 里并不存在。
        env,
        detached: true, // ← 见文件头 #3
        stdio: ['ignore', 'pipe', 'pipe'],
        // 降权交给 nsenter 的 --setuid/--setgid（见上面的函数注释 #1），
        // 这里绝不能传 uid/gid，否则 nsenter 自己会先被降权，setns() 直接失败。
      })
    } catch (error) {
      reject(Object.assign(new Error(`无法启动命令：${error.message}`), { code: 'SPAWN_FAILED' }))
      return
    }

    let outputBytes = 0
    let truncated = false
    let settled = false
    let timedOut = false
    let aborted = false
    let killTimer = null

    const forward = (type) => (chunk) => {
      if (truncated) return // 超限后继续排空但不再转发，避免背压
      const remaining = config.exec.maxOutputBytes - outputBytes
      if (chunk.length >= remaining) {
        if (remaining > 0) onFrame({ type, data: chunk.subarray(0, remaining).toString('utf8') })
        outputBytes = config.exec.maxOutputBytes
        truncated = true
        onFrame({ type: 'stderr', data: `\n[sandbox] 输出超过 ${config.exec.maxOutputBytes} 字节上限，后续输出已丢弃\n` })
        return
      }
      outputBytes += chunk.length
      onFrame({ type, data: chunk.toString('utf8') })
    }

    child.stdout.on('data', forward('stdout'))
    child.stderr.on('data', forward('stderr'))

    const terminate = (reason) => {
      if (settled) return
      if (reason === 'timeout') timedOut = true
      if (reason === 'abort') aborted = true
      killTree(child.pid, 'SIGTERM')
      killTimer = setTimeout(() => killTree(child.pid, 'SIGKILL'), config.exec.killGraceMs)
    }

    const timer = setTimeout(() => terminate('timeout'), effectiveTimeout)
    const onAbort = () => terminate('abort')
    signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(Object.assign(new Error(`执行失败：${error.message}`), { code: 'SPAWN_FAILED' }))
    })

    child.on('close', (code, closeSignal) => {
      if (settled) return
      settled = true
      cleanup()
      // 保险：即使正常退出，也把可能残留的孙子进程连根拔掉
      killTree(child.pid, 'SIGKILL')

      resolve({
        exitCode: code,
        signal: closeSignal,
        truncated,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        outputBytes,
      })
    })
  })
}
