import NodeCache from 'node-cache';

const cache = new NodeCache({ checkperiod: 2, useClones: false });

export function cacheGet(key: string): string | undefined {
  return cache.get<string>(key);
}

export function cacheSet(key: string, value: string, ttlSec = 0): void {
  cache.set(key, value, ttlSec);
}
