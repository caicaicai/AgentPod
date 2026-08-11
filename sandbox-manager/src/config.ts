import crypto from 'crypto';

export function envInt(name: string, defaultVal: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultVal;
  const n = parseInt(raw, 10);
  return isNaN(n) ? defaultVal : n;
}

export function envStr(name: string, defaultVal = ''): string {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultVal;
  return raw;
}

export function keyPrefix(): string {
  return `sbx:${envStr('SANDBOX_ENV', 'default')}:`;
}

export function nodeKey(nodeId: string): string {
  return `${keyPrefix()}node:${nodeId}`;
}

export function directoryKey(): string {
  return `${keyPrefix()}nodes`;
}

export function drainsKey(): string {
  return `${keyPrefix()}drains`;
}

export function envSet(name: string): { set: Set<string>; count: number } {
  const raw = envStr(name);
  const set = new Set<string>();
  for (const item of raw.split(/[,\s]+/)) {
    if (item) set.add(item);
  }
  return { set, count: set.size };
}

const NODE_ID_PATTERN = /^[A-Za-z0-9_.\-]+$/;

export function validNodeId(nodeId: unknown): nodeId is string {
  if (typeof nodeId !== 'string') return false;
  if (nodeId.length === 0 || nodeId.length > 128) return false;
  return NODE_ID_PATTERN.test(nodeId);
}

export function secretFingerprint(secret: string): string {
  if (!secret) return 'none';
  return crypto.createHash('sha256').update(secret).digest('hex').substring(0, 8);
}

export function devStoreEnabled(): boolean {
  const raw = process.env.SANDBOX_DEV_MEMORY_STORE;
  return raw === '1' || raw === 'true';
}

export function storeKind(): 'redis' | 'memory' | 'none' {
  if (process.env.REDIS_URL) return 'redis';
  if (devStoreEnabled()) return 'memory';
  return 'none';
}
