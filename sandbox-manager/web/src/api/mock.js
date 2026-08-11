/**
 * 离线假后端：让整个管理台不依赖任何部署就能开发和演示。
 *
 * 有意造出一组**难看的**集群状态，而不是一片健康：满载、运维摘除、节点自己
 * 在停机、心跳掉队、密钥指纹不一致、空池。UI 上真正容易做错的全是这些分支，
 * 铺一屏绿色的假数据等于没测。
 *
 * 只在 `npm run dev` 下被动态引入，不会进生产产物（见 api/client.js）。
 */

const HEARTBEAT_MS = 10000
const STALE_MS = 30000
const MANAGER_FP = 'a1b2c3d4'
const EGRESS_REVISION = '3f9a1c22'

/** 占用样本：覆盖"刚开始/长时间在跑/疑似卡住"三种，好让 UI 的强调分支都被走到。 */
const OCCUPANTS = [
  { username: 'zhangsan', runId: 'run_01HQ8F3K2M', ageMs: 92000, idleMs: 1200, execCount: 4, running: 1, execMs: 41000, outputBytes: 18422, browser: true, cpuSec: 37, memMb: 412, pids: 23, egress: ['oss.xiaocaicai.com:443'] },
  { username: 'lisi', runId: 'run_01HQ8F9P7X', ageMs: 1450000, idleMs: 890000, execCount: 61, running: 1, execMs: 902000, outputBytes: 9911204, browser: false, cpuSec: 1490, memMb: 986, pids: 194 },
  { username: 'wangwu', runId: 'run_01HQ8G2B4T', ageMs: 12000, idleMs: 900, execCount: 1, running: 0, execMs: 0, outputBytes: 0, browser: false, cpuSec: 2, memMb: 68, pids: 7 },
]

function seedNodes() {
  return [
    { nodeId: 'sandbox-worker-0', pool: 'default', base: 'http://10.0.12.31:8080', version: '0.3.1', total: 8, used: 3, leases: 3, browser: true, cgroup: 'v2', healthy: true, fp: MANAGER_FP, ageMs: 1200 },
    { nodeId: 'sandbox-worker-1', pool: 'default', base: 'http://10.0.12.32:8080', version: '0.3.1', total: 8, used: 8, leases: 8, browser: true, cgroup: 'v2', healthy: true, fp: MANAGER_FP, ageMs: 2400 },
    { nodeId: 'sandbox-worker-2', pool: 'default', base: 'http://10.0.12.33:8080', version: '0.3.0', total: 8, used: 1, leases: 1, browser: true, cgroup: 'v1', healthy: true, fp: MANAGER_FP, ageMs: 26000 },
    { nodeId: 'sandbox-worker-3', pool: 'default', base: 'http://10.0.12.34:8080', version: '0.3.1', total: 8, used: 0, leases: 0, browser: true, cgroup: 'v2', healthy: false, fp: MANAGER_FP, ageMs: 3100 },
    // 密钥配错的那台：调度看着正常，但调用方拿票据换租约全 401
    { nodeId: 'sandbox-worker-4', pool: 'default', base: 'http://10.0.12.35:8080', version: '0.3.1', total: 8, used: 2, leases: 2, browser: true, cgroup: 'v2', healthy: true, fp: 'deadbeef', ageMs: 900 },
    // 老版本节点：不上报指纹，应该显示"未上报"而不是判成配错
    { nodeId: 'sandbox-worker-5', pool: 'default', base: 'http://10.0.12.36:8080', version: '0.2.9', total: 4, used: 4, leases: 4, browser: false, cgroup: 'v1', healthy: true, fp: null, ageMs: 5200 },
    { nodeId: 'sandbox-cpu-0', pool: 'cpu-only', base: 'http://10.0.13.11:8080', version: '0.3.1', total: 16, used: 5, leases: 5, browser: false, cgroup: 'v2', healthy: true, fp: MANAGER_FP, ageMs: 800 },
    { nodeId: 'sandbox-cpu-1', pool: 'cpu-only', base: 'http://10.0.13.12:8080', version: '0.3.1', total: 16, used: 11, leases: 11, browser: false, cgroup: 'v2', healthy: true, fp: MANAGER_FP, ageMs: 1500 },
  ]
}

/** 假的沙盒操作结果。形状与真实节点一致，好让渲染分支都被走到。 */
function fakeOp({ op, payload }) {
  if (op === 'exec') {
    const cmd = payload?.command || ''
    const frames = [
      { type: 'stdout', data: `$ ${cmd}\n` },
      { type: 'stdout', data: 'Linux sbx-mock 5.10.0 #1 SMP x86_64 GNU/Linux\nsandbox\n/workspace\n' },
    ]
    // 让"命令失败"这条分支也能在 mock 下看到
    if (/curl|example\.com/.test(cmd)) frames.push({ type: 'stderr', data: '000 ← 已拦截\n' })
    frames.push({ type: 'exit', exitCode: /fail|exit 1/.test(cmd) ? 1 : 0, signal: null, truncated: false, durationMs: 87 })
    return { raw: frames.map((f) => JSON.stringify(f)).join('\n') + '\n' }
  }
  if (op === 'file.write') return { json: { ok: true, path: payload?.path, bytes: 42 } }
  if (op === 'file.read') {
    return { json: { ok: true, path: payload?.path, bytes: 42, contentBase64: btoa('hello from mock sandbox') } }
  }
  if (op === 'browser.snapshot') {
    return { json: { ok: true, refCount: 3, url: payload?.url || 'about:blank', title: 'Mock',
      snapshot: '- document:\n  - heading "示例页面" [ref=e1]\n  - button "提交" [ref=e2]\n  - textbox "关键词" [ref=e3]' } }
  }
  if (op === 'browser.screenshot') {
    // 1×1 透明 PNG：验证图片渲染分支，不用塞一张大图进 bundle
    return { json: { ok: true, sizeBytes: 68, dimensions: { mode: 'viewport', width: 1280, height: 800 },
      contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } }
  }
  if (op === 'browser.network') {
    return { json: { ok: true, count: 2, totalTracked: 2, items: [
      { url: 'https://example.internal/api/a', status: 200, method: 'GET' },
      { url: 'https://example.internal/api/b', status: 404, method: 'POST' },
    ] } }
  }
  return { json: { ok: true, action: op.replace('browser.', ''), url: payload?.url, title: 'Mock 页面' } }
}

export function createMockBackend() {
  let nodes = seedNodes()
  const sandboxSessions = new Map()
  // 一台一开始就被摘除了，好让"摘除态"在首屏就能看到
  const drains = new Map([
    ['sandbox-worker-3', { active: true, by: 'zhangsan', atMs: Date.now() - 600000, reason: '内核升级，等租约跑完再关机' }],
  ])
  let canWrite = true

  // 让负载慢慢晃动，轮询才有东西可看
  setInterval(() => {
    for (const n of nodes) {
      if (!n.healthy) continue
      const delta = Math.round((Math.random() - 0.5) * 2)
      n.used = Math.max(0, Math.min(n.total, n.used + delta))
      n.leases = n.used
    }
  }, 3000)

  function view(n, now) {
    const drain = drains.get(n.nodeId)
    const draining = Boolean(drain?.active)
    const free = Math.max(0, n.total - n.used)

    let schedulable = true
    let blockedBy = null
    if (draining) { schedulable = false; blockedBy = 'draining' }
    else if (!n.healthy) { schedulable = false; blockedBy = 'unhealthy' }
    else if (n.total <= 0) { schedulable = false; blockedBy = 'no-capacity' }
    else if (free <= 0) { schedulable = false; blockedBy = 'full' }

    return {
      nodeId: n.nodeId,
      base: n.base,
      pool: n.pool,
      version: n.version,
      caps: { browser: n.browser, cgroup: n.cgroup, python: true },
      healthy: n.healthy,
      draining,
      drainSource: draining ? 'admin' : undefined,
      drain: draining ? { by: drain.by, atMs: drain.atMs, reason: drain.reason } : undefined,
      schedulable,
      blockedBy,
      slots: { used: n.used, total: n.total, free },
      leases: n.leases,
      ticketSecretFp: n.fp || undefined,
      registeredAtMs: now - 7200000,
      ageMs: n.ageMs,
      stale: n.ageMs > HEARTBEAT_MS * 2,
    }
  }

  function listNodes(pool) {
    const now = Date.now()
    return nodes.filter((n) => !pool || n.pool === pool).map((n) => view(n, now))
  }

  function aggregate(views) {
    const acc = { nodes: 0, healthy: 0, draining: 0, schedulable: 0, stale: 0, slotsUsed: 0, slotsTotal: 0, leases: 0 }
    for (const v of views) {
      acc.nodes++
      if (v.healthy) acc.healthy++
      if (v.draining) acc.draining++
      if (v.schedulable) acc.schedulable++
      if (v.stale) acc.stale++
      acc.slotsUsed += v.slots.used
      acc.slotsTotal += v.slots.total
      acc.leases += v.leases
    }
    return acc
  }

  const routes = {
    'GET /whoami': () => ({
      user: { username: 'zhangsan', fullname: '张三', orgName: '沙盒平台组' },
      canWrite,
      reason: canWrite ? null : '当前账号不在 SANDBOX_CONSOLE_ADMINS 名单里',
      canRunSandbox: canWrite,
      env: 'mock',
    }),

    'GET /nodes': ({ query }) => {
      const views = listNodes(query?.pool)
      const pools = {}
      for (const v of views) (pools[v.pool] ||= []).push(v)
      return {
        generatedAt: Date.now(),
        heartbeatIntervalMs: HEARTBEAT_MS,
        staleAfterMs: STALE_MS,
        summary: aggregate(views),
        pools: Object.entries(pools)
          .map(([pool, list]) => ({ pool, ...aggregate(list) }))
          .sort((a, b) => a.pool.localeCompare(b.pool)),
        nodes: views.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
      }
    },

    'GET /config': () => {
      const mismatched = listNodes()
        .filter((n) => n.ticketSecretFp && n.ticketSecretFp !== MANAGER_FP)
        .map((n) => ({ nodeId: n.nodeId, fingerprint: n.ticketSecretFp }))
      const unknown = listNodes().filter((n) => !n.ticketSecretFp).length
      return {
        generatedAt: Date.now(),
        config: {
          env: 'mock',
          heartbeatIntervalMs: HEARTBEAT_MS,
          staleAfterMs: STALE_MS,
          ticketTtlMs: 60000,
          candidates: 3,
          ticketSecretFp: MANAGER_FP,
          consoleAdmins: canWrite ? 2 : 0,
        },
        checks: [
          { id: 'ticket-secret', ok: true, level: 'error', message: '票据密钥已配置' },
          { id: 'jimdb', ok: true, level: 'error', message: 'JIMDB 可用性' },
          { id: 'stale-vs-heartbeat', ok: true, level: 'error', message: `节点 TTL ${STALE_MS}ms 必须 ≥ 3× 心跳间隔 ${HEARTBEAT_MS}ms，否则节点会因为偶发一次心跳超时就被判死` },
          { id: 'ticket-ttl', ok: true, level: 'warn', message: '票据有效期 60000ms（建议 10s–5min）' },
          { id: 'console-admins', ok: canWrite, level: 'warn', message: canWrite ? '已配置 2 个管理台写权限账号' : '未配置 SANDBOX_CONSOLE_ADMINS：管理台的摘除/注销操作全部禁用' },
          { id: 'secret-match', ok: mismatched.length === 0, level: 'error', message: mismatched.length === 0 ? '所有节点票据密钥一致' : `${mismatched.length} 个节点的票据密钥与 manager 不一致：它们会调度成功但所有租约申请 401` },
          { id: 'egress-mode', ok: true, level: 'warn', message: '沙盒出站拦截已开启，额外常开 1 个目标、租约可申请 1 个' },
          { id: 'egress-rollout', ok: true, level: 'warn', message: `${listNodes().length} 个节点已应用当前出站策略（版本 ${EGRESS_REVISION}），0 个未上报` },
        ],
        egress: {
          mode: 'allowlist',
          revision: EGRESS_REVISION,
          allow: [{ host: 'speed-console.5.xiaocaicai.net', ports: [80, 443] }],
          leaseAllow: [{ host: 'oss.xiaocaicai.com', ports: [443] }],
          nodesApplied: listNodes().length,
          nodesDrifted: [],
          nodesPending: [],
          nodesUnknown: 0,
        },
        secretMismatch: mismatched,
      }
    },

    'POST /simulate': ({ body }) => {
      const pool = body?.pool || 'default'
      const limit = Math.min(10, Math.max(1, Number(body?.limit) || 3))
      const need = body?.need || {}
      const candidates = []
      const rejected = []

      for (const v of listNodes()) {
        if (v.pool !== pool) { rejected.push({ nodeId: v.nodeId, why: 'pool' }); continue }
        if (!v.schedulable) { rejected.push({ nodeId: v.nodeId, why: v.blockedBy }); continue }
        const missing = Object.entries(need).find(([k, want]) => want === true && v.caps[k] !== true)
        if (missing) { rejected.push({ nodeId: v.nodeId, why: `caps:${missing[0]}` }); continue }
        candidates.push({ nodeId: v.nodeId, base: v.base, free: v.slots.free })
      }

      candidates.sort((a, b) => b.free - a.free || Math.random() - 0.5)
      const picked = candidates.slice(0, limit).map((c, i) => ({ rank: i + 1, ...c }))

      const rejectedByReason = {}
      for (const r of rejected) rejectedByReason[r.why] = (rejectedByReason[r.why] || 0) + 1

      return {
        generatedAt: Date.now(),
        request: { pool, need, limit },
        candidates: picked,
        rejected,
        rejectedByReason,
        ticketIssued: false,
      }
    },

    'POST /drain': ({ body }) => {
      if (!canWrite) throw Object.assign(new Error('当前账号不在 SANDBOX_CONSOLE_ADMINS 名单里'), { status: 403 })
      const drained = body.drained !== false
      const present = nodes.some((n) => n.nodeId === body.nodeId)
      drains.set(body.nodeId, { active: drained, by: 'zhangsan', atMs: Date.now(), reason: body.reason })
      return { nodeId: body.nodeId, drained, present, effectiveInMs: 2000 }
    },

    'POST /evict': ({ body }) => {
      if (!canWrite) throw Object.assign(new Error('当前账号不在 SANDBOX_CONSOLE_ADMINS 名单里'), { status: 403 })
      const present = nodes.some((n) => n.nodeId === body.nodeId)
      nodes = nodes.filter((n) => n.nodeId !== body.nodeId)
      return { nodeId: body.nodeId, present, drainMarkKept: true }
    },

    // ── 槽位占用 ──────────────────────────────────────────────────────
    'GET /occupancy': ({ query }) => {
      const node = nodes.find((n) => n.nodeId === query.nodeId)
      if (!node) throw Object.assign(new Error('节点不在注册表里'), { status: 502 })
      // 老版本节点没有这个接口。这条分支要能在 mock 下看到，
      // 否则滚动发布期间那个提示是没人验证过的。
      if (node.version < '0.3.1') {
        throw Object.assign(new Error('该节点还不支持运维接口（版本偏旧，升级后即可）'), { status: 502 })
      }
      const now = Date.now()
      const occupancy = []
      for (let i = 0; i < node.used; i += 1) {
        const seed = OCCUPANTS[i % OCCUPANTS.length]
        occupancy.push({
          slotIndex: i,
          leaseId: `lease_${node.nodeId.slice(-1)}${i}${'a1b2c3d4e5f6'.slice(0, 12)}`,
          username: seed.username,
          runId: seed.runId,
          createdAt: now - seed.ageMs,
          ageMs: seed.ageMs,
          lastUsedAt: now - seed.idleMs,
          idleMs: seed.idleMs,
          expiresAt: now + 600000,
          remainingMs: 600000,
          hardExpiresAt: now + 14000000,
          execCount: seed.execCount,
          running: seed.running,
          browser: seed.browser,
          egress: seed.egress || [],
          execs: Array.from({ length: seed.running }, (_, k) => ({
            execId: `exe_${i}${k}9f2a1c`,
            startedAt: now - seed.execMs,
            durationMs: seed.execMs,
            outputBytes: seed.outputBytes,
          })),
          resources: node.cgroup === 'none' ? null
            : { cpuUsageUsec: seed.cpuSec * 1e6, memoryBytes: seed.memMb * 1024 * 1024, pids: seed.pids },
        })
      }
      const freeSlots = []
      for (let i = node.used; i < node.total; i += 1) freeSlots.push(i)
      return { nodeId: node.nodeId, generatedAt: now, slots: { used: node.used, total: node.total }, freeSlots, occupancy }
    },

    'POST /kill': ({ body }) => {
      if (!canWrite) throw Object.assign(new Error('当前账号不在 SANDBOX_CONSOLE_ADMINS 名单里'), { status: 403 })
      const node = nodes.find((n) => n.nodeId === body.nodeId)
      if (!node) throw Object.assign(new Error('节点不在注册表里'), { status: 502 })
      if (node.used > 0) { node.used -= 1; node.leases -= 1 }
      return { nodeId: body.nodeId, leaseId: body.leaseId, killed: true, victim: { username: 'zhangsan' } }
    },

    // ── 调试沙盒 ──────────────────────────────────────────────────────
    'POST /sandbox/open': ({ body }) => {
      const node = nodes.find((n) => n.nodeId === body.nodeId)
      if (!node) throw Object.assign(new Error('节点不在注册表里'), { status: 502 })
      if (node.used >= node.total) throw Object.assign(new Error('节点当前没有空闲槽位'), { status: 502 })
      node.used += 1
      const sessionId = `mock-${Math.random().toString(36).slice(2, 10)}`
      sandboxSessions.set(sessionId, { nodeId: node.nodeId, leaseId: `lease_${sessionId}` })
      return {
        sessionId,
        leaseId: `lease_${sessionId}`,
        nodeId: node.nodeId,
        base: node.base,
        expiresAt: Date.now() + 900000,
      }
    },

    'POST /sandbox/close': ({ body }) => {
      const s = sandboxSessions.get(body.sessionId)
      if (s) {
        const node = nodes.find((n) => n.nodeId === s.nodeId)
        if (node) node.used = Math.max(0, node.used - 1)
        sandboxSessions.delete(body.sessionId)
      }
      return { released: Boolean(s) }
    },

    'POST /sandbox/call': ({ body }) => {
      const s = sandboxSessions.get(body.sessionId)
      if (!s) throw Object.assign(new Error('会话不存在或已过期'), { status: 404 })
      return { op: body.op, status: 200, durationMs: 40 + Math.round(Math.random() * 200), ...fakeOp(body) }
    },
  }

  return {
    /** dev 面板用：翻转写权限，验证按钮置灰那条分支 */
    toggleWrite() { canWrite = !canWrite; return canWrite },

    async handle(path, { method, body, query }) {
      // 假一点网络延迟，否则加载态永远看不到，写出来的骨架屏没人验过
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 180))
      const handler = routes[`${method} ${path}`]
      if (!handler) throw new Error(`mock 未实现的接口：${method} ${path}`)
      return { ok: true, ...handler({ body, query }) }
    },
  }
}
