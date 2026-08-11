import * as ticket from './ticket';
import * as registry from './registry';
import { httpGet, httpDelete } from './http-client';

const LEASE_ID_PATTERN = /^[A-Za-z0-9_]+$/;

export function validLeaseId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 128) return false;
  return LEASE_ID_PATTERN.test(id);
}

async function resolve(nodeId: string): Promise<[registry.NodeRecord, null] | [null, string]> {
  const node = await registry.get(nodeId);
  if (!node) return [null, '节点不在注册表里（可能已下线或心跳中断）'];
  if (!node.base) return [null, '节点没有可用的 base 地址'];
  return [node, null];
}

function adminToken(nodeId: string, operator: string) {
  return ticket.issue({
    nodeId,
    runId: 'console-admin',
    username: operator,
    scope: 'admin',
  });
}

function failFrom(
  res: { status: number; ok: boolean } | null,
  httpErr: string | null,
  base: string,
): string | null {
  if (!res) return '连不上节点 ' + base + '：' + (httpErr || 'unknown');
  if (res.status === 401) {
    return '节点拒绝了票据（多半是两端 SANDBOX_TICKET_SECRET 不一致，去配置自检页比对指纹）';
  }
  if (res.status === 404) {
    return '该节点还不支持运维接口（版本偏旧，升级后即可）';
  }
  if (!res.ok) return '节点返回异常（HTTP ' + res.status + '）';
  return null;
}

export async function occupancy(
  nodeId: string,
  operator: string,
): Promise<[Record<string, unknown>, null] | [null, string]> {
  const [node, nodeErr] = await resolve(nodeId);
  if (!node) return [null, nodeErr];

  const [token, signErr] = adminToken(nodeId, operator);
  if (!token) return [null, '票据签发失败: ' + signErr];

  let res, httpErr: string | null = null;
  try {
    res = await httpGet(node.base + '/v1/admin/occupancy', {
      headers: { Authorization: 'Bearer ' + token },
      connectTimeout: 3000,
      readTimeout: 10000,
    });
  } catch (e: unknown) {
    httpErr = String(e);
  }

  const why = failFrom(res || null, httpErr, node.base);
  if (why) return [null, why];
  if (typeof res!.json !== 'object' || res!.json === null) {
    return [null, '节点返回的不是 JSON'];
  }
  return [res!.json as Record<string, unknown>, null];
}

export async function kill(
  nodeId: string,
  leaseId: string,
  operator: string,
): Promise<[Record<string, unknown>, null] | [null, string]> {
  const [node, nodeErr] = await resolve(nodeId);
  if (!node) return [null, nodeErr];

  const [token, signErr] = adminToken(nodeId, operator);
  if (!token) return [null, '票据签发失败: ' + signErr];

  let res, httpErr: string | null = null;
  try {
    res = await httpDelete(node.base + '/v1/admin/leases/' + leaseId, {
      headers: { Authorization: 'Bearer ' + token },
      connectTimeout: 3000,
      readTimeout: 15000,
    });
  } catch (e: unknown) {
    httpErr = String(e);
  }

  const why = failFrom(res || null, httpErr, node.base);
  if (why) return [null, why];
  if (typeof res!.json !== 'object' || res!.json === null) {
    return [null, '节点返回的不是 JSON'];
  }
  return [res!.json as Record<string, unknown>, null];
}
