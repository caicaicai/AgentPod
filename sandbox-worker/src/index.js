import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { createLeaseManager } from './leases.js'
import { createBrowserManager } from './browser/index.js'
import { createSlotPool } from './namespace/slot-pool.js'
import { createServer } from './server.js'
import { createManagerClient } from './manager/client.js'
import { createEgressPolicyStore } from './egress-policy.js'

async function main() {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel })

  const browserManager = createBrowserManager({ config, logger })
  // 出站策略要在建 slot 之前就位：slot 的 iptables 规则是按它编排的。
  // 此刻用的必然是本地 env 那份默认值（拦），管理端的下发要等注册响应。
  const egressPolicy = createEgressPolicyStore({ config, logger })
  const slotPool = createSlotPool({ config, logger, egressPolicy, browserManager })
  // 建不起 slot 池就直接失败退出——namespace 隔离是唯一的执行路径，没有可以
  // 降级运行的模式。这一步失败多半意味着容器缺 CAP_SYS_ADMIN/CAP_NET_ADMIN，
  // 应该先用 bin/check-namespace-caps.sh 确认前提条件，而不是让 worker 带着
  // 一个不完整的隔离边界跑起来。
  await slotPool.init()

  const leaseManager = createLeaseManager({ config, logger, slotPool })
  const app = createServer({ config, logger, leaseManager, browserManager, slotPool, egressPolicy })

  await app.listen(config.port)
  leaseManager.startSweeper()

  logger.info('沙盒 worker 已启动', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    slots: config.slots,
    workRoot: config.workRoot,
    advertiseBase: config.advertiseBase || null,
    anonymous: config.allowAnonymous,
    browser: config.browser.enabled,
    manager: config.manager.enabled ? config.manager.url : null,
  })

  for (const warning of config.warnings || []) logger.warn(warning)
  if (config.allowAnonymous) logger.warn('ALLOW_ANONYMOUS=1：任何能连到本端口的人都能执行命令，仅限本地开发')
  egressPolicy.announce()

  // 注册放在 listen **之后**：先能接住请求再宣告自己可用，
  // 否则 manager 可能在端口还没起来的窗口里就把请求派过来。
  let managerClient = null
  if (config.manager.enabled) {
    managerClient = createManagerClient({ config, logger, leaseManager, slotPool, browserManager, egressPolicy })
    managerClient.start()
  } else {
    logger.info('未配置 SANDBOX_MANAGER_URL，本节点以独立模式运行（不注册、不心跳、出站策略只认本地 env）')
  }

  const shutdown = async (signal) => {
    logger.info('收到停机信号', { signal })
    // 先摘流量：注销要排在关端口**之前**，否则那 30 秒 TTL 窗口里调度还会
    // 把请求派给一个正在关闭的节点。注销失败也不阻塞停机，由 TTL 兜底。
    await managerClient?.stop()
    leaseManager.stopSweeper()
    await app.close()
    // 停机也要把工作区抹掉：否则容器被回收前磁盘上还留着用户数据
    const released = await leaseManager.releaseAll('shutdown')
    await slotPool.shutdown()
    await browserManager.shutdown()
    logger.info('已停机', { releasedLeases: released })
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  if (error?.code === 'CONFIG_INVALID') {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
  process.stderr.write(`启动失败：${error?.stack || error}\n`)
  process.exit(1)
})
