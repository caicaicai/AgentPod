import * as registry from './registry';
import { NodeRecord } from './registry';

export interface PickOptions {
  pool?: string;
  need?: Record<string, boolean>;
  limit?: number;
}

interface RejectedEntry {
  nodeId: string;
  why: string;
}

interface CandidateEntry {
  node: NodeRecord;
  free: number;
  jitter: number;
}

function capsMatch(
  node: NodeRecord,
  need?: Record<string, boolean>,
): [true, null] | [false, string] {
  if (!need || typeof need !== 'object') return [true, null];
  const caps = node.caps || {};
  for (const [name, required] of Object.entries(need)) {
    if (required === true && caps[name] !== true) {
      return [false, name];
    }
  }
  return [true, null];
}

function freeSlots(node: NodeRecord): number {
  const total = node.slots?.total ?? 0;
  const used = node.slots?.used ?? 0;
  return total - used;
}

let lastNodes: NodeRecord[] = [];

export function getLastNodes(): NodeRecord[] {
  return lastNodes;
}

export async function pick(
  opts: PickOptions,
): Promise<
  [CandidateEntry[], null, RejectedEntry[]] | [null, string, RejectedEntry[]]
> {
  const [nodes, err] = await registry.listCached(2);
  if (err) return [null, err, []];
  lastNodes = nodes!;

  const pool = opts.pool || 'default';
  const candidates: CandidateEntry[] = [];
  const rejected: RejectedEntry[] = [];

  for (const node of nodes!) {
    const nodePool = node.pool || 'default';
    if (nodePool !== pool) {
      rejected.push({ nodeId: node.nodeId, why: 'pool' });
      continue;
    }

    const [isSchedulable, why] = registry.schedulable(node);
    if (!isSchedulable) {
      rejected.push({ nodeId: node.nodeId, why: why! });
      continue;
    }

    const [matched, missing] = capsMatch(node, opts.need);
    if (!matched) {
      rejected.push({ nodeId: node.nodeId, why: 'caps:' + missing });
      continue;
    }

    candidates.push({
      node,
      free: freeSlots(node),
      jitter: Math.random(),
    });
  }

  candidates.sort((a, b) => {
    if (a.free !== b.free) return b.free - a.free;
    return a.jitter - b.jitter;
  });

  const limit = opts.limit || 3;
  if (candidates.length > limit) {
    candidates.length = limit;
  }

  return [candidates, null, rejected];
}

export function leasesOf(
  nodes: NodeRecord[],
  username: string,
): number {
  if (typeof username !== 'string' || !username) return 0;
  let total = 0;
  for (const node of nodes) {
    const byUser = node.leaseUsers;
    if (byUser && typeof byUser === 'object') {
      const n = Number(byUser[username]);
      if (n > 0) total += n;
    }
  }
  return total;
}
