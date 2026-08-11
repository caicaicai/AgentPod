/**
 * 每个 slot 独立 cgroup：cpu/memory/pids 限额按 slot 而不是按 uid 统计，
 * 一个用户吃满内存/CPU/进程数不会拖垮同一节点上的其他并发用户。
 *
 * shell 级的 `ulimit -f`（见 [../executor.js](../executor.js)）只能限单文件大小，按 uid
 * 统计的 `ulimit -u` 与容器级的内存上限都管不住"限制单个用户"——cgroup 按 slot
 * 精确限额，才是真正把资源配额下沉到用户粒度。
 *
 * v1 / v2 都要支持：探测阶段（见 bin/check-namespace-caps.sh）在目标环境上
 * 只发现了 cgroup v1，但不能假设所有节点池都一样——写死一种版本，
 * 换个内核版本不同的节点池就直接炸。
 */
import { mkdir, writeFile, readFile, readdir, rmdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * 删掉一个 cgroup 目录。
 *
 * 两个坑，都只有在"cgroup 里真的有进程"之后才会显形（之前这些 cgroup 一直是空的，
 * 因为根本没人被加进去，所以删不掉也没人注意到）：
 *
 *  1. **只能 `rmdir`，不能 `rm -rf`。** 目录里的 `cpu.max`/`cgroup.procs` 都是内核
 *     造的伪文件，`unlink` 一律 EPERM；而递归删除会先去删文件，于是必然失败。
 *     正确做法是直接 `rmdir` 目录本身，内核会把里面的伪文件一起收走。
 *  2. **刚 SIGKILL 完不一定马上能删。** 进程退出是异步的，只要还有一个没被内核
 *     回收，`rmdir` 就是 EBUSY。所以要等一小会儿再重试，而不是一次失败就放弃。
 */
async function removeCgroupDir(dir, logger, { retries = 20, delayMs = 50 } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await rmdir(dir)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      if (error?.code !== 'EBUSY' && error?.code !== 'ENOTEMPTY') {
        logger?.warn?.('cgroup 目录删除失败', { dir, err: error?.message })
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  logger?.warn?.('cgroup 目录始终 EBUSY，可能还有进程没被内核回收', { dir })
  return false
}

/** 先删子 cgroup 再删自己——非空的 cgroup 目录 rmdir 会 ENOTEMPTY */
async function removeCgroupTree(dir, logger) {
  const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const child of children) {
    if (child.isDirectory()) await removeCgroupTree(path.join(dir, child.name), logger)
  }
  return removeCgroupDir(dir, logger)
}

async function writeIfPossible(file, value, logger) {
  try {
    await writeFile(file, String(value))
  } catch (error) {
    // 有些文件在某些内核/容器安全策略下写不进去（比如没开 CONFIG_CFS_BANDWIDTH），
    // 记下来但不阻断——**单项**限额是锦上添花，不是隔离性的必要条件（隔离性靠 namespace）。
    // 注意这只适用于限额文件；`cgroup.procs`（进程归属）不能用这个函数，见 addProcess。
    logger?.warn?.('cgroup 限额写入失败，跳过该项', { file, err: error?.message })
  }
}

/**
 * 把进程加进 cgroup。**这一步失败必须抛，不能像限额那样吞掉。**
 *
 * 限额写不进去顶多少一项约束；而进程根本没进 cgroup，是**所有**限额一起失效——
 * cpu.max/memory.max/pids.max 全都挂在一个空组上，看起来配置得好好的，实际
 * 一条都不生效。这正是这个文件之前的 bug：`addProcess` 定义了但没人调用，
 * 于是 slot 的资源限额从来没有起过作用。要么真的加进去，要么明着失败。
 */
async function addProcessStrict(file, pid) {
  try {
    await writeFile(file, String(pid))
  } catch (error) {
    throw Object.assign(
      new Error(`无法把进程 ${pid} 加入 cgroup（${file}）：${error?.message}——限额不会生效，不能当成功`),
      { code: 'CGROUP_ATTACH_FAILED' },
    )
  }
}

/**
 * cgroup 路径会被拼进 `sh -c` 脚本里（见 executor.js / browser/index.js：
 * 进程必须**在 exec 之前自己**写 `cgroup.procs`，才没有"先跑起来再被搬进去"
 * 的竞态窗口）。路径来自 /proc/mounts 与配置，正常情况下只含这几类字符；
 * 真出现意外字符时宁可启动失败，也不要拼出一条能被 shell 解释的脚本。
 *
 * **逗号必须在白名单里**：cgroup v1 把共挂的 controller 拼进挂载点名字，
 * 真实路径就长 `/sys/fs/cgroup/cpu,cpuacct/...`（还有 `net_cls,net_prio`）。
 * 漏了它，worker 在任何 cgroup v1 节点上都会启动失败：
 *   启动失败：cgroup 路径含有不安全字符，拒绝使用：/sys/fs/cgroup/cpu,cpuacct/...
 * 这不是放松校验——路径最终落在单引号里（`echo $$ > '<path>'`），单引号内
 * 只有单引号本身有特殊含义，逗号完全惰性。这条正则真正要挡住的是 `'`、
 * 空白与换行，它们仍然不在集合里。
 */
const SAFE_CGROUP_PATH = /^[A-Za-z0-9_.,/:@+-]+$/

function assertShellSafe(file) {
  if (!SAFE_CGROUP_PATH.test(file)) {
    throw Object.assign(
      new Error(`cgroup 路径含有不安全字符，拒绝使用：${file}`),
      { code: 'CGROUP_PATH_UNSAFE' },
    )
  }
  return file
}

const V2_CONTROLLERS = ['cpu', 'memory', 'pids']

/**
 * 读一个 cgroup 计数文件。读不到回 null 而不是 0 —— 这两件事必须分得开：
 * 「这台机器没有这个 controller」和「用量是 0」在运维界面上是完全不同的结论，
 * 前者该显示"—"，后者该显示"0"。都返回 0 的话，一个限额根本没生效的节点
 * 看起来就像一个特别空闲的节点。
 */
async function readCounter(file) {
  const raw = await readFile(file, 'utf8').catch(() => null)
  if (raw === null) return null
  const value = Number(String(raw).trim())
  return Number.isFinite(value) ? value : null
}

/** cgroup v2 的 cpu.stat 是 `key value` 多行，取 usage_usec 那一行 */
async function readCpuStatUsec(file) {
  const raw = await readFile(file, 'utf8').catch(() => null)
  if (raw === null) return null
  const match = String(raw).match(/^usage_usec\s+(\d+)/m)
  return match ? Number(match[1]) : null
}

async function readWords(file) {
  const raw = await readFile(file, 'utf8').catch(() => '')
  return raw.split(/\s+/).filter(Boolean)
}

/**
 * 把 slot 上要用的 controller 逐层"下放"下去。
 *
 * cgroup v2 里，一个 cgroup 的子组能不能用 `cpu.max`/`memory.max`/`pids.max`，
 * 取决于**它自己**的 `cgroup.subtree_control` 里有没有写上对应 controller；
 * 没写的话子组里连这几个文件都不存在。这一步之前完全没做，所以即使把进程加进
 * 了 cgroup，限额文件也是写不进去的（EACCES / 文件根本不存在）——
 * 也就是说光修"没人调用 addProcess"还不够，限额照样是零。
 *
 * 两个前提条件：
 *  1. 只能启用 `cgroup.controllers` 里已经有的——父层没下放，这层就没得下放。
 *  2. **一个 cgroup 里还直接挂着进程时，不允许启用 controller**（v2 的
 *     "no internal processes" 规则，写 subtree_control 会 EBUSY）。而容器的根
 *     cgroup 恰恰就是这种情况：容器里所有进程都直接挂在根上。所以遇到 EBUSY 时
 *     先把根上的进程搬进一个专用叶子组，再重试——这也是容器运行时的标准做法。
 */
async function enableSubtreeControllers(dir, logger) {
  const available = await readWords(path.join(dir, 'cgroup.controllers'))
  const want = V2_CONTROLLERS.filter((c) => available.includes(c))
  if (!want.length) {
    logger.warn('这一层没有可下放的 cpu/memory/pids controller，slot 限额会缺项', { dir, available })
    return []
  }
  const subtreeFile = path.join(dir, 'cgroup.subtree_control')
  const enabled = await readWords(subtreeFile)
  const missing = want.filter((c) => !enabled.includes(c))
  if (!missing.length) return want

  const payload = missing.map((c) => `+${c}`).join(' ')
  try {
    await writeFile(subtreeFile, payload)
    return want
  } catch (error) {
    if (error?.code !== 'EBUSY') {
      logger.error('无法下放 cgroup controller，slot 的资源限额不会生效', { dir, payload, err: error?.message })
      return []
    }
  }

  // EBUSY = 这个 cgroup 里还直接挂着进程。搬走再试。
  const moved = await evacuateProcesses(dir, logger)
  try {
    await writeFile(subtreeFile, payload)
    logger.info('腾空该 cgroup 后成功下放 controller', { dir, payload, movedProcesses: moved })
    return want
  } catch (error) {
    logger.error('腾空之后仍然无法下放 controller，slot 的资源限额不会生效', { dir, payload, err: error?.message })
    return []
  }
}

/** 把 dir 上直接挂着的进程全部搬进 `<dir>/ap-main`，好让 dir 能启用 controller */
async function evacuateProcesses(dir, logger) {
  const leaf = path.join(dir, 'ap-main')
  await mkdir(leaf, { recursive: true })
  const pids = await readWords(path.join(dir, 'cgroup.procs'))
  let moved = 0
  for (const pid of pids) {
    // 一次搬一个：内核只接受单个 pid，而且中途有进程退出是正常的（ESRCH），
    // 不该因为一个搬不动就整体放弃
    try {
      await writeFile(path.join(leaf, 'cgroup.procs'), pid)
      moved += 1
    } catch {
      // 已经退出，或是搬不动的内核线程
    }
  }
  logger.info('把根 cgroup 上的进程搬进专用叶子组，以便启用 controller', { from: dir, to: leaf, moved, total: pids.length })
  return moved
}

/** 从 cgroup2 挂载点起，逐层建目录 + 下放 controller，直到 cgroupRoot 本身 */
async function prepareV2Tree(cgroupRoot, logger) {
  const mountRoot = '/sys/fs/cgroup'
  let current = mountRoot
  await enableSubtreeControllers(current, logger)
  for (const segment of path.relative(mountRoot, cgroupRoot).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    await mkdir(current, { recursive: true })
    await enableSubtreeControllers(current, logger)
  }
}

export async function detectCgroupVersion() {
  let mounts = ''
  try {
    mounts = await readFile('/proc/mounts', 'utf8')
  } catch {
    return 'none'
  }
  const lines = mounts.split('\n')
  if (lines.some((l) => l.split(' ')[2] === 'cgroup2' && l.split(' ')[1] === '/sys/fs/cgroup')) return 'v2'
  if (lines.some((l) => l.split(' ')[2] === 'cgroup')) return 'v1'
  return 'none'
}

async function findV1ControllerMount(controller) {
  const mounts = await readFile('/proc/mounts', 'utf8')
  for (const line of mounts.split('\n')) {
    const parts = line.split(' ')
    if (parts[2] !== 'cgroup') continue
    const options = (parts[3] || '').split(',')
    if (options.includes(controller)) return parts[1]
  }
  return null
}

/**
 * 拼出"进程在 exec 之前把自己写进 cgroup"的 shell 片段，每个 procs 文件一行。
 *
 * 为什么是"自己写自己"而不是 worker 事后搬：`spawn()` 返回到 worker 写
 * `cgroup.procs` 之间有一个真实的窗口，这期间子进程完全可能已经 fork 出别的
 * 进程；而 cgroup 归属只在 fork 那一刻继承，事后移动父进程不会把已经存在的
 * 孩子一起带走。让进程在 `exec` 目标命令之前先把自己加进去，之后 fork 出来的
 * 一切自动都在里面，没有窗口。
 *
 * 写失败就 `exit 70` 而不是继续——限额加不上还照跑，就等于回到了"限额看着
 * 配好了、其实一条都没生效"的状态，那是这套机制最初的 bug。
 */
export function buildCgroupJoinScript(procsFiles = []) {
  return procsFiles
    .map((file) => {
      assertShellSafe(file)
      return `echo $$ > '${file}' || { echo "[sandbox] 无法把进程加入 cgroup ${file}，资源限额不会生效，拒绝执行" >&2; exit 70; }`
    })
    .join('\n')
}

/**
 * 建一个统一的 cgroup 管理器。返回的 API 屏蔽 v1/v2 差异——
 * 调用方（slot-pool.js）不需要关心版本，只管 createSlot/destroy。
 *
 * `createSlot()` 返回的对象里，`procsFiles` 是这个 slot 所有 `cgroup.procs` 的路径
 * （v2 一个；v1 每个 controller 一个，少写一个那项限额就对这个进程不生效；
 * 这台机器没有 cgroup 时是空数组）。调用方拿它去拼 `buildCgroupJoinScript`。
 */
export async function createCgroupManager({ config, logger }) {
  const version = await detectCgroupVersion()
  const { cgroupRoot, cpuMaxCores, memoryMaxMb, pidsMax } = config.namespace

  if (version === 'none') {
    logger.error('没有检测到任何 cgroup 挂载，slot 资源限额将被跳过——多用户并发时无法互相隔离资源消耗', {})
    return {
      version,
      async createSlot() {
        return { procsFiles: [], async addProcess() {}, async destroy() {}, async stats() { return null } }
      },
      async destroyAll() {},
    }
  }

  if (version === 'v2') {
    // 逐层建目录并下放 controller。没有这一步，下面的 cpu.max/memory.max/pids.max
    // 在子组里根本不存在，限额写不进去 —— 这才是"限额不生效"的另一半原因。
    await prepareV2Tree(cgroupRoot, logger)

    return {
      version,
      async createSlot(index) {
        const slotPath = path.join(cgroupRoot, `slot-${index}`)
        await mkdir(slotPath, { recursive: true })
        const period = 100000
        const quota = Math.round(cpuMaxCores * period)
        await writeIfPossible(path.join(slotPath, 'cpu.max'), `${quota} ${period}`, logger)
        await writeIfPossible(path.join(slotPath, 'memory.max'), memoryMaxMb * 1024 * 1024, logger)
        // 光设 memory.max 拦不住：超限的页可以被换出去，进程照样活着继续申请。
        // 实测过——memory.max=64MB 的 slot 里 `bytearray(200MB)` 分配成功。
        // 要真的把内存用量压在上限内，必须同时把 swap 配额设成 0。
        await writeIfPossible(path.join(slotPath, 'memory.swap.max'), 0, logger)
        await writeIfPossible(path.join(slotPath, 'pids.max'), pidsMax, logger)
        // 限额到底有没有落地，不能只看"写的时候没报错"——controller 没下放时
        // 这几个文件压根不存在，writeIfPossible 只会留下一条 warn 就过去了
        const effective = await readWords(path.join(slotPath, 'pids.max'))
        if (!effective.length) {
          logger.error('slot 的 cgroup 里没有 pids.max，说明 controller 没有下放成功，资源限额不生效', { index, slotPath })
        }
        const procsFiles = [assertShellSafe(path.join(slotPath, 'cgroup.procs'))]
        return {
          procsFiles,
          async addProcess(pid) {
            await addProcessStrict(procsFiles[0], pid)
          },
          /**
           * 这个 slot 此刻用了多少资源。给管控台回答"这个占用该不该杀"——
           * 光看"跑了 8 分钟"决定不了，跑 8 分钟的 npm install 和跑 8 分钟的
           * 死循环，区别全在这几个数字上。
           */
          async stats() {
            return {
              cpuUsageUsec: await readCpuStatUsec(path.join(slotPath, 'cpu.stat')),
              memoryBytes: await readCounter(path.join(slotPath, 'memory.current')),
              pids: await readCounter(path.join(slotPath, 'pids.current')),
            }
          },
          async destroy() {
            await removeCgroupDir(slotPath, logger)
          },
        }
      },
      async destroyAll() {
        await removeCgroupTree(cgroupRoot, logger)
      },
    }
  }

  // v1：cpu/memory/pids 是三个独立挂载点，slot 的"cgroup"其实是三个目录
  const controllerMounts = {
    // 不需要再单独找 'cpu,cpuacct'：findV1ControllerMount 是按逗号拆挂载选项再
    // 逐个比对的，`/sys/fs/cgroup/cpu,cpuacct` 那行的选项里本来就同时有 cpu 和
    // cpuacct 两个词，查 'cpu' 就能命中。反过来查 'cpu,cpuacct' 这个整体永远
    // 匹配不上（拆完不存在这个词），那是一条看着像兜底、实则从不生效的死代码。
    cpu: await findV1ControllerMount('cpu'),
    memory: await findV1ControllerMount('memory'),
    pids: await findV1ControllerMount('pids'),
  }
  for (const [name, mountPoint] of Object.entries(controllerMounts)) {
    if (!mountPoint) logger.warn(`cgroup v1 里找不到 ${name} controller 的挂载点，该项限额会被跳过`, {})
  }

  return {
    version,
    controllerMounts,
    async createSlot(index) {
      const dirs = {}
      for (const [name, mountPoint] of Object.entries(controllerMounts)) {
        if (!mountPoint) continue
        const dir = path.join(mountPoint, 'ap-sandbox', `slot-${index}`)
        await mkdir(dir, { recursive: true })
        dirs[name] = dir
      }
      if (dirs.cpu) {
        const period = 100000
        const quota = Math.round(cpuMaxCores * period)
        await writeIfPossible(path.join(dirs.cpu, 'cpu.cfs_period_us'), period, logger)
        await writeIfPossible(path.join(dirs.cpu, 'cpu.cfs_quota_us'), quota, logger)
      }
      if (dirs.memory) {
        const bytes = memoryMaxMb * 1024 * 1024
        await writeIfPossible(path.join(dirs.memory, 'memory.limit_in_bytes'), bytes, logger)
        // 与 v2 的 memory.swap.max 同理：不把 memory+swap 一起限住，超限的页换出去就绕过了。
        // memsw 必须**在** limit_in_bytes 之后写，而且需要内核开了 CONFIG_MEMCG_SWAP，
        // 没开的话这个文件不存在，writeIfPossible 记一条 warn 跳过。
        await writeIfPossible(path.join(dirs.memory, 'memory.memsw.limit_in_bytes'), bytes, logger)
      }
      if (dirs.pids) {
        await writeIfPossible(path.join(dirs.pids, 'pids.max'), pidsMax, logger)
      }
      // v1 每个 controller 是独立层级，进程要**逐个**加入才会同时受三种限额约束；
      // 少写一个就是那一项限额对这个进程完全不生效
      const procsFiles = Object.values(dirs).map((dir) => assertShellSafe(path.join(dir, 'cgroup.procs')))
      return {
        procsFiles,
        async addProcess(pid) {
          for (const file of procsFiles) {
            await addProcessStrict(file, pid)
          }
        },
        /** 同 v2，只是文件名与单位不同：cpuacct.usage 是纳秒，这里换算成微秒对齐 */
        async stats() {
          const cpuNs = dirs.cpu ? await readCounter(path.join(dirs.cpu, 'cpuacct.usage')) : null
          return {
            cpuUsageUsec: cpuNs === null ? null : Math.round(cpuNs / 1000),
            memoryBytes: dirs.memory ? await readCounter(path.join(dirs.memory, 'memory.usage_in_bytes')) : null,
            pids: dirs.pids ? await readCounter(path.join(dirs.pids, 'pids.current')) : null,
          }
        },
        async destroy() {
          for (const dir of Object.values(dirs)) {
            await removeCgroupDir(dir, logger)
          }
        },
      }
    },
    async destroyAll() {
      for (const mountPoint of Object.values(controllerMounts)) {
        if (!mountPoint) continue
        await removeCgroupTree(path.join(mountPoint, 'ap-sandbox'), logger)
      }
    },
  }
}
