import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  sessionAuth,
  validateCredentials,
  signSessionToken,
  getUsers,
} from '../middleware/sso-auth';
import * as config from '../config';
import * as registry from '../lib/registry';
import * as scheduler from '../lib/scheduler';
import * as egressLib from '../lib/egress';
import * as consoleLib from '../lib/console';
import * as debugbox from '../lib/debugbox';
import * as nodeadmin from '../lib/nodeadmin';
import { getStore } from '../lib/store';

function ok(reply: FastifyReply, data: Record<string, unknown> = {}) {
  return reply.send({ ok: true, ...data });
}

function fail(reply: FastifyReply, status: number, error: string, message?: string) {
  return reply.code(status).send({ ok: false, error, message: message || error });
}

export default async function uiRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/v1/sandbox/ui/login ──────────────────────────────────
  // 登录接口不需要认证，独立于受保护路由的作用域
  app.post('/api/v1/sandbox/ui/login', async (request, reply) => {
    const body = request.body as any;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'invalid-body', '请求体必须是 JSON 对象');
    }
    const { username, password } = body;
    if (typeof username !== 'string' || !username) {
      return fail(reply, 400, 'invalid-username', '用户名必填');
    }
    if (typeof password !== 'string' || !password) {
      return fail(reply, 400, 'invalid-password', '密码必填');
    }

    if (getUsers().size === 0) {
      return fail(reply, 503, 'no-users-configured',
        '未配置 CONSOLE_USERS 环境变量，无法登录');
    }

    if (!validateCredentials(username, password)) {
      request.log.warn({ username }, '管理台登录失败');
      return fail(reply, 401, 'invalid-credentials', '用户名或密码错误');
    }

    const { token, expiresAt } = signSessionToken(username);
    request.log.info({ username }, '管理台登录成功');
    return ok(reply, { token, expiresAt, username });
  });

  // 受保护的路由放到子作用域，sessionAuth 只作用于此作用域内的路由
  await app.register(async function protectedUiRoutes(sub: FastifyInstance) {
    sub.addHook('preHandler', sessionAuth);

  // ── GET /api/v1/sandbox/ui/whoami ────────────────────────────────────
  sub.get('/api/v1/sandbox/ui/whoami', async (request, reply) => {
    const user = consoleLib.requireUser(request, reply);
    if (!user) return;

    const [canWriteVal, why] = consoleLib.canWrite(user);

    return ok(reply, {
      user: {
        username: user.username,
        fullname: user.fullname,
        orgName: user.orgName,
      },
      canWrite: canWriteVal,
      reason: why,
      canRunSandbox: canWriteVal && debugbox.enabled(),
      sandboxDisabledReason: !debugbox.enabled()
        ? 'manager 未设置 SANDBOX_CONSOLE_EXEC=1'
        : undefined,
      env: config.envStr('SANDBOX_ENV', 'default'),
    });
  });

  // ── GET /api/v1/sandbox/ui/nodes ─────────────────────────────────────
  sub.get('/api/v1/sandbox/ui/nodes', async (request, reply) => {
    if (!consoleLib.requireUser(request, reply)) return;

    const [nodes, err] = await registry.list();
    if (err) return fail(reply, 503, 'registry-unavailable', err);

    const wantPool = (request.query as any).pool as string | undefined;
    const now = Date.now();
    const heartbeatMs = config.envInt('SANDBOX_HEARTBEAT_MS', 10000);

    const out: (consoleLib.NodeView & { stale: boolean })[] = [];
    const total = {
      nodes: 0, healthy: 0, draining: 0, schedulable: 0, stale: 0,
      slotsUsed: 0, slotsTotal: 0, leases: 0,
    };
    const poolBuckets: Record<string, typeof total & { pool: string }> = {};

    for (const node of nodes!) {
      const pool = node.pool || 'default';
      if (wantPool && wantPool !== pool) continue;

      const [isSchedulable, why] = registry.schedulable(node);
      const view = {
        ...consoleLib.nodeView(node, now, isSchedulable, why),
        stale: false,
      };
      view.stale = view.ageMs > heartbeatMs * 2;

      if (!poolBuckets[pool]) {
        poolBuckets[pool] = {
          pool, nodes: 0, healthy: 0, draining: 0, schedulable: 0, stale: 0,
          slotsUsed: 0, slotsTotal: 0, leases: 0,
        };
      }
      const bucket = poolBuckets[pool];

      for (const acc of [total, bucket]) {
        acc.nodes++;
        if (view.healthy) acc.healthy++;
        if (view.draining) acc.draining++;
        if (view.schedulable) acc.schedulable++;
        if (view.stale) acc.stale++;
        acc.slotsUsed += view.slots.used;
        acc.slotsTotal += view.slots.total;
        acc.leases += view.leases;
      }

      out.push(view);
    }

    out.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    const poolList = Object.values(poolBuckets).sort((a, b) =>
      a.pool.localeCompare(b.pool),
    );

    return ok(reply, {
      generatedAt: now,
      heartbeatIntervalMs: heartbeatMs,
      staleAfterMs: config.envInt('SANDBOX_STALE_MS', 30000),
      summary: total,
      pools: poolList,
      nodes: out,
    });
  });

  // ── GET /api/v1/sandbox/ui/config ────────────────────────────────────
  sub.get('/api/v1/sandbox/ui/config', async (request, reply) => {
    if (!consoleLib.requireUser(request, reply)) return;

    const heartbeatMs = config.envInt('SANDBOX_HEARTBEAT_MS', 10000);
    const staleMs = config.envInt('SANDBOX_STALE_MS', 30000);
    const ticketTtlMs = config.envInt('SANDBOX_TICKET_TTL_MS', 60000);
    const candidates = config.envInt('SANDBOX_CANDIDATES', 3);
    const secret = config.envStr('SANDBOX_TICKET_SECRET');
    const managerFp = config.secretFingerprint(secret);
    const { count: adminCount } = config.envSet('SANDBOX_CONSOLE_ADMINS');

    type Check = { id: string; ok: boolean; level: string; message: string };
    const checks: Check[] = [];
    function check(id: string, isOk: boolean, level: string, message: string) {
      checks.push({ id, ok: isOk, level, message });
    }

    check('ticket-secret', secret !== '', 'error',
      secret !== ''
        ? '票据密钥已配置'
        : 'SANDBOX_TICKET_SECRET 未配置：所有调度都会在签发票据时 500');

    const storeKindVal = config.storeKind();
    const [, storeErr] = getStore();
    check('store', !storeErr, 'error', storeErr || '存储可用性');

    if (storeKindVal === 'memory') {
      check('dev-memory-store', false, 'warn',
        '存储降级为单机内存（SANDBOX_DEV_MEMORY_STORE=1）：数据不跨机器、重启即丢，**仅限本地开发**。生产必须配 REDIS_URL');
    }

    check('stale-vs-heartbeat', staleMs >= heartbeatMs * 3, 'error',
      `节点 TTL ${staleMs}ms 必须 ≥ 3× 心跳间隔 ${heartbeatMs}ms，否则节点会因为偶发一次心跳超时就被判死`);

    check('ticket-ttl', ticketTtlMs >= 10000 && ticketTtlMs <= 300000, 'warn',
      `票据有效期 ${ticketTtlMs}ms（建议 10s–5min：太短会让调用方在网络抖动时换不到租约，太长削弱短期凭据的意义）`);

    check('console-admins', adminCount > 0, 'warn',
      adminCount > 0
        ? `已配置 ${adminCount} 个管理台写权限账号`
        : '未配置 SANDBOX_CONSOLE_ADMINS：管理台的摘除/注销操作全部禁用');

    const [allNodes] = await registry.list();
    const nodesList = allNodes || [];
    const mismatched: { nodeId: string; fingerprint: string }[] = [];
    let unknown = 0;
    for (const node of nodesList) {
      const fp = node.ticketSecretFp;
      if (!fp) {
        unknown++;
      } else if (fp !== managerFp) {
        mismatched.push({ nodeId: node.nodeId, fingerprint: fp });
      }
    }

    check('secret-match', mismatched.length === 0, 'error',
      mismatched.length === 0
        ? `${nodesList.length - unknown - mismatched.length} 个节点的票据密钥与 manager 一致，${unknown} 个未上报`
        : `${mismatched.length} 个节点的票据密钥与 manager 不一致：它们会调度成功但所有租约申请 401`);

    const policyVal = egressLib.policy();

    check('egress-mode', policyVal.mode === 'allowlist', 'warn',
      policyVal.mode === 'allowlist'
        ? `沙盒出站拦截已开启，额外常开 ${policyVal.allow.length} 个目标、租约可申请 ${policyVal.leaseAllow.length} 个`
        : 'SANDBOX_EGRESS_MODE=open：全集群的沙盒出站拦截已关闭。沙盒里跑的是模型生成的任意代码，它拿得到用户登录态 —— 能连出去就能被带走。仅限排障，用完改回 allowlist');

    const drifted: { nodeId: string; revision: string; mode?: string }[] = [];
    const pendingNodes: { nodeId: string; pendingSlots: number }[] = [];
    let egressUnknown = 0;
    for (const node of nodesList) {
      const reported = node.egress;
      if (!reported || !reported.revision) {
        egressUnknown++;
      } else if (reported.revision !== policyVal.revision) {
        drifted.push({
          nodeId: node.nodeId,
          revision: reported.revision,
          mode: reported.mode,
        });
      } else if (reported.pendingSlots && reported.pendingSlots > 0) {
        pendingNodes.push({
          nodeId: node.nodeId,
          pendingSlots: reported.pendingSlots,
        });
      }
    }

    check('egress-rollout', drifted.length === 0, 'warn',
      drifted.length === 0
        ? `${nodesList.length - egressUnknown - drifted.length} 个节点已应用当前出站策略（版本 ${policyVal.revision}），${egressUnknown} 个未上报`
        : `${drifted.length} 个节点还在用旧的出站策略：它们要么心跳没通，要么刚重启还没收到下发`);

    if (pendingNodes.length > 0) {
      check('egress-pending', false, 'warn',
        `${pendingNodes.length} 个节点收到了新策略但还有 slot 没换上 —— 正在被租用的 slot 是刻意不中途改的（会冲掉它自己申请的租约级放行），等租约释放后随重建自然生效`);
    }

    return ok(reply, {
      generatedAt: Date.now(),
      config: {
        env: config.envStr('SANDBOX_ENV', 'default'),
        heartbeatIntervalMs: heartbeatMs,
        staleAfterMs: staleMs,
        ticketTtlMs,
        candidates,
        ticketSecretFp: managerFp,
        consoleAdmins: adminCount,
        storeKind: storeKindVal,
      },
      egress: {
        mode: policyVal.mode,
        revision: policyVal.revision,
        allow: policyVal.allow,
        leaseAllow: policyVal.leaseAllow,
        nodesApplied: nodesList.length - egressUnknown - drifted.length,
        nodesDrifted: drifted,
        nodesPending: pendingNodes,
        nodesUnknown: egressUnknown,
      },
      checks,
      secretMismatch: mismatched,
    });
  });

  // ── POST /api/v1/sandbox/ui/simulate ─────────────────────────────────
  sub.post('/api/v1/sandbox/ui/simulate', async (request, reply) => {
    if (!consoleLib.requireUser(request, reply)) return;

    const body = (request.body as any) || {};
    let limit = Number(body.limit) || config.envInt('SANDBOX_CANDIDATES', 3);
    if (limit < 1) limit = 1;
    if (limit > 10) limit = 10;

    const [picked, err, rejected] = await scheduler.pick({
      pool: body.pool,
      need: body.need,
      limit,
    });
    if (err) return fail(reply, 503, 'registry-unavailable', err);

    const candidates = picked!.map((entry, i) => ({
      rank: i + 1,
      nodeId: entry.node.nodeId,
      base: entry.node.base,
      free: entry.free,
    }));

    const reasons: Record<string, number> = {};
    for (const r of rejected) {
      reasons[r.why] = (reasons[r.why] || 0) + 1;
    }

    return ok(reply, {
      generatedAt: Date.now(),
      request: { pool: body.pool || 'default', need: body.need, limit },
      candidates,
      rejected,
      rejectedByReason: reasons,
      ticketIssued: false,
    });
  });

  // ── POST /api/v1/sandbox/ui/drain ────────────────────────────────────
  sub.post('/api/v1/sandbox/ui/drain', async (request, reply) => {
    const user = consoleLib.requireAdmin(request, reply);
    if (!user) return;

    const body = request.body as any;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'invalid-body', '请求体必须是 JSON 对象');
    }
    if (!config.validNodeId(body.nodeId)) {
      return fail(reply, 400, 'invalid-node-id', 'nodeId 必填');
    }

    const drained = body.drained !== false;
    const existing = await registry.get(body.nodeId);

    const record: registry.DrainMark = {
      active: drained,
      by: user.username,
      atMs: Date.now(),
      reason:
        typeof body.reason === 'string'
          ? body.reason.substring(0, 200)
          : undefined,
    };

    const [ok_, err] = await registry.setDrain(body.nodeId, record);
    if (!ok_) return fail(reply, 503, 'registry-unavailable', err);

    consoleLib.audit(request.log, drained ? 'drain' : 'undrain', user, {
      nodeId: body.nodeId,
      reason: record.reason,
      present: existing !== null,
    });

    return ok(reply, {
      nodeId: body.nodeId,
      drained,
      present: existing !== null,
      effectiveInMs: 2000,
      leases: existing ? Number(existing.leases) || 0 : undefined,
    });
  });

  // ── POST /api/v1/sandbox/ui/evict ────────────────────────────────────
  sub.post('/api/v1/sandbox/ui/evict', async (request, reply) => {
    const user = consoleLib.requireAdmin(request, reply);
    if (!user) return;

    const body = request.body as any;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'invalid-body', '请求体必须是 JSON 对象');
    }
    if (!config.validNodeId(body.nodeId)) {
      return fail(reply, 400, 'invalid-node-id', 'nodeId 必填');
    }

    const existing = await registry.get(body.nodeId);
    const [ok_, err] = await registry.remove(body.nodeId);
    if (!ok_) return fail(reply, 503, 'registry-unavailable', err);

    consoleLib.audit(request.log, 'evict', user, {
      nodeId: body.nodeId,
      present: existing !== null,
    });

    return ok(reply, {
      nodeId: body.nodeId,
      present: existing !== null,
      drainMarkKept: true,
    });
  });

  // ── GET /api/v1/sandbox/ui/occupancy ─────────────────────────────────
  sub.get('/api/v1/sandbox/ui/occupancy', async (request, reply) => {
    const user = consoleLib.requireUser(request, reply);
    if (!user) return;

    const nodeId = (request.query as any).nodeId as string;
    if (!config.validNodeId(nodeId)) {
      return fail(reply, 400, 'invalid-node-id', 'nodeId 必填');
    }

    const [data, err] = await nodeadmin.occupancy(nodeId, user.username);
    if (!data) return fail(reply, 502, 'node-unreachable', err);

    return ok(reply, {
      nodeId,
      generatedAt: Date.now(),
      slots: (data as any).slots,
      freeSlots: (data as any).freeSlots || [],
      occupancy: (data as any).occupancy || [],
    });
  });

  // ── POST /api/v1/sandbox/ui/kill ─────────────────────────────────────
  sub.post('/api/v1/sandbox/ui/kill', async (request, reply) => {
    const user = consoleLib.requireAdmin(request, reply);
    if (!user) return;

    const body = request.body as any;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'invalid-body', '请求体必须是 JSON 对象');
    }
    if (!config.validNodeId(body.nodeId)) {
      return fail(reply, 400, 'invalid-node-id', 'nodeId 必填');
    }
    if (!nodeadmin.validLeaseId(body.leaseId)) {
      return fail(reply, 400, 'invalid-lease-id',
        'leaseId 必填，且只能包含字母、数字、下划线');
    }

    const [result, err] = await nodeadmin.kill(body.nodeId, body.leaseId, user.username);
    if (!result) return fail(reply, 502, 'node-unreachable', err);

    const victim = (result as any).victim || {};
    consoleLib.audit(request.log, 'lease.kill', user, {
      nodeId: body.nodeId,
      leaseId: body.leaseId,
      killed: (result as any).killed === true,
      targetUsername: victim.username,
      runId: victim.runId,
      slotIndex: victim.slotIndex,
      runningExecs: victim.running,
      ageMs: victim.ageMs,
    });

    return ok(reply, {
      nodeId: body.nodeId,
      leaseId: body.leaseId,
      killed: (result as any).killed === true,
      victim,
    });
  });

  // ── POST /api/v1/sandbox/ui/sandbox/open ─────────────────────────────
  sub.post('/api/v1/sandbox/ui/sandbox/open', async (request, reply) => {
    const user = consoleLib.requireAdmin(request, reply);
    if (!user) return;

    if (!debugbox.enabled()) {
      return fail(reply, 403, 'console-exec-disabled',
        '调试沙盒未启用：manager 侧需设置 SANDBOX_CONSOLE_EXEC=1');
    }

    const body = request.body as any;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'invalid-body', '请求体必须是 JSON 对象');
    }
    if (!config.validNodeId(body.nodeId)) {
      return fail(reply, 400, 'invalid-node-id', 'nodeId 必填');
    }

    const [result, err] = await debugbox.open(body.nodeId, user.username);
    if (!result) {
      request.log.warn(
        { operator: user.username, nodeId: body.nodeId, err },
        '[console] 调试沙盒创建失败',
      );
      return fail(reply, 502, 'sandbox-open-failed', err);
    }

    consoleLib.audit(request.log, 'sandbox.open', user, {
      nodeId: body.nodeId,
      leaseId: result.leaseId,
      sessionId: result.sessionId,
    });

    return ok(reply, result);
  });

  // ── POST /api/v1/sandbox/ui/sandbox/call ─────────────────────────────
  sub.post('/api/v1/sandbox/ui/sandbox/call', async (request, reply) => {
    const user = consoleLib.requireAdmin(request, reply);
    if (!user) return;

    if (!debugbox.enabled()) {
      return fail(reply, 403, 'console-exec-disabled',
        '调试沙盒未启用：manager 侧需设置 SANDBOX_CONSOLE_EXEC=1');
    }

    const body = request.body as any;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'invalid-body', '请求体必须是 JSON 对象');
    }

    const [record, loadErr] = await debugbox.load(body.sessionId, user.username);
    if (!record) return fail(reply, 404, 'session-not-found', loadErr);

    if (!debugbox.resolveOp(body.op)) {
      return fail(reply, 400, 'unsupported-op', '不支持的操作：' + body.op);
    }

    const started = Date.now();
    const [res, err] = await debugbox.call(record, body.op, body.payload);
    if (!res) return fail(reply, 502, 'node-unreachable', err);

    await debugbox.touch(record);

    consoleLib.audit(request.log, 'sandbox.call', user, {
      nodeId: record.nodeId,
      leaseId: record.leaseId,
      op: body.op,
      status: res.status,
      durationMs: Date.now() - started,
      bytes: res.body?.length || 0,
    });

    const payload: Record<string, unknown> = {
      op: body.op,
      status: res.status,
      durationMs: Date.now() - started,
    };
    if (typeof res.json === 'object' && res.json !== null) {
      payload.json = res.json;
    } else {
      payload.raw = res.body;
    }

    return ok(reply, payload);
  });

  // ── POST /api/v1/sandbox/ui/sandbox/close ────────────────────────────
  sub.post('/api/v1/sandbox/ui/sandbox/close', async (request, reply) => {
    const user = consoleLib.requireAdmin(request, reply);
    if (!user) return;

    const body = request.body as any;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'invalid-body', '请求体必须是 JSON 对象');
    }

    const [record, err] = await debugbox.load(body.sessionId, user.username);
    if (!record) {
      return ok(reply, { released: false, reason: err });
    }

    const [released, closeErr] = await debugbox.close(record);
    consoleLib.audit(request.log, 'sandbox.close', user, {
      nodeId: record.nodeId,
      leaseId: record.leaseId,
      released,
    });

    return ok(reply, { released: released === true, error: closeErr });
  });

  }); // end protectedUiRoutes
}
