import crypto from 'crypto';
import { getStore } from './store';
import * as ticket from './ticket';
import * as registry from './registry';
import { httpGet, httpPost, httpDelete, HttpResponse } from './http-client';
import { envStr, envInt, keyPrefix } from '../config';

export interface DebugSession {
  sessionId: string;
  nodeId: string;
  base: string;
  leaseId: string;
  leaseToken: string;
  username: string;
  createdAtMs: number;
}

function sessionKey(id: string): string {
  return keyPrefix() + 'console-session:' + id;
}

function sessionTtlSec(): number {
  return Math.max(60, Math.floor(envInt('SANDBOX_CONSOLE_SESSION_MS', 900000) / 1000));
}

export function enabled(): boolean {
  const raw = envStr('SANDBOX_CONSOLE_EXEC', '0');
  return raw === '1' || raw === 'true';
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9\-]+$/;

export function validSessionId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 64) return false;
  return SESSION_ID_PATTERN.test(id);
}

export async function open(
  nodeId: string,
  username: string,
): Promise<[Record<string, unknown>, null] | [null, string]> {
  const node = await registry.get(nodeId);
  if (!node) return [null, '节点不在注册表里（可能已下线或心跳中断）'];
  if (!node.base) return [null, '节点没有可用的 base 地址'];

  const [token, signErr] = ticket.issue({
    nodeId,
    runId: 'console-' + Date.now(),
    username,
  });
  if (!token) return [null, '票据签发失败: ' + signErr];

  let res: HttpResponse;
  try {
    res = await httpPost(
      node.base + '/v1/leases',
      { runId: 'console' },
      {
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        connectTimeout: 3000,
        readTimeout: 10000,
      },
    );
  } catch (e: unknown) {
    return [null, '连不上节点 ' + node.base + '：' + String(e)];
  }

  if (res.status === 429) return [null, '节点当前没有空闲槽位'];
  if (res.status === 401) {
    return [
      null,
      '节点拒绝了票据（多半是两端 SANDBOX_TICKET_SECRET 不一致，去配置自检页比对指纹）',
    ];
  }
  const json = res.json as any;
  if (!res.ok || !json?.leaseId) {
    return [null, '节点返回异常（HTTP ' + res.status + '）'];
  }

  const sessionId = crypto.randomUUID();
  const record: DebugSession = {
    sessionId,
    nodeId,
    base: node.base,
    leaseId: json.leaseId,
    leaseToken: json.leaseToken,
    username,
    createdAtMs: Date.now(),
  };

  const [store, dbErr] = getStore();
  if (!store) return [null, dbErr];

  try {
    await store.setex(sessionKey(sessionId), sessionTtlSec(), JSON.stringify(record));
  } catch (e: unknown) {
    return [null, '会话写入失败: ' + String(e)];
  }

  return [
    {
      sessionId,
      leaseId: json.leaseId,
      nodeId,
      base: node.base,
      expiresAt: json.expiresAt,
      hardExpiresAt: json.hardExpiresAt,
      idleTimeoutMs: json.idleTimeoutMs,
      slots: json.slots,
    },
    null,
  ];
}

export async function load(
  sessionId: string,
  username: string,
): Promise<[DebugSession, null] | [null, string]> {
  if (!validSessionId(sessionId)) return [null, 'sessionId 非法'];

  const [store, err] = getStore();
  if (!store) return [null, err];

  try {
    const raw = await store.get(sessionKey(sessionId));
    if (!raw) return [null, '会话不存在或已过期'];

    const record = JSON.parse(raw) as DebugSession;
    if (record.username !== username) return [null, '会话不存在或已过期'];
    return [record, null];
  } catch {
    return [null, '会话数据损坏'];
  }
}

interface OpSpec {
  method: string;
  path: string;
  timeout?: number;
}

const OPS: Record<string, OpSpec> = {
  exec: { method: 'POST', path: '/exec', timeout: 120000 },
  'file.write': { method: 'POST', path: '/files' },
  'file.read': { method: 'GET', path: '/files' },
  'lease.status': { method: 'GET', path: '' },
  'lease.renew': { method: 'POST', path: '/renew' },
};

const BROWSER_ACTIONS = new Set([
  'open', 'navigate', 'snapshot', 'screenshot', 'content',
  'evaluate', 'act', 'network', 'network.clear', 'close',
]);

export function resolveOp(op: string): OpSpec | null {
  if (typeof op !== 'string') return null;
  const direct = OPS[op];
  if (direct) return direct;

  const match = op.match(/^browser\.(.+)$/);
  if (match && BROWSER_ACTIONS.has(match[1])) {
    return { method: 'POST', path: '/browser/' + match[1], timeout: 90000 };
  }
  return null;
}

export async function touch(record: DebugSession): Promise<void> {
  const [store] = getStore();
  if (!store) return;
  try {
    await store.setex(
      sessionKey(record.sessionId),
      sessionTtlSec(),
      JSON.stringify(record),
    );
  } catch {
    // best-effort
  }
}

export async function call(
  record: DebugSession,
  op: string,
  payload: unknown,
): Promise<[HttpResponse, null] | [null, string]> {
  const spec = resolveOp(op);
  if (!spec) return [null, '不支持的操作：' + op];

  const url = record.base + '/v1/leases/' + record.leaseId + spec.path;
  const opts = {
    headers: {
      Authorization: 'Bearer ' + record.leaseToken,
      'Content-Type': 'application/json',
    },
    connectTimeout: 3000,
    readTimeout: spec.timeout || 30000,
  };

  try {
    let res: HttpResponse;
    if (spec.method === 'GET') {
      res = await httpGet(url, {
        ...opts,
        query: payload as Record<string, string>,
      });
    } else {
      res = await httpPost(url, payload || {}, opts);
    }
    return [res, null];
  } catch (e: unknown) {
    return [null, '连不上节点：' + String(e)];
  }
}

export async function close(
  record: DebugSession,
): Promise<[boolean, string | null]> {
  let released = false;
  let err: string | null = null;

  try {
    const res = await httpDelete(record.base + '/v1/leases/' + record.leaseId, {
      headers: { Authorization: 'Bearer ' + record.leaseToken },
      connectTimeout: 3000,
      readTimeout: 10000,
    });
    released = res.ok;
  } catch (e: unknown) {
    err = String(e);
  }

  const [store] = getStore();
  if (store) {
    try {
      await store.del(sessionKey(record.sessionId));
    } catch {
      // best-effort
    }
  }

  return [released, err];
}
