import Redis from 'ioredis';
import NodeCache from 'node-cache';
import { devStoreEnabled } from '../config';

export interface Store {
  setex(key: string, ttl: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  hset(key: string, field: string, value: string): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
}

class MemoryStore implements Store {
  private data = new NodeCache({ checkperiod: 1, useClones: false });

  async setex(key: string, ttl: number, value: string): Promise<number> {
    this.data.set(key, value, ttl);
    return 1;
  }

  async get(key: string): Promise<string | null> {
    return this.data.get<string>(key) ?? null;
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) {
      n += this.data.del(key);
    }
    return n;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.data.get<string>(k) ?? null);
  }

  private readHash(key: string): Record<string, string> {
    const raw = this.data.get<string>(key);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private writeHash(key: string, hash: Record<string, string>): void {
    this.data.set(key, JSON.stringify(hash), 0);
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const h = this.readHash(key);
    const isNew = !(field in h) ? 1 : 0;
    h[field] = value;
    this.writeHash(key, h);
    return isNew;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.readHash(key);
  }
}

function wrapRedis(redis: Redis): Store {
  return {
    setex: (key, ttl, value) => redis.setex(key, ttl, value) as Promise<unknown>,
    get: (key) => redis.get(key),
    del: (...keys) => (keys.length > 0 ? redis.del(...keys) : Promise.resolve(0)),
    mget: (...keys) =>
      keys.length > 0
        ? redis.mget(...keys)
        : Promise.resolve([]),
    hset: (key, field, value) => redis.hset(key, field, value),
    hgetall: (key) => redis.hgetall(key),
  };
}

let redisInstance: Redis | null = null;
let redisStore: Store | null = null;
let memoryInstance: MemoryStore | null = null;

export function getStore(): [Store, null] | [null, string] {
  const url = process.env.REDIS_URL;
  if (url) {
    if (!redisInstance) {
      redisInstance = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
      redisStore = wrapRedis(redisInstance);
    }
    return [redisStore!, null];
  }

  if (devStoreEnabled()) {
    if (!memoryInstance) {
      memoryInstance = new MemoryStore();
    }
    return [memoryInstance, null];
  }

  return [
    null,
    '未配置 REDIS_URL（本地开发可设 SANDBOX_DEV_MEMORY_STORE=1 降级为单机内存存储）',
  ];
}

export async function closeStore(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
    redisStore = null;
  }
}
