/**
 * 组装与启动。所有依赖在这里注入，方便测试替换（测试直接调 createRunService 等，不起 HTTP）。
 */
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { createPlatformClient } from './platform/http.js'
import { createIdentityResolver } from './identity/index.js'
import { createLlmInfoClient } from './models/llminfo-client.js'
import { createPassthroughBroker, createFauxBroker, createDirectBroker } from './credentials/broker.js'
import { createSessionStore } from './sessions/store.js'
import { createWorkspaceStore } from './workspace/store.js'
import { createSkillManager, createDisabledSkillManager } from './workspace/skill-manager.js'
import { createSandbox } from './sandbox/client.js'
import { createRunService } from './agent/run-service.js'
import { createMetrics } from './telemetry/metrics.js'
import { createServer } from './http/server.js'
import { createMemoryStore } from './memory/store.js'
import { createMemoryCapture } from './memory/capture.js'
import { createProjectStore } from './projects/store.js'
import { createCronStore } from './cron/store.js'
import { createCronCredentialVault } from './cron/credentials.js'
import { createScheduler } from './cron/scheduler.js'

async function main() {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel })

  const platform = createPlatformClient({ config, logger })
  const identity = createIdentityResolver({ config, logger })
  const store = await createSessionStore({ config, logger })
  const workspace = createWorkspaceStore({ config, logger })
  // 技能管理面（改/删/停用）。没有用户工作空间时它整体是关的 —— 与 canCreate 同一个前提
  const skillManager = workspace.enabled
    ? createSkillManager({ workspace, logger })
    : createDisabledSkillManager()
  const sandbox = createSandbox({ config, logger })
  const metrics = createMetrics()

  /**
   * 无数据库的那几样状态，全部落在 DATA_DIR 下、按 username 分区。
   *
   * 它们与会话驱动是**解耦**的：SESSION_STORE=mysql 时长期记忆一样能用，
   * 因为它落的是 DATA_DIR 而不是会话表。
   */
  const memory = createMemoryStore({ config, logger })
  const memoryCapture = createMemoryCapture({ memory, config, logger })
  const projects = createProjectStore({ config, logger })
  const crons = createCronStore({ config, logger })
  const cronVault = createCronCredentialVault({ config, logger })

  let broker
  let llmInfoClient = null
  if (config.llm.mode === 'faux') {
    const { registerFauxProvider } = await import('@mariozechner/pi-ai')
    const faux = registerFauxProvider({
      api: 'openai-completions',
      provider: 'ap-gateway',
      models: [{ id: 'ap-dev', name: '本地开发假模型', contextWindow: 128000, maxTokens: 4096 }],
      tokensPerSecond: 45,
    })
    const { fauxAssistantMessage } = await import('@mariozechner/pi-ai')
    const responder = (context) => {
      faux.appendResponses([responder])
      const texts = []
      for (const message of context.messages || []) {
        if (message.role !== 'user') continue
        if (typeof message.content === 'string') texts.push(message.content)
        else for (const part of message.content || []) if (part?.type === 'text') texts.push(part.text)
      }
      return fauxAssistantMessage(
        `我是跑在服务端的 pi agent（LLM_MODE=faux，没有调用真实模型）。\n` +
          `本次 run 我能看到的会话历史只有：${texts.join(' ｜ ') || '（空）'}`,
      )
    }
    faux.setResponses([responder])
    broker = createFauxBroker({ fauxModel: faux.getModel() })
  } else if (config.llm.mode === 'direct') {
    broker = createDirectBroker({ config })
    logger.warn('LLM_MODE=direct：正在直连外部模型端点，用的是一把共用的静态 key，仅限本地联调', {
      baseUrl: config.llm.direct.baseUrl,
      models: config.llm.direct.models,
    })
  } else {
    llmInfoClient = createLlmInfoClient({ config, platform, logger })
    broker = createPassthroughBroker({ llmInfoClient, logger })
  }

  const runService = createRunService({
    config, logger, store, sandbox, broker, metrics, workspace, skillManager,
    memory, memoryCapture, projects, crons,
  })
  // 调度器要用 runService，所以只能排在它后面建
  const scheduler = createScheduler({ config, logger, crons, vault: cronVault, runService, sessionStore: store })
  const app = createServer({
    config, logger, identity, broker, runService, store, llmInfoClient, metrics, workspace, skillManager,
    memory, projects, crons, scheduler, cronVault,
  })

  await app.listen(config.port)
  scheduler.start()

  logger.info('云端 Agent 已启动', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    // 只有路径和条数 —— 这个文件里有 SANDBOX_MANAGER_CODE / MYSQL_PASSWORD
    envFile: config.envFile.path ? `${config.envFile.path}（${config.envFile.keys} 项）` : '未使用（全靠环境变量）',
    authMode: config.auth.mode,
    llmMode: config.llm.mode,
    sessionStore: store.driver,
    dataDir: config.dataDir,
    memory: memory.enabled
      ? (memoryCapture.enabled
        ? `开（自动抓取：攒批 ${Math.round(config.memory.captureQuietMs / 1000)}s / ${config.memory.captureMaxTurns} 轮）`
        : '开（由模型经 memory 工具写入，不额外调模型）')
      : '关',
    projects: projects.enabled ? '开' : '关',
    cron: crons.enabled ? `开（调度${scheduler.enabled ? '中' : '未启用'}，凭据 ${cronVault.mode}）` : '关',
    userWorkspace: workspace.enabled ? workspace.root : null,
    sandbox: sandbox.mode,
    devConsole: config.devConsole,
    maxConcurrentRuns: config.limits.maxConcurrentRuns,
  })
  if (config.auth.mode === 'dev') logger.warn('AUTH_MODE=dev：信任客户端自称的 X-Username，仅限本地开发')
  if (config.auth.mode === 'password') {
    logger.info('AUTH_MODE=password：使用内置账号密码登录')
    if (config.llm.mode === 'platform') {
      logger.warn('AUTH_MODE=password + LLM_MODE=platform：password 模式下没有凭据可透传给 llminfo，模型清单会取不到。建议改用 LLM_MODE=direct')
    }
  }
  if (store.driver === 'memory') {
    // 不是提示是事实：这个驱动下每次发版、每次重启，所有人的对话记录都归零。
    // 想留住历史用 SESSION_STORE=file（落 DATA_DIR）或 mysql。
    logger.warn('SESSION_STORE=memory：会话只在进程内存里，重启即全部丢失', { 建议: 'SESSION_STORE=file' })
  }
  if (store.driver === 'file' || memory.enabled || crons.enabled) {
    // 本机磁盘。多副本部署下同一个人可能落到不同副本，看到的历史/记忆就会不一样。
    logger.info('本地数据目录已启用', {
      dataDir: config.dataDir,
      note: '多副本部署请把 DATA_DIR 指到共享盘，否则各副本数据互不可见',
    })
  }
  if (scheduler.enabled) {
    // 任务表在盘上，占坑只在进程内串行 —— 两个副本同时调度会把同一个任务点两次
    logger.warn('本副本承担定时任务调度：CRON_SCHEDULER 必须只在一个副本上打开')
  }
  if (cronVault.enabled) {
    // 与 SANDBOX_INJECT_ME_TOKEN 同一个理由：这类开关一旦被谁顺手打开又忘了，
    // 日志里必须一眼能看见，不能混在 info 里。
    logger.error('CRON_CREDENTIAL_MODE=stored：用户登录态会以 0600 权限落盘，供无人值守的定时任务使用', {
      note: '拿到盘即等于拿到这些人的登录态；平台支持服务端代持后应改回 none',
    })
  }
  if (config.sandbox.injectMeToken) {
    logger.error('SANDBOX_INJECT_ME_TOKEN=1：用户 me_token 会注入沙盒环境变量，模型生成的代码可读取并外带')
  }

  const shutdown = async (signal) => {
    logger.info('收到停机信号，开始优雅停机', { signal })
    // 先停调度：停机窗口里不该再点新任务，否则 app.close() 等的是自己刚放进去的活
    scheduler.stop()
    await app.close()
    await store.close?.()
    logger.info('已停机')
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error) => {
  // 配置错误要给人看得懂的提示，别甩一堆栈
  if (error?.code === 'CONFIG_INVALID') {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  }
  process.stderr.write(`启动失败：${error?.stack || error}\n`)
  process.exit(1)
})
