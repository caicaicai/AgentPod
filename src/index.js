/**
 * 组装与启动。所有依赖在这里注入，方便测试替换（测试直接调 createRunService 等，不起 HTTP）。
 */
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { createPlatformClient } from './platform/http.js'
import { createIdentityResolver } from './identity/index.js'
import { createLlmInfoClient } from './models/llminfo-client.js'
import { createPassthroughBroker, createFauxBroker, createDirectBroker, createDbBroker } from './credentials/broker.js'
import { createModelStore } from './models/model-store.js'
import { createGroupStore } from './identity/group-store.js'
import { createSessionStore } from './sessions/store.js'
import { createWorkspaceStore } from './workspace/store.js'
import { createSkillManager, createDisabledSkillManager } from './workspace/skill-manager.js'
import { createSandbox } from './sandbox/client.js'
import { createRunService } from './agent/run-service.js'
import { createMetrics } from './telemetry/metrics.js'
import { createUsageStore } from './telemetry/usage-store.js'
import { createServer } from './http/server.js'
import { createMemoryStore } from './memory/store.js'
import { createMemoryCapture } from './memory/capture.js'
import { createProjectStore } from './projects/store.js'
import { createArtifactStore } from './artifacts/store.js'
import { createShareStore } from './artifacts/shares.js'
import { createStorage } from './persistence/storage.js'
import { createUserStore } from './identity/user-store.js'
import { createCronStore } from './cron/store.js'
import { createCronCredentialVault } from './cron/credentials.js'
import { createScheduler } from './cron/scheduler.js'

async function main() {
  const config = loadConfig()
  const logger = createLogger({ level: config.logLevel })

  const platform = createPlatformClient({ config, logger })

  /**
   * 结构化存储的后端。**先于所有 store 建起来**，因为它们全都从它拿能力。
   *
   * mysql 驱动会在这里连库并建表 —— 连不上就当场抛，服务起不来。
   * 那是有意的：起来了但第一次写数据才报错，用户看到的是一条业务失败，
   * 而运维在部署日志里什么都看不到。
   */
  const storage = await createStorage({ config, logger })

  // 会话与其余数据共用同一个连接池（mysql 驱动下），理由见 src/persistence/mysql.js
  const store = await createSessionStore({ config, logger, pool: storage.pool || null })

  /**
   * 模型清单与用户分组。
   *
   * 两者**与 LLM_MODE 无关地建起来**：管理员在任何模式下都该能预先把模型配好，
   * 再切 LLM_MODE=db 让它生效 —— 反过来（先切模式，起来发现一个模型都没有，
   * 所有人的对话一起断）是一次没有必要的停机。管理台上会写清当前生不生效。
   */
  const groups = createGroupStore({ storage, logger })
  const modelStore = createModelStore({ config, storage, logger })

  /**
   * 账号。password 模式才需要 —— dev 模式信任 X-Username，没有"账号"这回事。
   * 首次启动把 CONSOLE_USERS 里的账号播种进去（已存在的不动）。
   */
  const users = config.auth.mode === 'password' ? createUserStore({ config, storage, groups, logger }) : null
  if (users) await users.seedFromEnv()

  const identity = createIdentityResolver({ config, logger, users })
  const workspace = createWorkspaceStore({ config, logger })
  // 技能管理面（改/删/停用）。没有用户工作空间时它整体是关的 —— 与 canCreate 同一个前提
  const skillManager = workspace.enabled
    ? createSkillManager({ workspace, logger })
    : createDisabledSkillManager()
  const sandbox = createSandbox({ config, logger })
  const metrics = createMetrics()
  /**
   * Token 用量台账。与 metrics 并存不是重复：metrics 是进程内的、看这一刻的健康度，
   * 这张台账落库、跨重启跨副本，回答的是"这个月谁烧了多少"（见文件头）。
   */
  const usage = createUsageStore({ storage, logger })

  /**
   * 结构化状态：全部按 username 分区，全部走同一个 storage 后端（MySQL）。
   *
   * 它们**不再各自决定存哪儿** —— 从前每个 store 自己拼路径、自己 writeAtomic，
   * 于是"接了数据库"这件事只完成了会话那一份，剩下几份仍然绑在本地盘上。
   */
  const memory = createMemoryStore({ config, storage, logger })
  const memoryCapture = createMemoryCapture({ memory, config, logger })
  const projects = createProjectStore({ config, storage, logger })
  const artifacts = createArtifactStore({ config, storage, logger })
  // 分享**依赖**作品而不是反过来：作品不知道自己被分享了也照样成立
  const shares = createShareStore({ config, storage, logger, artifacts })
  const crons = createCronStore({ config, storage, logger })
  const cronVault = createCronCredentialVault({ config, storage, logger })

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
  } else if (config.llm.mode === 'db') {
    broker = createDbBroker({ modelStore, users, logger })
    const count = await modelStore.count()
    if (!count) {
      logger.warn('LLM_MODE=db，但数据库里一个模型都没有：先在管理员控制台的「模型」页加一个，否则任何对话都会失败')
    }
    /**
     * 明文存 key 的部署要在启动日志里说一次 —— 与 cron 凭据金库同级的一道口子，
     * 只是这里的默认值更温和（那边是 error，因为存的是**用户的登录态**；
     * 这里存的是部署自己的 key，泄露的后果是被人白嫖模型，不是被人冒充用户）。
     */
    if (!config.llm.configSecret) {
      logger.warn('模型 Key 以明文存在数据库里：设 LLM_CONFIG_SECRET 可加密入库（AES-256-GCM）', { models: count })
    }
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
    memory, memoryCapture, projects, crons, artifacts, usage,
  })
  // 调度器要用 runService，所以只能排在它后面建
  const scheduler = createScheduler({ config, logger, crons, vault: cronVault, runService, sessionStore: store })
  const app = createServer({
    config, logger, identity, broker, runService, store, llmInfoClient, metrics, workspace, skillManager,
    memory, projects, crons, scheduler, cronVault, artifacts, shares, users, usage, modelStore, groups,
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
    storage: `mysql（${config.mysql.user}@${config.mysql.host}:${config.mysql.port}/${config.mysql.database}）`,
    memory: memory.enabled
      ? (memoryCapture.enabled
        ? `开（自动抓取：攒批 ${Math.round(config.memory.captureQuietMs / 1000)}s / ${config.memory.captureMaxTurns} 轮）`
        : '开（由模型经 memory 工具写入，不额外调模型）')
      : '关',
    projects: projects.enabled ? '开' : '关',
    artifacts: artifacts.enabled
      ? `开（预览外部源：${config.artifacts.allowedOrigins.length ? config.artifacts.allowedOrigins.join(' ') : '全部禁止'}）`
      : '关',
    artifactShare: shares.enabled ? `开（市场${shares.marketEnabled ? '开' : '关'}）` : '关',
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
  if (config.artifacts.allowedOrigins.length) {
    // 与 SANDBOX_INJECT_ME_TOKEN 同一类：这是在预览沙箱上开的一道口子，
    // 开了之后模型生成的页面就能往这些地址发请求（也就能把页面里的东西带出去）。
    // 不是不能开，是不能在日志里悄悄开。
    logger.warn('ARTIFACT_ALLOWED_ORIGINS 已配置：作品预览可以加载并连接这些外部源', {
      origins: config.artifacts.allowedOrigins,
    })
  }
  if (shares.enabled) {
    // 这是本服务唯一一条免鉴权的数据通道。它默认开着，所以更要在日志里说一句：
    // 运维得知道"链接一旦转发出去，拿到的人不需要账号也能看"。
    logger.info('作品分享已启用：作者生成的 /s/<token> 链接**免登录**即可访问', {
      市场: shares.marketEnabled ? '开（需作者显式发布）' : '关',
      关闭方式: 'ARTIFACT_SHARING_ENABLED=0',
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
    // 连接池最后关：上面那些 close 还可能在写最后几笔
    await storage.close?.()
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
