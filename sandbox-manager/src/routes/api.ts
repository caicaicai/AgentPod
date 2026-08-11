import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { apiKeyAuth } from '../middleware/api-key';
import * as config from '../config';
import * as registry from '../lib/registry';
import * as scheduler from '../lib/scheduler';
import * as ticket from '../lib/ticket';
import * as egress from '../lib/egress';
import * as artifacts from '../lib/artifacts';

function ok(reply: FastifyReply, data: Record<string, unknown> = {}) {
  return reply.send({ ok: true, ...data });
}

function fail(reply: FastifyReply, status: number, error: string, message?: string) {
  return reply.code(status).send({ ok: false, error, message: message || error });
}

export default async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', apiKeyAuth);

  // ── POST /api/v1/sandbox/nodes/register ──────────────────────────────
  app.post('/api/v1/sandbox/nodes/register', async (request, reply) => {
    const body = request.body as any;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'invalid-body', '请求体必须是 JSON 对象');
    }
    if (!config.validNodeId(body.nodeId)) {
      return fail(reply, 400, 'invalid-node-id',
        'nodeId 必填，且只能包含字母、数字、点、下划线、连字符');
    }
    if (typeof body.base !== 'string' || !body.base) {
      return fail(reply, 400, 'invalid-base', 'base 必填：调用方要靠它直连本节点');
    }
    if (!/^https?:\/\/[^\s]+$/.test(body.base)) {
      return fail(reply, 400, 'invalid-base',
        'base 必须是 http:// 或 https:// 开头的绝对地址');
    }

    const capacity = body.capacity || {};
    const slotsTotal = Number(capacity.slots) || 0;
    if (slotsTotal <= 0) {
      return fail(reply, 400, 'invalid-capacity', 'capacity.slots 必须大于 0');
    }

    const node: registry.NodeRecord = {
      nodeId: body.nodeId,
      base: body.base,
      pool: body.pool || 'default',
      labels: body.labels || {},
      caps: body.caps || {},
      version: body.version,
      capacity: { slots: slotsTotal },
      ticketSecretFp:
        typeof body.ticketSecretFp === 'string'
          ? body.ticketSecretFp.substring(0, 32)
          : undefined,
      slots: { used: slotsTotal, total: slotsTotal },
      egress: typeof body.egress === 'object' ? body.egress : undefined,
      healthy: true,
      draining: false,
      registeredAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };

    const [ok_, err] = await registry.put(node);
    if (!ok_) {
      request.log.error({ nodeId: node.nodeId, err }, '节点注册失败');
      return fail(reply, 503, 'registry-unavailable', err);
    }

    request.log.info(
      {
        nodeId: node.nodeId,
        pool: node.pool,
        slots: slotsTotal,
        version: node.version,
        secretFp: config.secretFingerprint(config.envStr('SANDBOX_TICKET_SECRET')),
      },
      '节点已注册',
    );

    return ok(reply, {
      nodeId: node.nodeId,
      heartbeatIntervalMs: config.envInt('SANDBOX_HEARTBEAT_MS', 10000),
      staleAfterMs: config.envInt('SANDBOX_STALE_MS', 30000),
      artifactHost: artifacts.enabled() ? artifacts.host() : undefined,
      egress: egress.wire(),
    });
  });

  // ── POST /api/v1/sandbox/nodes/heartbeat ─────────────────────────────
  app.post('/api/v1/sandbox/nodes/heartbeat', async (request, reply) => {
    const body = request.body as any;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'invalid-body', '请求体必须是 JSON 对象');
    }
    if (!config.validNodeId(body.nodeId)) {
      return fail(reply, 400, 'invalid-node-id', 'nodeId 必填');
    }

    const prev = await registry.get(body.nodeId);
    if (!prev) {
      return fail(reply, 409, 'not-registered',
        '该节点不在注册表里（可能心跳中断过），请重新调用 /nodes/register');
    }

    const slots = body.slots || {};
    const total =
      Number(slots.total) || (prev.capacity && prev.capacity.slots) || 0;
    let used = Number(slots.used) || 0;
    if (used < 0) used = 0;
    if (used > total) used = total;

    const node: registry.NodeRecord = {
      nodeId: prev.nodeId,
      base: prev.base,
      pool: prev.pool,
      labels: prev.labels,
      caps: body.caps || prev.caps,
      version: body.version || prev.version,
      capacity: prev.capacity,
      registeredAtMs: prev.registeredAtMs,
      ticketSecretFp:
        typeof body.ticketSecretFp === 'string'
          ? body.ticketSecretFp.substring(0, 32)
          : prev.ticketSecretFp,
      slots: { used, total },
      leases: Number(body.leases) || 0,
      leaseUsers:
        typeof body.leaseUsers === 'object' ? body.leaseUsers : undefined,
      healthy: body.healthy !== false,
      draining: body.draining === true,
      browser: body.browser,
      egress: typeof body.egress === 'object' ? body.egress : undefined,
      updatedAtMs: Date.now(),
    };

    const [ok_, err] = await registry.put(node);
    if (!ok_) {
      request.log.error({ nodeId: node.nodeId, err }, '心跳写入失败');
      return fail(reply, 503, 'registry-unavailable', err);
    }

    return ok(reply, {
      nodeId: node.nodeId,
      heartbeatIntervalMs: config.envInt('SANDBOX_HEARTBEAT_MS', 10000),
      staleAfterMs: config.envInt('SANDBOX_STALE_MS', 30000),
      artifactHost: artifacts.enabled() ? artifacts.host() : undefined,
      egress: egress.wire(),
    });
  });

  // ── POST /api/v1/sandbox/nodes/deregister ────────────────────────────
  app.post('/api/v1/sandbox/nodes/deregister', async (request, reply) => {
    const body = request.body as any;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'invalid-body', '请求体必须是 JSON 对象');
    }
    if (!config.validNodeId(body.nodeId)) {
      return fail(reply, 400, 'invalid-node-id', 'nodeId 必填');
    }

    const [ok_, err] = await registry.remove(body.nodeId);
    if (!ok_) {
      return fail(reply, 503, 'registry-unavailable', err);
    }

    request.log.info({ nodeId: body.nodeId }, '节点已注销');
    return ok(reply, { nodeId: body.nodeId });
  });

  // ── GET /api/v1/sandbox/nodes ────────────────────────────────────────
  app.get('/api/v1/sandbox/nodes', async (request, reply) => {
    const [nodes, err] = await registry.list();
    if (err) return fail(reply, 503, 'registry-unavailable', err);

    const wantPool = (request.query as any).pool as string | undefined;
    const now = Date.now();

    const out: Record<string, unknown>[] = [];
    const summary = {
      nodes: 0, healthy: 0, draining: 0, slotsUsed: 0, slotsTotal: 0,
    };

    for (const node of nodes!) {
      const pool = node.pool || 'default';
      if (wantPool && wantPool !== pool) continue;

      const slots = node.slots || { used: 0, total: 0 };
      const used = Number(slots.used) || 0;
      const total = Number(slots.total) || 0;
      const [isSchedulable, why] = registry.schedulable(node);

      summary.nodes++;
      if (node.healthy !== false) summary.healthy++;
      if (node.draining) summary.draining++;
      summary.slotsUsed += used;
      summary.slotsTotal += total;

      out.push({
        nodeId: node.nodeId,
        base: node.base,
        pool,
        version: node.version,
        caps: node.caps,
        healthy: node.healthy !== false,
        draining: node.draining === true,
        schedulable: isSchedulable,
        blockedBy: why,
        slots: { used, total },
        leases: node.leases,
        egress: node.egress
          ? {
              mode: node.egress.mode,
              revision: node.egress.revision,
              source: node.egress.source,
              pendingSlots: Number(node.egress.pendingSlots) || 0,
            }
          : undefined,
        ageMs: Math.max(0, now - (node.updatedAtMs || now)),
      });
    }

    out.sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));

    return ok(reply, { generatedAt: now, summary, nodes: out });
  });

  // ── POST /api/v1/sandbox/schedule ────────────────────────────────────
  app.post('/api/v1/sandbox/schedule', async (request, reply) => {
    const body = request.body as any;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'invalid-body', '请求体必须是 JSON 对象');
    }
    if (typeof body.runId !== 'string' || !body.runId) {
      return fail(reply, 400, 'invalid-run-id', 'runId 必填');
    }
    if (typeof body.username !== 'string' || !body.username) {
      return fail(reply, 400, 'invalid-username',
        'username 必填：它会被签进票据，节点据此隔离会话数据');
    }

    let limit = Number(body.limit) || config.envInt('SANDBOX_CANDIDATES', 3);
    if (limit < 1) limit = 1;
    if (limit > 10) limit = 10;

    const perUserLimit = config.envInt('SANDBOX_MAX_LEASES_PER_USER', 0);

    const [picked, err, rejected] = await scheduler.pick({
      pool: body.pool,
      need: body.need,
      limit,
    });

    if (err) {
      request.log.error({ err }, '调度失败：注册表读取异常');
      return fail(reply, 503, 'registry-unavailable', err);
    }

    if (perUserLimit > 0) {
      const held = scheduler.leasesOf(scheduler.getLastNodes(), body.username);
      if (held >= perUserLimit) {
        request.log.warn(
          { username: body.username, held, limit: perUserLimit },
          '单人并发配额已满',
        );
        return fail(reply, 429, 'per-user-quota-exceeded',
          `当前身份已占用 ${held} 个沙盒，达到上限 ${perUserLimit}，请先释放`);
      }
    }

    if (picked!.length === 0) {
      request.log.warn(
        { pool: body.pool || 'default', need: body.need, rejected },
        '没有可调度的节点',
      );
      return fail(reply, 503, 'no-capacity', '沙盒池当前没有空闲槽位');
    }

    const candidates: Record<string, unknown>[] = [];
    for (const entry of picked!) {
      const node = entry.node;
      const [token, signErr] = ticket.issue({
        nodeId: node.nodeId,
        runId: body.runId,
        username: body.username,
      });
      if (!token) {
        request.log.error({ err: signErr }, '票据签发失败');
        return fail(reply, 500, 'ticket-sign-failed', signErr!);
      }
      candidates.push({
        nodeId: node.nodeId,
        base: node.base,
        ticket: token,
        free: entry.free,
      });
    }

    return ok(reply, {
      candidates,
      ticketTtlMs: config.envInt('SANDBOX_TICKET_TTL_MS', 60000),
    });
  });

  // ── POST /api/v1/sandbox/artifacts/upload-url ────────────────────────
  app.post('/api/v1/sandbox/artifacts/upload-url', async (request, reply) => {
    const body = request.body as any;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'invalid-body', '请求体必须是 JSON 对象');
    }
    if (typeof body.fileName !== 'string' || !body.fileName) {
      return fail(reply, 400, 'invalid-file-name', 'fileName 必填');
    }
    if (!artifacts.enabled()) {
      return fail(reply, 501, 'artifacts-not-configured',
        '管理端未配置对象存储（需要 S3_ACCESS_KEY / S3_SECRET_SK / SANDBOX_ARTIFACTS_OSS_BUCKET）');
    }

    const size = Number(body.sizeBytes);
    const maxBytes = artifacts.config().maxBytes;
    if (size && size > maxBytes) {
      return fail(reply, 413, 'artifact-too-large',
        `产物 ${size} 字节，超过上限 ${maxBytes} 字节`);
    }

    const [signed, signErr] = await artifacts.sign(
      body.username, body.runId, body.fileName,
    );
    if (!signed) {
      request.log.error(
        { username: body.username, runId: body.runId, err: signErr },
        '产物地址签发失败',
      );
      return fail(reply, 500, 'presign-failed', signErr!);
    }

    request.log.info(
      {
        username: body.username,
        runId: body.runId,
        keyPrefix: signed.key.replace(/\/[^/]*$/, ''),
      },
      '已签发沙盒产物地址',
    );

    return ok(reply, { ...signed });
  });
}
