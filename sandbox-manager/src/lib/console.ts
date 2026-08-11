import { FastifyRequest, FastifyReply } from 'fastify';
import { envSet } from '../config';
import { NodeRecord } from './registry';

export interface AuthUser {
  username: string;
  fullname?: string;
  orgName?: string;
}

export function requireUser(request: FastifyRequest, reply: FastifyReply): AuthUser | null {
  const user = request.authUser;
  if (!user || !user.username) {
    reply.code(401).send({ ok: false, error: 'unauthenticated', message: '需要登录' });
    return null;
  }
  return user;
}

export function canWrite(user: AuthUser): [true, null] | [false, string] {
  const { set: admins, count } = envSet('SANDBOX_CONSOLE_ADMINS');
  if (count === 0) {
    return [false, 'manager 未配置 SANDBOX_CONSOLE_ADMINS，写操作已全部禁用'];
  }
  if (!admins.has(user.username)) {
    return [false, '当前账号不在 SANDBOX_CONSOLE_ADMINS 名单里'];
  }
  return [true, null];
}

export function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): AuthUser | null {
  const user = requireUser(request, reply);
  if (!user) return null;

  const [allowed, why] = canWrite(user);
  if (!allowed) {
    reply.code(403).send({ ok: false, error: 'forbidden', message: why });
    return null;
  }
  return user;
}

export function audit(
  log: FastifyRequest['log'],
  action: string,
  user: AuthUser,
  detail: Record<string, unknown> = {},
): void {
  log.info(
    { action, operator: user.username, fullname: user.fullname, ...detail },
    '[console] 管理台操作',
  );
}

export interface NodeView {
  nodeId: string;
  base: string;
  pool: string;
  version?: string;
  caps: Record<string, boolean>;
  healthy: boolean;
  draining: boolean;
  drainSource?: string;
  drain?: { by: string; atMs: number; reason?: string };
  schedulable: boolean;
  blockedBy: string | null;
  slots: { used: number; total: number; free: number };
  leases: number;
  ticketSecretFp?: string;
  registeredAtMs?: number;
  ageMs: number;
  stale?: boolean;
}

export function nodeView(
  node: NodeRecord,
  now: number,
  isSchedulable: boolean,
  blockedBy: string | null,
): NodeView {
  const used = node.slots?.used ?? 0;
  const total = node.slots?.total ?? 0;

  return {
    nodeId: node.nodeId,
    base: node.base,
    pool: node.pool || 'default',
    version: node.version,
    caps: node.caps,
    healthy: node.healthy !== false,
    draining: node.draining === true,
    drainSource: node.drainSource,
    drain: node.drain,
    schedulable: isSchedulable,
    blockedBy,
    slots: { used, total, free: Math.max(0, total - used) },
    leases: Number(node.leases) || 0,
    ticketSecretFp: node.ticketSecretFp,
    registeredAtMs: node.registeredAtMs,
    ageMs: Math.max(0, now - (node.updatedAtMs || now)),
  };
}
