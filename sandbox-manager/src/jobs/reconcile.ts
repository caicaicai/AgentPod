import { FastifyBaseLogger } from 'fastify';
import * as registry from '../lib/registry';
import { getStore } from '../lib/store';
import { directoryKey } from '../config';

export async function reconcile(log: FastifyBaseLogger): Promise<void> {
  const [nodes, err] = await registry.list();
  if (err) {
    log.error({ err }, '对账失败：读注册表异常');
    return;
  }

  const [db, dbErr] = getStore();
  if (!db) {
    log.error({ err: dbErr }, '对账失败：存储不可用');
    return;
  }

  const dirKey = directoryKey();

  try {
    await db.del(dirKey);
  } catch (e: unknown) {
    log.error({ err: String(e) }, '对账失败：删除节点目录异常');
    return;
  }

  let restored = 0;
  for (const node of nodes!) {
    try {
      await db.hset(dirKey, node.nodeId, '1');
      restored++;
    } catch {
      // continue
    }
  }

  const pools: Record<string, number> = {};
  let slotsUsed = 0;
  let slotsTotal = 0;
  let draining = 0;
  let unhealthy = 0;

  for (const node of nodes!) {
    const pool = node.pool || 'default';
    pools[pool] = (pools[pool] || 0) + 1;
    slotsUsed += node.slots?.used ?? 0;
    slotsTotal += node.slots?.total ?? 0;
    if (node.draining) draining++;
    if (node.healthy === false) unhealthy++;
  }

  log.info(
    {
      liveNodes: nodes!.length,
      directoryRestored: restored,
      slotsUsed,
      slotsTotal,
      draining,
      unhealthy,
      pools,
    },
    '沙盒集群对账完成',
  );
}
