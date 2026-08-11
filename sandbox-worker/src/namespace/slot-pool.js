/**
 * Slot 池：本 worker 唯一的隔离实现。
 *
 * 启动时按 `config.slots` 数量把 slot 全部预建好（sentinel + 网络 + cgroup + 工作区），
 * 之后 acquire/release 只是"认领/归还"一个已经建好的 slot，不现建 namespace——
 * 这保持了"零冷启动"的承诺。
 *
 * release() 不是"打扫一下这个 slot"，而是**整个销毁重建**：杀掉 sentinel
 * （内核连带回收该 namespace 内的所有进程、IPC 对象、网络状态）→ 删掉工作区目录
 * → 重新建一套全新的。这样"这个 slot 上一个用户留没留东西"这个问题，
 * 答案在架构层面就是"不可能留"，不需要每次都想清楚"是不是漏清了什么"。
 *
 * 没有"不建 slot 池"这个开关——namespace 隔离是本 worker 唯一的隔离手段，
 * `init()` 建不起来就应该让整个进程启动失败（`bin/check-namespace-caps.sh`
 * 就是用来在这一步失败之前先确认好前提条件的）。
 */
import { mkdir, mkdtemp, rm, chown } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

import { spawnSentinel } from './sentinel.js'
import { ensureBridge, setupSlotNetwork, teardownSlotNetwork, applyLeaseEgress, programSlotEgress } from './netns.js'
import { createCgroupManager } from './cgroup.js'

const GUEST_MOUNT_POINT = '/sandbox-root'

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(Object.assign(new Error(`${cmd} ${args.join(' ')} 失败: ${stderr.trim()}`), { code: 'CMD_FAILED' }))
    })
  })
}

/**
 * 建 host 侧工作区目录并 chown 给这个 slot 的专属 uid/gid。
 *
 * 不 chown 的话，job 降权到 slot uid 后连自己的工作区都写不进去——目录是
 * worker（root）创建的，默认 mode 0755 属主 root，非 root 用户只有读+执行权限，
 * `echo x > file.txt` 会直接 EACCES。namespace 模式下每个 slot 有专属 uid，
 * 这里必须显式 chown，不能指望目录权限"顺便"对了。
 */
async function createHostWorkspace(config, index, uid, gid) {
  await mkdir(config.workRoot, { recursive: true })
  const baseDir = await mkdtemp(path.join(config.workRoot, `slot${index}-`))
  const homeDir = path.join(baseDir, 'home')
  const tmpDir = path.join(baseDir, 'tmp')
  const workDir = path.join(baseDir, 'work')
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(tmpDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
  ])
  await Promise.all([baseDir, homeDir, tmpDir, workDir].map((dir) => chown(dir, uid, gid)))
  return { baseDir, homeDir, tmpDir, workDir }
}

/**
 * 给 slot 挂上私有的 /tmp 与 /dev/shm。
 *
 * mount namespace 是从容器的挂载表**克隆**出来的，不是 chroot —— 除了显式 bind
 * 进去的 /sandbox-root，其余路径看到的都还是同一份文件系统。也就是说 `/tmp`
 * 这个 1777 目录默认在所有 slot 之间共享：A 能往里写、B 能读到，一条现成的
 * 跨 slot 通道，顺带还是个符号链接攻击面。挂上 tmpfs 这条路就直接不存在。
 *
 * **必须排在工作区 bind mount 之后。** 反过来的话，`SANDBOX_WORK_ROOT` 只要在
 * /tmp 底下（测试就是这么配的），bind 的源路径在 slot 里就已经被 tmpfs 盖掉了，
 * `mount --bind` 直接失败、slot 建不起来。反过来则没问题：bind 一旦建立，
 * 它引用的是底层的 dentry，之后再往 /tmp 上盖东西也影响不到它。
 *
 * 挂不上就抛 —— 带着一条共享通道跑起来，比起不来更糟。
 */
async function mountPrivateTmp({ config, sentinelPid }) {
  const { tmpfsSizeMb, shmSizeMb } = config.namespace
  for (const [target, sizeMb] of [['/tmp', tmpfsSizeMb], ['/dev/shm', shmSizeMb]]) {
    await run('nsenter', [
      '--target', String(sentinelPid), '--mount', '--',
      'mount', '-t', 'tmpfs', '-o', `size=${sizeMb}m,mode=1777`, 'tmpfs', target,
    ])
  }
}

/** 建单个 slot 的全部资源：sentinel + 工作区 bind-mount + 私有 /tmp + 网络 + cgroup */
async function bootSlot({ config, logger, index, cgroupManager, policy, persistent }) {
  const uid = config.namespace.jobUidBase + index
  const gid = uid

  const sentinel = await spawnSentinel({ logger })
  const hostWorkspace = await createHostWorkspace(config, index, uid, gid)

  // 把 host 侧真实目录 bind 进这个 slot 私有的 mount namespace——
  // 其他 slot 的 mount namespace 里，这个路径根本不存在，不是"挡住"而是"看不见"。
  await run('nsenter', ['--target', String(sentinel.pid), '--mount', '--', 'mkdir', '-p', GUEST_MOUNT_POINT])
  await run('nsenter', ['--target', String(sentinel.pid), '--mount', '--', 'mount', '--bind', hostWorkspace.baseDir, GUEST_MOUNT_POINT])

  // 顺序敏感：一定在 bind 之后，见 mountPrivateTmp 的注释
  await mountPrivateTmp({ config, sentinelPid: sentinel.pid })

  const net = await setupSlotNetwork({ config, logger, index, sentinelPid: sentinel.pid, policy, persistent })
  const cgroup = await cgroupManager.createSlot(index)

  // sentinel 自己也进这个 slot 的 cgroup。两个目的：
  //   1. 它是这个 slot 里唯一的常驻进程，理应算在这个 slot 的账上；
  //   2. **在建 slot 的时候就把"cgroup.procs 能不能写"验证掉**——写不进去这里
  //      直接抛，`init()` 失败、worker 起不来。否则要等到某次 exec 才发现，
  //      而在那之前 /healthz 会一路显示绿色，看起来限额都配好了。
  if (cgroup.procsFiles.length) {
    await cgroup.addProcess(sentinel.pid)
  } else {
    logger.warn('这个 slot 没有可用的 cgroup，CPU/内存/进程数限额都不会生效', { index })
  }

  return {
    index,
    uid,
    gid,
    sentinel,
    net,
    cgroup,
    // 这个 slot 的规则是按哪一版策略编排的。用它算"还有几个 slot 没跟上"——
    // 正在跑的 slot 是刻意不动的（见 applyPolicy），所以"策略已下发"和
    // "策略已全面生效"是两件事，必须分得开。
    egressSignature: policy?.signature || '',
    hostWorkspace,
    guest: {
      baseDir: GUEST_MOUNT_POINT,
      homeDir: `${GUEST_MOUNT_POINT}/home`,
      tmpDir: `${GUEST_MOUNT_POINT}/tmp`,
      workDir: `${GUEST_MOUNT_POINT}/work`,
    },
  }
}

async function destroySlotResources({ slot, index, logger, browserManager }) {
  // Chromium（如果这个 slot 起过）必须在杀 sentinel **之前**关掉——
  // 否则它变成一个挂在即将消失的 namespace 里、没人管的孤儿进程。
  if (browserManager) {
    await browserManager.closeBrowserForSlot(index).catch((error) => {
      logger.warn('slot 的 Chromium 关闭失败（sentinel 即将销毁，进程会被连带回收）', { index, err: error?.message })
    })
  }
  await slot.sentinel.kill().catch(() => {})
  // cgroup 必须在**杀完 sentinel 之后**删：里面还有活着的进程时 rmdir 一定 EBUSY。
  // 之前这个顺序是反的，只是因为那时候压根没有进程被加进 cgroup，所以看不出来。
  await slot.cgroup.destroy().catch((error) => logger.error('slot cgroup 清理失败', { index, err: error?.message }))
  await teardownSlotNetwork({ index }).catch((error) => logger.warn('slot veth 清理失败（可能已经随 namespace 一起没了）', { index, err: error?.message }))
  await rm(slot.hostWorkspace.baseDir, { recursive: true, force: true }).catch((error) => {
    logger.error('slot 工作区清理失败，磁盘上可能残留用户数据', { index, dir: slot.hostWorkspace.baseDir, err: error?.message })
  })
}

export function createSlotPool({ config, logger, egressPolicy, browserManager = null }) {
  let cgroupManager = null
  const slots = [] // { ...bootSlot 的返回, busy, leaseId }
  /**
   * 管理端下发的、对所有 slot 长期有效的额外放行（目前是对象存储）。
   * **重建 slot 时要重新挂上** —— 它不像租约级放行那样"用完就该消失"。
   */
  const persistentEgress = []

  return {
    async init() {
      logger.info('开始预建 slot 池', { slots: config.slots })
      await ensureBridge({ config, logger })
      cgroupManager = await createCgroupManager({ config, logger })
      logger.info('cgroup 管理器就绪', { version: cgroupManager.version })

      // slot 池建在注册之前，所以这里用的必然是本地 env 那份启动默认值 ——
      // 管理端的下发要等第一次注册响应回来。这不是缺陷而是必需：等管理端答复
      // 才建 slot，等于让"管理端可达"变成节点能不能服务的前提，而整个
      // manager/client.js 都建立在相反的承诺上。默认那份是**拦**，所以这段
      // 窗口期停在安全的一侧。
      const policy = egressPolicy.current()
      for (let index = 0; index < config.slots; index += 1) {
        const slot = await bootSlot({ config, logger, index, cgroupManager, policy, persistent: persistentEgress })
        slots.push({ ...slot, busy: false, leaseId: null })
        logger.info('slot 已就绪', { index, uid: slot.uid, sentinelPid: slot.sentinel.pid, ip: slot.net.ip })
      }
    },

    /**
     * 策略变了之后重新编排各 slot 的出站规则。
     *
     * **正在被租用的 slot 一律不动**，等它释放时随整体重建自然换上新策略。
     * 中途改一个正在跑的 slot 有两个真问题：它自己申请的租约级放行会被冲掉
     * （现象是技能跑到一半突然连不上一个它明明申请过的地址），以及重编程窗口
     * 落在一个有活动进程的 netns 里。租约本来就是分钟级的，等一等的代价远小于
     * 这两样。代价是"已下发"不等于"已全面生效"，所以 pending 要能上报。
     */
    async applyPolicy() {
      const policy = egressPolicy.current()
      let reprogrammed = 0
      let pending = 0
      let failed = 0
      for (const slot of slots) {
        if (slot.egressSignature === policy.signature) continue
        if (slot.busy) { pending += 1; continue }
        try {
          slot.net.egress = await programSlotEgress({
            config, logger, sentinelPid: slot.sentinel.pid, policy, persistent: persistentEgress,
          })
          slot.egressSignature = policy.signature
          reprogrammed += 1
        } catch (error) {
          // 不抛：一个 slot 挂不上规则不该让整个节点停摆。但它保留着**旧**策略，
          // 而旧策略只可能比新的更严或更松 —— 更松的那种（旧=open 新=allowlist）
          // 是真正危险的，所以这条必须是 error 且带上 slot 序号。
          failed += 1
          logger.error('slot 出站规则重编排失败，该 slot 仍在用旧策略', { index: slot.index, err: error?.message })
        }
      }
      return { reprogrammed, pending, failed }
    },

    /** @returns slot 描述符，或 null（没有空闲 slot） */
    acquire(leaseId) {
      const slot = slots.find((s) => !s.busy)
      if (!slot) return null
      slot.busy = true
      slot.leaseId = leaseId
      return slot
    },

    /**
     * 给某个 slot 临时开一组出站目标，只在这一个租约的生命周期内有效。
     *
     * 不需要对应的"收回"：release 会把整个 slot 销毁重建，规则随 netns 一起消失。
     * 这一点是刻意的 —— 有收回路径就有忘了收回的可能。
     */
    async allowEgress(slot, entries) {
      if (!entries?.length) return []
      // 不拦的时候整条链是空的、策略是 ACCEPT，插一条 ACCEPT 没有意义。
      // 直接当作已放行返回 —— 调用方要的是"能连上"，那个前提已经满足了。
      if (!egressPolicy.current().enforce) return entries.map((entry) => ({ ...entry, ips: [] }))
      const applied = await applyLeaseEgress({ logger, sentinelPid: slot.sentinel.pid, entries })
      // warn 而不是 info：出站边界被放宽了，日志里要留下痕迹
      logger.warn('租约期额外开放了出站目标', {
        leaseId: slot.leaseId,
        slotIndex: slot.index,
        targets: applied.map((a) => `${a.host}:${a.ports.join('/')}`),
      })
      return applied
    },

    /**
     * 给**所有** slot 开一组出站目标，并记住它 —— slot 释放后会整体重建，
     * 重建出来的那个必须也带上，否则表现是"用了几次之后产物上传突然连不上"。
     */
    async allowEgressAll(entries) {
      if (!entries?.length) return []
      // 记下来这一步**不受拦不拦影响**：策略随时可能从 open 切回 allowlist，
      // 那时候重编排要按这份清单把对象存储重新放行出来。只有真正动 iptables
      // 的那一步才需要判断。
      for (const entry of entries) {
        if (!persistentEgress.some((e) => e.host === entry.host)) persistentEgress.push(entry)
      }
      if (!egressPolicy.current().enforce) return entries
      for (const slot of slots) {
        await applyLeaseEgress({ logger, sentinelPid: slot.sentinel.pid, entries })
      }
      return entries
    },

    /** 归还并**整体重建** slot——这是"用完不留痕迹"的保证来源，不是靠事后清理列表 */
    async release(index) {
      const slotIndex = slots.findIndex((s) => s.index === index)
      if (slotIndex === -1) return
      const old = slots[slotIndex]

      await destroySlotResources({ slot: old, index, logger, browserManager })
      // 重建出来的是全新的 netns，规则从零开始编排 —— 包括长期放行。
      // 这也是正在跑的 slot 补上新策略的地方（见 applyPolicy）。
      const fresh = await bootSlot({
        config, logger, index, cgroupManager,
        policy: egressPolicy.current(),
        persistent: persistentEgress,
      })
      slots[slotIndex] = { ...fresh, busy: false, leaseId: null }
      logger.info('slot 已回收重建，可供下一个租约使用', { index })
    },

    async shutdown() {
      logger.info('关闭 slot 池', { count: slots.length })
      await Promise.all(slots.map((slot) => destroySlotResources({ slot, index: slot.index, logger, browserManager })))
      await cgroupManager?.destroyAll().catch(() => {})
      slots.length = 0
    },

    /**
     * 出站策略在**本节点**的实际生效情况。给心跳上报与 /healthz 共用。
     *
     * `pendingSlots` 不是可有可无的细节：策略下发后正在跑的 slot 要等释放才换，
     * 所以"管理端改了"和"这台机器上已经全部生效"之间有一段真空。没有这个数字，
     * 那段真空里的行为看起来就是"改了没用"。
     */
    egressState() {
      const policy = egressPolicy.current()
      return {
        ...egressPolicy.describe(),
        pendingSlots: slots.filter((s) => s.egressSignature !== policy.signature).length,
        totalSlots: slots.length,
      }
    },

    status() {
      const policy = egressPolicy.current()
      return {
        cgroupVersion: cgroupManager?.version || 'none',
        // mode=open 表示沙盒可自由出网；mode=allowlist 表示受限出站。
        egress: {
          mode: policy.enforce ? 'allowlist' : 'open',
          source: policy.source,
          revision: policy.revision,
          pendingSlots: slots.filter((s) => s.egressSignature !== policy.signature).length,
          extraAllowed: (slots[0]?.net?.egress?.extra ?? []).map((e) => `${e.host}:${e.ports.join('/')}`),
        },
        slots: slots.map((s) => ({ index: s.index, busy: s.busy, uid: s.uid, ip: s.net.ip })),
      }
    },
  }
}
