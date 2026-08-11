/**
 * 沙盒 worker 的 HTTP 面。契约见 PROTOCOL.md。
 *
 * 一条贯穿始终的规则：**流一旦开始就不能再改 HTTP 状态码**。
 * 所以 exec 期间出的错走 NDJSON 的 `error` 帧，不是 5xx —— 否则调用方会看到
 * "HTTP 200 + 半截输出 + 连接莫名断开"，排查起来毫无线索。
 */
import http from 'node:http'
import { lstat, readdir } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'

/**
 * 工作区文件访问一律经这里，**不要在本文件里直接 fs 操作用户给的路径**：
 * 那些接口跑在 worker（root）的宿主视角下，路径校验失守一次就是"以 root 读写整台机器"。
 * 逐段 O_NOFOLLOW + 钉住父目录的理由见 workspace-fs.js 的头注释。
 */
import {
  resolveInWorkspace,
  openConfined,
  openChildDir,
  readFileConfined,
  writeFileConfined,
  mkdirConfined,
  lstatConfined,
  removeConfined,
  PINNED_WALK,
} from './workspace-fs.js'
import { execCommand } from './executor.js'
import { createExecJobs } from './exec-jobs.js'
import { verifyTicket, createTicketGuard, ticketScope } from './manager/ticket.js'
import { parseEgressAllow, screenEgressRequest } from './namespace/netns.js'
import { newId, resolveTraceId } from './trace.js'

// 契约的一部分，也是测试的入口：越界检查的第一道仍然由这里对外暴露
export { resolveInWorkspace }

/**
 * 所有 JSON 响应都带上 `requestId`：用户拿着一条报错来问时，凭它就能在日志里
 * 定位到那一次请求。响应头和响应体都放一份 —— 头方便代理和抓包看到，
 * 体方便调用方原样记进自己的日志。
 */
function sendJson(res, status, payload) {
  const requestId = res.__requestId || ''
  const body = JSON.stringify(requestId ? { ...payload, requestId } : payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...(requestId ? { 'x-request-id': requestId } : {}),
  })
  res.end(body)
}

async function readJsonBody(req, limitBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) {
      const error = new Error(`请求体超过 ${limitBytes} 字节上限`)
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.status = 400
    throw error
  }
}

/** 定长比较，避免用响应时间把 token 猜出来 */
function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided || ''))
  const b = Buffer.from(String(expected || ''))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 租约背后 slot 的 job 属主。
 *
 * 通过接口写进工作区的文件/目录，属主必须是这个 slot 的 job uid：worker 以 root
 * 跑、job 降权到 slot 专属 uid 跑，默认造出来的是 root 属主的东西，job 读得到却
 * 写不了 —— 表现是技能脚本往自己目录里写缓存一律 EACCES，而**读和执行都正常**，
 * 所以特别难查。`slot-pool.js` 的 `createHostWorkspace()` 建工作区时同理。
 *
 * 拿不到 uid 就不 chown（本地开发的退化路径）。
 */
function ownerOf(lease) {
  const { uid, gid } = lease?.slot || {}
  return Number.isInteger(uid) && Number.isInteger(gid) ? { uid, gid } : null
}

/** 常见产物类型。认不出就当二进制 —— 猜错 MIME 比不猜更糟。 */
const MIME_BY_EXT = {
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** 目录项的类型。symlink 单独标出来 —— 它是逃逸面，调用方该知道自己碰到了什么。 */
function entryKind(dirent) {
  if (dirent.isFile()) return 'file'
  if (dirent.isDirectory()) return 'directory'
  if (dirent.isSymbolicLink()) return 'symlink'
  return 'other'
}

/**
 * 列目录。
 *
 * `limit` 不是可选的礼貌，是必须的：`node_modules` 递归下来轻松十万条，
 * 一次性 JSON 化会把 worker 的内存和调用方的上下文一起打爆。到顶就停，
 * 并**明确告诉调用方截断了** —— 静默截断会让它以为自己看到了全部。
 */
async function listWorkspace(baseDir, relBase, { recursive, includeHidden, limit }) {
  const items = []
  let truncated = false

  async function walk(dir, prefix) {
    if (truncated) return
    const dirents = await readdir(dir, { withFileTypes: true })
    // 名字排序，让同一个目录两次列出来的结果稳定；否则调用方没法做 diff
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const dirent of dirents) {
      if (!includeHidden && dirent.name.startsWith('.')) continue
      if (items.length >= limit) { truncated = true; return }

      const kind = entryKind(dirent)
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name
      let size = 0
      let mtimeMs = 0
      // lstat 而不是 stat：符号链接要报它自己，不能跟着链接跑出工作区
      const info = await lstat(path.join(dir, dirent.name)).catch(() => null)
      if (info) { size = info.size; mtimeMs = Math.round(info.mtimeMs) }

      items.push({ path: rel, name: dirent.name, kind, size, mtimeMs })

      // 递归**必须重新打开子目录**（openChildDir 会钉住它并拒绝软链接）：
      // 直接把拼出来的路径递给 readdir，等于在 lstat 与 readdir 之间留一个窗口。
      if (recursive && kind === 'directory') {
        const child = await openChildDir(dir, dirent.name)
        if (!child) continue
        try {
          await walk(child.path, rel)
        } finally {
          await child.close()
        }
      }
    }
  }

  await walk(baseDir, relBase)
  return { items, truncated }
}

/**
 * 浏览器动作分发。契约与桌面端 `/tools/workstation.*` 对齐，
 * 这样 workstation_browser 工具在两端的行为一致。
 */
async function dispatchBrowser({ session, action, payload }) {
  switch (action) {
    case 'open': return session.open(payload)
    case 'navigate': return session.navigate(payload)
    case 'snapshot': {
      const result = await session.snapshot()
      // refs 里带 backendDOMNodeId，对模型没用还占 token —— 只回它需要的
      return { snapshot: result.snapshot, refCount: result.refCount, url: result.url, title: result.title }
    }
    case 'screenshot': return session.screenshot(payload)
    case 'content': return session.content()
    case 'evaluate': return session.evaluate(payload)
    case 'act': return session.act(payload)
    case 'network': return session.listNetwork(payload)
    case 'network.clear': return session.clearNetwork()
    default: throw Object.assign(new Error(`不支持的浏览器动作 ${action}`), { status: 400 })
  }
}

export function createServer({ config, logger: baseLogger, leaseManager, browserManager = null, slotPool, egressPolicy }) {
  // 请求处理里会用带 requestId/traceId 的 child 覆盖它；这一份给不在请求上下文里的代码用
  const logger = baseLogger
  // 票据一次性表。只在接管理端时才有意义，但无条件建着——空 Map 不占什么。
  const ticketGuard = createTicketGuard()
  const execJobs = createExecJobs({ config, logger })

  /**
   * 谁能申请租约。两条路径：
   *   1. manager 签发的短期票据（绑定本节点、60 秒、一次性、带 manager 断言的 username）
   *   2. 旧的静态 SANDBOX_TOKEN —— 迁移期兼容，SANDBOX_ACCEPT_STATIC_TOKEN=false 后失效
   *
   * 顺序上先验票据：迁移期两种都收的时候，票据是我们希望走的那条路，
   * 让它先命中可以避免"其实一直在走旧路径"这种自欺。
   */
  function authorizeLeaseCreate(bearer, staticOk) {
    if (config.manager.enabled && bearer) {
      const result = verifyTicket({
        token: bearer,
        secret: config.manager.ticketSecret,
        nodeId: config.manager.nodeId,
      })
      if (result.ok) {
        // 运维票据不能拿来占槽位。两种用途是互斥的（见 ticket.js 的 ticketScope）：
        // 管控台开一张"看和杀"的票据，不该顺手获得在生产机器上执行代码的能力。
        if (ticketScope(result.payload) !== 'lease') return { ok: false, reason: 'wrong-scope' }
        if (!ticketGuard.claim(result.payload.jti, result.payload.exp)) {
          return { ok: false, reason: 'ticket-replayed' }
        }
        return { ok: true, username: result.payload.username, runId: result.payload.run }
      }
      // 票据验不过时不要立刻拒绝：迁移期里这个 bearer 可能就是旧的静态 token，
      // 它当然不是一张合法票据。落到下面的 staticOk 再判一次。
      if (!staticOk) return { ok: false, reason: result.reason }
    }
    if (staticOk) return { ok: true, username: '', runId: '' }
    return { ok: false, reason: config.manager.enabled ? 'no-valid-ticket' : 'bad-token' }
  }

  /**
   * 谁能调运维接口（看占用、杀占用）。两条路径：
   *   1. manager 用 `scp:"admin"` 签发的短期票据 —— 管控台走这条；
   *   2. 静态 `SANDBOX_TOKEN` —— 运维直连排查走这条。
   *
   * **第 2 条有意不受 `SANDBOX_ACCEPT_STATIC_TOKEN` 约束。** 那个开关回答的是
   * "业务调用方还能不能拿长期凭据换租约"，切 false 之后 SANDBOX_TOKEN 并没有
   * 消失，它继续留在节点上供运维直连用（README 里就是这么写的）。把运维接口
   * 也捆在那个开关上，会导致迁移完成的那一刻运维手里的排查手段一起失效，
   * 而那正是最需要它的时候。
   *
   * 反过来，`scp:"lease"` 的票据（调用方手里的那种）**不能**调这里 ——
   * 否则任何能申请到租约的人都能杀掉别人的租约。
   */
  function authorizeAdmin(bearer) {
    if (config.allowAnonymous) return { ok: true, via: 'anonymous' }
    if (bearer && config.token && tokenMatches(bearer, config.token)) return { ok: true, via: 'static-token' }
    if (config.manager.enabled && bearer) {
      const result = verifyTicket({
        token: bearer,
        secret: config.manager.ticketSecret,
        nodeId: config.manager.nodeId,
      })
      if (!result.ok) return { ok: false, reason: result.reason }
      if (ticketScope(result.payload) !== 'admin') return { ok: false, reason: 'wrong-scope' }
      if (!ticketGuard.claim(result.payload.jti, result.payload.exp)) return { ok: false, reason: 'ticket-replayed' }
      return { ok: true, via: 'ticket', operator: result.payload.username }
    }
    return { ok: false, reason: 'no-credential' }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://worker.local')
    // 每个请求一个 id；traceId 由上游（agent）带过来，带不过来就本地生成一个。
    // 两者都要进日志：前者定位单次请求，后者把 agent / worker / 桥串成一条链。
    res.__requestId = newId('req')
    const traceId = resolveTraceId(req.headers)
    const logger = baseLogger.child ? baseLogger.child({ requestId: res.__requestId, traceId }) : baseLogger

    try {
      // 探针不鉴权，也不泄露任何用户信息
      if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
        return sendJson(res, 200, {
          ok: true,
          slots: leaseManager.slots(),
          leases: leaseManager.count(),
          // 其中在驻留（等用户回来）的有几个。"满了"是因为都在跑还是因为一半
          // 在等人，处置完全相反 —— 探针上就该分得开。
          parkedLeases: leaseManager.parkedCount(),
          uptimeMs: Math.round(process.uptime() * 1000),
          browser: browserManager?.status() || { enabled: false, running: false },
          // 每个 slot 有自己独立的出站白名单（netns 级别的 iptables 规则），
          // 在 slot 初始化时就配好——配不上 slot 池整体起不来（fail fast），
          // 所以这里能看到 slot 列表本身就说明出站锁定已经生效，不需要额外的
          // 运行时布尔值去"报告"一个本该是启动前提的东西。
          namespace: slotPool.status(),
          /**
           * 工作区文件接口有没有把父目录钉住（openat 等价物，需要 /proc）。
           * `false` 意味着逐段 O_NOFOLLOW 仍在、软链接照样穿不过去，但少了防竞态
           * 那一层。Linux 上不该出现 false —— 出现了就是 /proc 没挂，探针上要看得见。
           */
          pinnedWalk: PINNED_WALK,
        })
      }

      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      // 静态 token 是迁移期的兼容路径。SANDBOX_ACCEPT_STATIC_TOKEN=false 之后
      // 它就彻底不成立了，调用方只能靠 manager 签发的票据进来。
      const staticOk = config.allowAnonymous
        || (config.manager.acceptStaticToken && Boolean(config.token) && tokenMatches(bearer, config.token))

      // ---- 运维面：看占用 / 杀占用 ----
      // 与 /v1/leases/* 分开一个前缀，是为了让"这条路径需要运维权限"从 URL 上
      // 就看得出来，而不是埋在某个分支的鉴权判断里。
      if (url.pathname === '/v1/admin/occupancy' || url.pathname.startsWith('/v1/admin/leases')) {
        const auth = authorizeAdmin(bearer)
        if (!auth.ok) {
          logger.warn('运维接口鉴权失败', { reason: auth.reason, path: url.pathname })
          return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        }

        if (req.method === 'GET' && url.pathname === '/v1/admin/occupancy') {
          return sendJson(res, 200, {
            ok: true,
            nodeId: config.manager.nodeId,
            slots: leaseManager.slots(),
            occupancy: await leaseManager.inspect(),
            // 空闲槽位也列出来：只给占用列表的话，"2/4 在用"里空着的是哪两个
            // 看不出来，而 slot 序号正是和节点日志对照的那个键。
            freeSlots: (slotPool.status?.().slots || []).filter((s) => !s.busy).map((s) => s.index),
            egress: slotPool.egressState?.() || undefined,
          })
        }

        const killMatch = url.pathname.match(/^\/v1\/admin\/leases\/([A-Za-z0-9_]+)$/)
        if (req.method === 'DELETE' && killMatch) {
          const leaseId = killMatch[1]
          // 先取一份快照再杀 —— 杀完之后 lease 对象就不在表里了，
          // 而"到底杀掉了谁的什么"恰恰是这条操作最该留下的东西。
          const victim = (await leaseManager.inspect()).find((row) => row.leaseId === leaseId)
          if (!victim) {
            // 已经自己结束了。当成成功而不是 404：运维要的结果是"这个槽位空出来"，
            // 那个结果已经达成了。报错只会让人以为还得再做点什么。
            return sendJson(res, 200, { ok: true, leaseId, killed: false, reason: 'not-found' })
          }
          // 这条日志是这个功能的审计底线：谁杀的、杀了谁的什么、当时在跑几条命令。
          logger.warn('运维强制释放租约', {
            leaseId,
            username: victim.username,
            runId: victim.runId,
            slotIndex: victim.slotIndex,
            running: victim.running,
            ageMs: victim.ageMs,
            via: auth.via,
            operator: auth.operator || '',
          })
          const killed = await leaseManager.release(leaseId, { reason: 'admin-kill' })
          return sendJson(res, 200, { ok: true, leaseId, killed, victim })
        }

        return sendJson(res, 404, { ok: false, error: 'not-found' })
      }

      // ---- 申请租约 ----
      if (req.method === 'POST' && url.pathname === '/v1/leases') {
        const auth = authorizeLeaseCreate(bearer, staticOk)
        if (!auth.ok) {
          // 日志里记真实原因（签名不对 / 过期 / 不是签给本节点的 / 重放），
          // 回给调用方的一律是笼统的 unauthorized —— 区分度会帮攻击者定位问题。
          logger.warn('租约申请鉴权失败', { reason: auth.reason })
          return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        }

        const body = await readJsonBody(req, 64 * 1024)
        // 走票据时 username 以票据载荷为准：它是 manager 断言过的身份，调用方伪造不了。
        // 请求体里带了但对不上就报错，而不是静默以票据为准 —— 静默会把调用方的
        // bug 藏起来，等到会话数据串到别人名下才发现。
        if (auth.username && body.username && body.username !== auth.username) {
          return sendJson(res, 400, { ok: false, error: 'username-mismatch', message: '请求体里的 username 与票据不符' })
        }
        const username = auth.username || body.username

        // 租约级出站放行：调用方只能从节点的准入清单里点，点清单外的直接 400。
        // 先校验再占槽位 —— 反过来的话一个参数写错的调用方会白白占掉一个 slot，
        // 还要等 idle 才收回来。
        const policy = egressPolicy.current()
        const requestedEgress = parseEgressAllow(
          Array.isArray(body.egressAllow) ? body.egressAllow.join(',') : body.egressAllow,
        )
        // 不拦的时候没有"准入清单"这回事：申请的目标本来就已经通了。
        // 这里若照常按清单筛，会出现"申请被 400 拒了，但那个地址其实连得上"
        // 这种自相矛盾的结果，调用方无从理解。
        const screened = policy.enforce
          ? screenEgressRequest(requestedEgress, policy.leaseAllow)
          : { allowed: [], rejected: [] }
        if (screened.rejected.length) {
          return sendJson(res, 400, {
            ok: false,
            error: 'egress-not-permitted',
            rejected: screened.rejected,
            message: policy.source === 'manager'
              ? '申请的出站目标不在准入清单里（由管理端下发，见 manager 的 SANDBOX_EGRESS_LEASE_ALLOW）'
              : '申请的出站目标不在本节点的准入清单里（SANDBOX_EGRESS_LEASE_ALLOW）',
          })
        }

        const lease = await leaseManager.acquire({ runId: body.runId, username, ttlMs: body.ttlMs, logger })
        if (!lease) {
          const slots = leaseManager.slots()
          // 429 是给调用方的信号：换下一个候选节点重试
          return sendJson(res, 429, { ok: false, error: 'no-free-slot', slots })
        }

        if (screened.allowed.length) {
          try {
            lease.egress = await slotPool.allowEgress(lease.slot, screened.allowed)
          } catch (error) {
            // 规则没挂上就把租约还回去：让调用方带着一个"以为开了其实没开"的沙盒
            // 往下走，最后表现是技能莫名其妙连不上，排查方向全错。
            await leaseManager.release(lease.leaseId, { reason: 'egress-failed' })
            logger.error('租约级出站规则挂载失败，已释放租约', { leaseId: lease.leaseId, err: error?.message })
            return sendJson(res, 500, { ok: false, error: 'egress-apply-failed' })
          }
        }
        return sendJson(res, 200, {
          ok: true,
          leaseId: lease.leaseId,
          // 只在这里回这一次。之后所有租约内操作都用它，不再用全局 token。
          leaseToken: lease.leaseToken,
          workerBase: config.advertiseBase,
          expiresAt: lease.expiresAt,
          hardExpiresAt: lease.hardExpiresAt,
          /**
           * 滑动窗口长度，下发给调用方决定保活节奏用。
           *
           * 与心跳间隔同一个道理（见 manager/client.js）：**调用方不要硬编码**。
           * 两边各存一份、其中一边改了配置，现象是租约在调用方眼里"莫名其妙
           * 提前没了"，而两边日志都正常。
           */
          idleTimeoutMs: config.lease.idleTimeoutMs,
          /**
           * 能力声明。滚动发布期间新旧 worker 同时在线，调用方靠它决定走
           * 异步+续传还是老的同步流 —— 比"试一下看会不会 404"可靠得多，
           * 后者会在正常路径上制造一片吓人的错误日志。
           */
          features: { execAsync: true, leaseRenew: true },
          /**
           * 本节点当前拦不拦出站。
           *
           * 调用方申请了 `egressAllow` 却拿回一个空的 `egress` 时，只有这个字段
           * 能解释为什么："因为压根没拦，不需要开"。没有它的话，那种情况看起来
           * 和"申请被静默丢掉了"一模一样。
           */
          egressEnforced: policy.enforce,
          slots: leaseManager.slots(),
        })
      }

      const leaseMatch = url.pathname.match(/^\/v1\/leases\/([A-Za-z0-9_]+)(\/.*)?$/)
      if (leaseMatch) {
        const leaseId = leaseMatch[1]
        // 尾斜杠归一：`/v1/leases/x/` 与 `/v1/leases/x` 是同一个资源。
        // 不归一的话前者会绕过下面所有 `sub === ''` 的分支掉进 404，
        // 而调用方很难看出自己只是多打了一个斜杠。
        const sub = (leaseMatch[2] || '').replace(/\/+$/, '')
        const lease = leaseManager.get(leaseId)

        // 租约内的操作认这个租约自己的凭据。先查在不在，再比凭据：
        // 反过来会让"租约不存在"和"凭据不对"通过状态码被区分出来。
        // 不存在的租约一律 404（本来就没什么可保护的），存在但凭据不对是 401。
        if (lease && !staticOk && !tokenMatches(bearer, lease.leaseToken)) {
          logger.warn('租约操作鉴权失败', { leaseId })
          return sendJson(res, 401, { ok: false, error: 'unauthorized' })
        }

        if (req.method === 'DELETE' && !sub) {
          // 释放是幂等的。租约不存在时直接成功返回，不泄漏"这个 id 存不存在"。
          if (!lease) return sendJson(res, 200, { ok: true, released: false })
          const released = await leaseManager.release(leaseId)
          return sendJson(res, 200, { ok: true, released })
        }
        if (!lease) return sendJson(res, 404, { ok: false, error: 'lease-not-found-or-expired' })

        // ---- 租约自身：查剩余时间 / 续期 ----
        // 光有"活跃即续"还不够：调用方有时**明知**接下来一段时间不会碰沙盒
        // （模型在长思考、或本地在跑不经沙盒的逻辑），那段静默期正好会撞上
        // idle 回收。有了这两个接口它才能提前把命续上，并且能查到自己还剩多久。
        if (req.method === 'GET' && !sub) {
          return sendJson(res, 200, { ok: true, ...leaseManager.describe(lease) })
        }
        if (req.method === 'POST' && sub === '/renew') {
          const body = await readJsonBody(req, 4 * 1024).catch(() => ({}))
          return sendJson(res, 200, { ok: true, ...leaseManager.renew(lease, { extendMs: body.extendMs }) })
        }

        // ---- 驻留 / 接管 ----
        // 一轮结束时，调用方可以选择 park 而不是 DELETE：slot 不销毁，浏览器
        // 登录态、已装依赖、后台进程都留着，下一轮 attach 回来接着用。
        // 见 leases.js 顶部「租约的三种结局」与 docs/SANDBOX-LIFECYCLE.md。
        if (req.method === 'POST' && sub === '/park') {
          const body = await readJsonBody(req, 4 * 1024).catch(() => ({}))
          const result = await leaseManager.park(lease, { reason: body.reason, logger })
          // 被拒绝时**照常回 200**，用 parked=false 表达。调用方的处理是
          // "退回 DELETE"，那是正常分支不是错误；回 4xx 只会让它去重试。
          return sendJson(res, 200, { ok: true, ...result })
        }

        if (req.method === 'POST' && sub === '/attach') {
          const body = await readJsonBody(req, 4 * 1024).catch(() => ({}))
          /**
           * 归属校验。凭据（leaseToken）已经在上面验过了，这一道是防另一件事：
           * 静态 token 模式下 `staticOk` 会跳过凭据校验，那时只剩这一层拦着
           * "拿着全局 token + 一个从日志里捡到的 leaseId 去接管别人的沙盒"。
           * 粘性句柄泄漏的后果是别人的浏览器登录态，值得多这一行。
           */
          if (body.username && lease.username && body.username !== lease.username) {
            logger.warn('接管租约被拒：username 不符', { leaseId, expected: lease.username })
            return sendJson(res, 403, { ok: false, error: 'username-mismatch' })
          }
          /**
           * 没在驻留 = 有另一个 run 正占着它。同一用户允许并发两个 run
           * （MAX_RUNS_PER_USER=2），sessionKey 相同也是可能的 —— 放两个 run
           * 进同一个 BrowserContext，表现是页面莫名其妙被另一边导航走。
           * 让第二个去开自己的租约。
           */
          if (!lease.parked) {
            return sendJson(res, 409, { ok: false, error: 'lease-busy', message: '该租约正被另一个 run 使用' })
          }
          const attached = leaseManager.attach(lease, { runId: body.runId, logger })
          return sendJson(res, 200, {
            ok: true,
            ...attached,
            workerBase: config.advertiseBase,
            idleTimeoutMs: config.lease.idleTimeoutMs,
            // 与创建租约回的那份保持一致：调用方接管之后走的是同一套 exec/文件路径，
            // 能力声明少一个字段就会退回同步流，而它其实是支持续传的。
            features: { execAsync: true, leaseRenew: true },
            slots: leaseManager.slots(),
          })
        }

        if (req.method === 'POST' && sub === '/exec') {
          return handleExec({ req, res, lease, logger })
        }

        // ---- 异步任务：断开 ≠ 放弃 ----
        if (req.method === 'GET' && sub === '/execs') {
          return sendJson(res, 200, { ok: true, execs: execJobs.list(lease) })
        }
        const execMatch = sub.match(/^\/execs\/(exe_[0-9a-f]{16})(\/events)?$/)
        if (execMatch) {
          const job = execJobs.get(lease, execMatch[1])
          // 任务被淘汰了（保留额度有限）与从来没有过，对调用方是同一件事
          if (!job) return sendJson(res, 404, { ok: false, error: 'exec-not-found-or-evicted' })

          if (req.method === 'GET' && execMatch[2]) return streamExecEvents({ req, res, url, job })
          if (req.method === 'GET') {
            return sendJson(res, 200, {
              ok: true,
              execId: job.execId,
              status: job.status,
              startedAt: job.startedAt,
              finishedAt: job.finishedAt || null,
              lastSeq: job.nextSeq - 1,
            })
          }
          if (req.method === 'DELETE') {
            // **这才是"放弃"。** 连接断开什么也不做，只有显式调这里才杀命令。
            return sendJson(res, 200, { ok: true, aborted: execJobs.abort(job) })
          }
        }

        // ---- 浏览器 ----
        const browserMatch = sub.match(/^\/browser\/([a-zA-Z.]+)$/)
        if (req.method === 'POST' && browserMatch) {
          if (!browserManager?.available) {
            return sendJson(res, 501, { ok: false, error: 'browser-not-enabled', message: '本 worker 未启用浏览器能力（BROWSER_ENABLED=0）' })
          }
          const action = browserMatch[1]
          const payload = await readJsonBody(req, 4 * 1024 * 1024)

          // close 是幂等的：没开过浏览器也算成功，免得模型对着一个"关闭失败"反复重试
          if (action === 'close') {
            if (lease.browser) {
              await lease.browser.close()
              lease.browser = null
            }
            return sendJson(res, 200, { ok: true, closed: true })
          }

          if (!lease.browser) {
            // cookies 在这里进入 worker —— 这是整套设计里凭据唯一一次离开 agent service，
            // 原因是浏览器自动化本质上就需要浏览器**自己**持有登录态，代发请求替代不了。
            // 约束：只进 BrowserContext 的内存、不落盘、随租约销毁、日志只记条数。
            lease.browser = await browserManager.createSession({
              leaseId: lease.leaseId,
              username: lease.username,
              cookies: Array.isArray(payload.cookies) ? payload.cookies : [],
              userAgent: payload.userAgent || '',
              slot: lease.slot,
            })
          }

          try {
            const result = await dispatchBrowser({ session: lease.browser, action, payload })
            return sendJson(res, 200, { ok: true, action, ...result })
          } catch (error) {
            // 浏览器动作失败是常态（ref 失效、元素找不到），要把**真实原因**回给模型，
            // 它据此改策略；笼统的 500 只会让它盲目重试
            logger.warn('浏览器动作失败', { leaseId, username: lease.username, action, err: error?.message })
            return sendJson(res, 200, { ok: false, action, error: error?.message || String(error) })
          }
        }

        if (req.method === 'POST' && sub === '/files') {
          const body = await readJsonBody(req, config.files.maxBytes * 2)
          const content = Buffer.from(String(body.contentBase64 || ''), 'base64')
          if (content.length > config.files.maxBytes) {
            return sendJson(res, 413, { ok: false, error: 'file-too-large', maxBytes: config.files.maxBytes })
          }
          await writeFileConfined(lease.workspace.rootDir, body.path, content, ownerOf(lease))
          logger.info('文件写入工作区', { leaseId, username: lease.username, bytes: content.length })
          return sendJson(res, 200, { ok: true, path: body.path, bytes: content.length })
        }
        if (req.method === 'GET' && sub === '/files') {
          const rel = url.searchParams.get('path')
          const result = await readFileConfined(lease.workspace.rootDir, rel, { maxBytes: config.files.maxBytes })
          if (!result.ok) {
            if (result.error === 'file-too-large') {
              return sendJson(res, 413, { ...result, maxBytes: config.files.maxBytes })
            }
            return sendJson(res, 404, result)
          }
          return sendJson(res, 200, {
            ok: true,
            path: rel,
            bytes: result.bytes,
            contentBase64: result.content.toString('base64'),
          })
        }

        // ---- 工作区管理 ----
        // 从前只有单文件读写，"命令产出了什么"只能靠 `ls` 的文本输出去猜。
        // 这几个接口回结构化结果，调用方（和模型）不用再解析 ls。

        if (req.method === 'GET' && sub === '/files/list') {
          const rel = url.searchParams.get('path') || '.'
          const dir = await openConfined(lease.workspace.rootDir, rel, { kind: 'dir' })
          if (!dir) return sendJson(res, 404, { ok: false, error: 'path-not-found' })
          try {
            const info = await dir.handle.stat()
            if (!info.isDirectory()) return sendJson(res, 400, { ok: false, error: 'not-a-directory' })

            // 列出来的路径是**相对工作区根**的，所以要把请求的那一段当前缀带上；
            // `.` 表示根本身，前缀为空
            const { items, truncated } = await listWorkspace(dir.path, rel === '.' ? '' : rel.replace(/^\/+|\/+$/g, ''), {
              recursive: url.searchParams.get('recursive') === '1' || url.searchParams.get('recursive') === 'true',
              includeHidden: url.searchParams.get('includeHidden') === '1' || url.searchParams.get('includeHidden') === 'true',
              limit: config.files.maxListEntries,
            })
            return sendJson(res, 200, { ok: true, root: rel, count: items.length, truncated, items })
          } finally {
            await dir.close()
          }
        }

        if (req.method === 'GET' && sub === '/files/stat') {
          const rel = url.searchParams.get('path')
          const info = await lstatConfined(lease.workspace.rootDir, rel)
          if (!info) return sendJson(res, 404, { ok: false, error: 'path-not-found' })
          return sendJson(res, 200, {
            ok: true,
            path: rel,
            kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other',
            size: info.size,
            mtimeMs: Math.round(info.mtimeMs),
          })
        }

        /**
         * 裸流下载。与 `GET /files` 的差别不只是省掉 base64 的 33%：
         * 那条路要把整个文件读进内存再 JSON 化，一份 30 MB 的产物在 worker 里
         * 会变成三份（Buffer + base64 字符串 + JSON 串）。这条是流式的。
         */
        if (req.method === 'GET' && sub === '/files/raw') {
          const rel = url.searchParams.get('path')
          const ref = await openConfined(lease.workspace.rootDir, rel, { kind: 'file' })
          if (!ref) return sendJson(res, 404, { ok: false, error: 'file-not-found' })
          try {
            const info = await ref.handle.stat()
            if (!info.isFile()) return sendJson(res, 404, { ok: false, error: 'file-not-found' })
            if (info.size > config.files.maxBytes) {
              return sendJson(res, 413, { ok: false, error: 'file-too-large', bytes: info.size, maxBytes: config.files.maxBytes })
            }
            res.writeHead(200, {
              'Content-Type': MIME_BY_EXT[path.extname(rel).toLowerCase()] || 'application/octet-stream',
              'Content-Length': info.size,
              // 文件名只用 basename 且做 URL 编码：它来自用户，不能直接进响应头
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(rel))}`,
            })
            // 从已经打开的那个 fd 上开流，不再按路径开第二次 ——
            // 校验过的 inode 和真正读的 inode 必须是同一个
            await pipeline(ref.handle.createReadStream({ autoClose: false }), res)
            return undefined
          } finally {
            await ref.close()
          }
        }

        if (req.method === 'POST' && sub === '/files/mkdir') {
          const body = await readJsonBody(req, 8 * 1024)
          await mkdirConfined(lease.workspace.rootDir, body.path, ownerOf(lease))
          return sendJson(res, 200, { ok: true, path: body.path, created: true })
        }

        if (req.method === 'DELETE' && sub === '/files') {
          const rel = url.searchParams.get('path')
          // 删工作区根目录会把 slot 的挂载点掏空，之后这个租约的一切操作都会报
          // 莫名其妙的 ENOENT。要"全清"请释放租约 —— 那条路会把整个 slot 销毁重建。
          if (resolveInWorkspace(lease.workspace.rootDir, rel) === lease.workspace.rootDir) {
            return sendJson(res, 400, { ok: false, error: 'cannot-delete-workspace-root' })
          }
          const recursive = url.searchParams.get('recursive') === '1' || url.searchParams.get('recursive') === 'true'
          try {
            const { deleted } = await removeConfined(lease.workspace.rootDir, rel, { recursive })
            return sendJson(res, 200, { ok: true, deleted })
          } catch (error) {
            // 要显式开递归。默认递归的话一个手误就能把整棵目录删掉，
            // 而工作区里可能是命令跑了十分钟的产物。
            if (error?.code === 'DIR_NEEDS_RECURSIVE') {
              return sendJson(res, 400, { ok: false, error: 'directory-needs-recursive' })
            }
            throw error
          }
        }

        /**
         * 批量写。一次 run 里往工作区铺二十个小文件是常态，
         * 二十个来回的延迟比传输本身还贵。
         */
        if (req.method === 'POST' && sub === '/files/batch') {
          const body = await readJsonBody(req, config.files.maxBytes * 2)
          const files = Array.isArray(body.files) ? body.files : []
          if (!files.length) return sendJson(res, 400, { ok: false, error: 'files 不能为空' })
          if (files.length > config.files.maxBatch) {
            return sendJson(res, 400, { ok: false, error: 'too-many-files', maxBatch: config.files.maxBatch })
          }

          // **先全部校验再落盘**：中途失败的话已经写下去的收不回来，
          // 调用方拿到一个"部分成功"的工作区，比整体失败难排查得多。
          // 这里只做得了词法那一道（越界、体积）；软链接要等真正打开时内核才说得准，
          // 那一道在 writeFileConfined 里。
          const planned = []
          let total = 0
          for (const item of files) {
            resolveInWorkspace(lease.workspace.rootDir, item.path)
            const content = Buffer.from(String(item.contentBase64 || ''), 'base64')
            total += content.length
            if (content.length > config.files.maxBytes || total > config.files.maxBytes) {
              return sendJson(res, 413, { ok: false, error: 'file-too-large', maxBytes: config.files.maxBytes })
            }
            planned.push({ rel: item.path, content })
          }

          const owner = ownerOf(lease)
          const written = []
          for (const item of planned) {
            await writeFileConfined(lease.workspace.rootDir, item.rel, item.content, owner)
            written.push({ path: item.rel, bytes: item.content.length })
          }
          logger.info('批量写入工作区', { leaseId, username: lease.username, count: written.length, bytes: total })
          return sendJson(res, 200, { ok: true, count: written.length, files: written })
        }

        /** 批量读。同样是为了省来回，语义上等价于挨个 GET /files。 */
        if (req.method === 'POST' && sub === '/files/read') {
          const body = await readJsonBody(req, 64 * 1024)
          const paths = Array.isArray(body.paths) ? body.paths : []
          if (!paths.length) return sendJson(res, 400, { ok: false, error: 'paths 不能为空' })
          if (paths.length > config.files.maxBatch) {
            return sendJson(res, 400, { ok: false, error: 'too-many-files', maxBatch: config.files.maxBatch })
          }

          const files = []
          let total = 0
          for (const rel of paths) {
            // 越界与软链接照旧抛（整批失败）：那不是"这个文件恰好没有"，是调用方在
            // 做不该做的事。找不到 / 太大才逐条报 —— 批量读常用来"把这几个可能存在的
            // 产物取回来"，缺一个就全军覆没会逼调用方退回逐个读。
            const ref = await openConfined(lease.workspace.rootDir, rel, { kind: 'file' })
            if (!ref) {
              files.push({ path: rel, ok: false, error: 'file-not-found' })
              continue
            }
            try {
              const info = await ref.handle.stat()
              if (!info.isFile()) {
                files.push({ path: rel, ok: false, error: 'file-not-found' })
                continue
              }
              total += info.size
              if (info.size > config.files.maxBytes || total > config.files.maxBytes) {
                files.push({ path: rel, ok: false, error: 'file-too-large', bytes: info.size })
                continue
              }
              const content = await ref.handle.readFile()
              files.push({ path: rel, ok: true, bytes: content.length, contentBase64: content.toString('base64') })
            } finally {
              await ref.close()
            }
          }
          return sendJson(res, 200, { ok: true, count: files.length, files })
        }
      }

      return sendJson(res, 404, { ok: false, error: 'not-found', path: url.pathname })
    } catch (error) {
      const status = error?.status || 500
      if (status >= 500) logger.error('请求处理失败', { path: url.pathname, err: error?.message })
      else logger.warn('请求被拒', { path: url.pathname, status, err: error?.message })
      if (!res.headersSent) sendJson(res, status, { ok: false, error: error?.message || 'internal' })
      else res.end()
    }
  })

  async function handleExec({ req, res, lease, logger: reqLogger = logger }) {
    let body
    try {
      body = await readJsonBody(req, 1024 * 1024)
    } catch (error) {
      return sendJson(res, error?.status || 400, { ok: false, error: error.message })
    }
    const command = String(body.command || '')
    if (!command.trim()) return sendJson(res, 400, { ok: false, error: 'command 不能为空' })

    /** 同步与异步唯一的差别就是帧往哪儿走、谁来决定命令的生死 */
    const runCommand = ({ onFrame, signal }) => execCommand({
      config,
      logger,
      // job 视角的路径：slot 私有 mount namespace 里的挂载点，
      // 与 worker 自己看到的 host 路径不同（见 leases.js 顶部注释）
      workspace: lease.workspace.guest,
      command,
      cwd: body.cwd,
      env: body.env,
      timeoutMs: body.timeoutMs,
      signal,
      onFrame,
      slot: lease.slot,
    })

    if (body.async) {
      // 立刻回句柄，命令在后台跑。之后靠 `/execs/{execId}/events` 取输出，
      // 断线了带上 fromSeq 回来接着取。
      const job = execJobs.start(lease, runCommand)
      reqLogger.info('异步命令已启动', { leaseId: lease.leaseId, username: lease.username, execId: job.execId })
      return sendJson(res, 200, { ok: true, execId: job.execId, startedAt: job.startedAt })
    }

    const controller = new AbortController()
    lease.running.add(controller)
    lease.execCount += 1

    // 同步模式下客户端断开就把命令杀掉 —— 调用方本来就在等这条响应，
    // 连接没了就是没人要结果了。**要"断开不算放弃"请用 async 模式**：
    // 那条路径下只有显式 DELETE /execs/{execId} 才杀。
    const onClientClose = () => controller.abort()
    req.on('close', onClientClose)

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    })

    const write = (frame) => {
      if (res.writableEnded) return
      res.write(`${JSON.stringify(frame)}\n`)
    }

    const startedAt = Date.now()
    try {
      const result = await runCommand({ onFrame: write, signal: controller.signal })

      if (result.timedOut) {
        write({ type: 'error', code: 'TIMEOUT', message: `命令超过时间上限被中止（${config.exec.defaultTimeoutMs}ms 档）` })
      }
      write({
        type: 'exit',
        exitCode: result.exitCode,
        signal: result.signal,
        truncated: result.truncated,
        // 被杀的命令 exitCode 是 null，光凭它调用方分不出"被杀"和"正常跑完没输出"。
        // signal 一直在发；这两个补上原因，省得调用方还要去猜是超时还是中止。
        timedOut: Boolean(result.timedOut),
        aborted: Boolean(result.aborted),
        durationMs: result.durationMs,
      })
      // 命令全文与输出都不记，只记形状（见 logger.js 的说明）
      reqLogger.info('命令执行完成', {
        leaseId: lease.leaseId, username: lease.username, exitCode: result.exitCode,
        durationMs: result.durationMs, outputBytes: result.outputBytes,
        truncated: result.truncated, timedOut: result.timedOut,
      })
    } catch (error) {
      write({ type: 'error', code: error?.code || 'EXEC_FAILED', message: error?.message || String(error) })
      write({ type: 'exit', exitCode: null, signal: null, truncated: false, durationMs: Date.now() - startedAt })
      reqLogger.warn('命令执行失败', { leaseId: lease.leaseId, username: lease.username, code: error?.code, err: error?.message })
    } finally {
      req.off('close', onClientClose)
      lease.running.delete(controller)
      res.end()
    }
  }

  /**
   * 异步任务的事件流。可以断、可以重连、可以接着上次的位置继续。
   *
   * 仍然是 NDJSON 而不是 SSE：调用方是服务端进程不是浏览器 EventSource，
   * `text/event-stream` 那套分帧在这里只是额外的解析负担，而"续传"靠的是
   * 帧里的 `seq`，与传输格式无关。`Last-Event-ID` 请求头照样认，
   * 这样将来真要挂个浏览器上去也不用改协议。
   */
  function streamExecEvents({ req, res, url, job }) {
    const raw = url.searchParams.get('fromSeq') ?? req.headers['last-event-id']
    const fromSeq = Math.max(0, Number(raw) || 0)

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    })

    let unsubscribe = () => {}
    let heartbeat = null
    const finish = () => {
      unsubscribe()
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
      if (!res.writableEnded) res.end()
    }

    // **断开只是取消订阅，不动命令。** 这正是异步模式存在的理由。
    req.on('close', () => {
      unsubscribe()
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = null
    })

    const write = (frame) => {
      if (res.writableEnded) return
      res.write(`${JSON.stringify(frame)}\n`)
      // 终止帧之后这条流没有别的可说了
      if (frame.type === 'exit') finish()
    }

    // subscribe 会先把 fromSeq 之后的历史同步补完 —— 任务已经结束的话，
    // 补历史的过程中就会写出 exit 帧并把流关掉。
    unsubscribe = execJobs.subscribe(job, fromSeq, write)
    if (res.writableEnded) return undefined

    // 心跳：让调用方能区分"命令在安静地跑"和"连接半开了"。
    // 心跳帧不进缓冲区、不占 seq —— 它是传输层的事，不是任务的输出。
    const heartbeatMs = Math.min(Math.max(Number(url.searchParams.get('heartbeatMs')) || 15000, 1000), 60000)
    heartbeat = setInterval(() => {
      if (res.writableEnded) return finish()
      res.write(`${JSON.stringify({ type: 'heartbeat', at: Date.now() })}\n`)
    }, heartbeatMs)
    heartbeat.unref?.()
    return undefined
  }

  return {
    server,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', reject)
          resolve(server.address())
        })
      })
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
