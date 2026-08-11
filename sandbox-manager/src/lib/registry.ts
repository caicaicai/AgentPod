import { getStore, Store } from './store';
import { cacheGet, cacheSet } from './cache';
import { envInt, keyPrefix, nodeKey, directoryKey, drainsKey, validNodeId } from '../config';

export interface NodeRecord {
  nodeId: string;
  base: string;
  pool: string;
  labels: Record<string, string>;
  caps: Record<string, boolean>;
  version?: string;
  capacity: { slots: number };
  ticketSecretFp?: string;
  slots: { used: number; total: number };
  leases?: number;
  leaseUsers?: Record<string, number>;
  healthy: boolean;
  draining: boolean;
  drainSource?: 'node' | 'admin';
  drain?: { by: string; atMs: number; reason?: string };
  egress?: {
    mode?: string;
    revision?: string;
    source?: string;
    pendingSlots?: number;
    totalSlots?: number;
  };
  browser?: { running: boolean };
  registeredAtMs: number;
  updatedAtMs: number;
}

export interface DrainMark {
  active: boolean;
  by: string;
  atMs: number;
  reason?: string;
}

function db(): [Store, null] | [null, string] {
  return getStore();
}

async function writeNode(
  store: Store,
  node: NodeRecord,
  ttlSec: number,
  payload: string,
): Promise<[true, null] | [false, string]> {
  try {
    await store.setex(nodeKey(node.nodeId), ttlSec, payload);
  } catch (e: unknown) {
    return [false, String(e)];
  }

  try {
    await store.hset(directoryKey(), node.nodeId, '1');
  } catch (e: unknown) {
    // 目录写失败不致命：明细已经在了，下个心跳会补
    console.warn('节点目录写入失败，该节点暂时不会被调度到', {
      nodeId: node.nodeId,
      err: String(e),
    });
  }
  return [true, null];
}

export async function put(node: NodeRecord): Promise<[true, null] | [false, string]> {
  const [store, err] = db();
  if (!store) return [false, err];

  const staleMs = envInt('SANDBOX_STALE_MS', 30000);
  const ttlSec = Math.ceil(staleMs / 1000);

  let payload: string;
  try {
    payload = JSON.stringify(node);
  } catch {
    return [false, '节点信息序列化失败'];
  }

  const [ok, writeErr] = await writeNode(store, node, ttlSec, payload);
  if (!ok) return [false, '写节点明细失败: ' + writeErr];
  return [true, null];
}

export async function get(nodeId: string): Promise<NodeRecord | null> {
  const [store, err] = db();
  if (!store) return null;

  try {
    const raw = await store.get(nodeKey(nodeId));
    if (!raw) return null;
    const decoded = JSON.parse(raw);
    if (typeof decoded !== 'object' || decoded === null) return null;
    return decoded as NodeRecord;
  } catch {
    return null;
  }
}

export async function remove(nodeId: string): Promise<[true, null] | [false, string]> {
  const [store, err] = db();
  if (!store) return [false, err];

  try {
    await store.del(nodeKey(nodeId));
  } catch (e: unknown) {
    return [false, String(e)];
  }
  return [true, null];
}

export async function drains(): Promise<
  [Record<string, DrainMark>, null] | [null, string]
> {
  const [store, err] = db();
  if (!store) return [null, err];

  try {
    const raw = await store.hgetall(drainsKey());
    const out: Record<string, DrainMark> = {};
    for (const [nid, value] of Object.entries(raw)) {
      if (!validNodeId(nid)) continue;
      try {
        const decoded = JSON.parse(value) as DrainMark;
        if (decoded && decoded.active) out[nid] = decoded;
      } catch {
        // skip bad entries
      }
    }
    return [out, null];
  } catch (e: unknown) {
    return [null, '读摘除标记失败: ' + String(e)];
  }
}

export async function setDrain(
  nodeId: string,
  record: DrainMark,
): Promise<[true, null] | [false, string]> {
  const [store, err] = db();
  if (!store) return [false, err];

  try {
    await store.hset(drainsKey(), nodeId, JSON.stringify(record));
    return [true, null];
  } catch (e: unknown) {
    return [false, '写摘除标记失败: ' + String(e)];
  }
}

export async function list(): Promise<[NodeRecord[], null] | [null, string]> {
  const [store, err] = db();
  if (!store) return [null, err];

  let dir: Record<string, string>;
  try {
    dir = await store.hgetall(directoryKey());
  } catch (e: unknown) {
    return [null, '读节点目录失败: ' + String(e)];
  }

  const ids = Object.keys(dir).filter((id) => validNodeId(id));
  if (ids.length === 0) return [[], null];

  const keys = ids.map((id) => nodeKey(id));
  let values: (string | null)[];
  try {
    values = await store.mget(...keys);
  } catch (e: unknown) {
    return [null, '读节点明细失败: ' + String(e)];
  }

  const nodes: NodeRecord[] = [];
  for (const raw of values) {
    if (!raw) continue;
    try {
      const decoded = JSON.parse(raw);
      if (typeof decoded === 'object' && decoded !== null && validNodeId(decoded.nodeId)) {
        nodes.push(decoded as NodeRecord);
      }
    } catch {
      // skip bad entries
    }
  }

  const [drainMarks, drainErr] = await drains();
  if (drainErr) {
    console.warn('读摘除标记失败，本轮按未摘除处理', { err: drainErr });
  } else if (drainMarks) {
    for (const node of nodes) {
      const mark = drainMarks[node.nodeId];
      if (mark) {
        node.draining = true;
        node.drainSource = 'admin';
        node.drain = { by: mark.by, atMs: mark.atMs, reason: mark.reason };
      } else if (node.draining) {
        node.drainSource = 'node';
      }
    }
  }

  return [nodes, null];
}

export async function listCached(
  ttlSec = 2,
): Promise<[NodeRecord[], null] | [null, string]> {
  const cacheKey = keyPrefix() + 'nodes-snapshot';
  const hit = cacheGet(cacheKey);
  if (hit) {
    try {
      const decoded = JSON.parse(hit);
      if (Array.isArray(decoded)) return [decoded, null];
    } catch {
      // cache miss
    }
  }

  const [nodes, err] = await list();
  if (err) return [null, err];

  try {
    cacheSet(cacheKey, JSON.stringify(nodes), ttlSec);
  } catch {
    // cache write failure is non-fatal
  }
  return [nodes!, null];
}

export function schedulable(node: NodeRecord): [true, null] | [false, string] {
  if (!node) return [false, 'missing'];
  if (node.draining) return [false, 'draining'];
  if (node.healthy === false) return [false, 'unhealthy'];
  const total = node.slots?.total ?? 0;
  const used = node.slots?.used ?? 0;
  if (total <= 0) return [false, 'no-capacity'];
  if (used >= total) return [false, 'full'];
  return [true, null];
}
