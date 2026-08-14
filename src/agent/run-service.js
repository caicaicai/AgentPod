/**
 * Run 服务：并发预算、每用户配额、活跃 run 登记、任务台账钩子。
 *
 * 为什么单独一层：HTTP 只是入口之一，后面还有定时任务、京ME 通道、OpenAPI。
 * 它们都要走同一套配额与台账，不能各写一遍。
 */
import { randomUUID } from 'node:crypto'

import { Errors } from '../errors.js'
import { isAbnormalStop } from '../stop-reason.js'
import { runTurn } from './run-turn.js'
import { buildSandboxCredentialEnv } from './sandbox-credentials.js'
import { loadSkills, describeSkills, selectSkills } from './skills.js'
import { buildModel, pickModel } from '../models/model-factory.js'
import { buildApTools } from '../tools/index.js'
import { memoryPrompt } from '../memory/capture.js'
import { projectPrompt } from '../projects/store.js'
import { generateTitle } from '../sessions/title.js'

export function createRunService({
  config, logger, store, sandbox, broker, metrics, workspace = null,
  skillManager = null, memory = null, memoryCapture = null, projects = null, crons = null,
  artifacts = null, usage = null,
}) {
  const active = new Map() // runId -> { username, abort, startedAt, source }
  const perUser = new Map() // username -> count

  /**
   * 技能在启动时读一次，不是每 run 读一遍：SKILL_DIRS 指向的是随镜像发布的只读资产，
   * 每轮重扫一遍磁盘只是白白的 IO。真正每 run 要做的是把它们铺进沙盒（见 skill-materializer.js）。
   */
  const skillDirs = config.skills?.dirs || []
  const { skills } = loadSkills({ dirs: skillDirs, logger })
  if (skills.length) {
    logger.info('已装载技能', { count: skills.length, names: skills.map((s) => s.name) })
  } else if (skillDirs.length) {
    // 配了目录却一个都没读到，多半是路径写错或 frontmatter 缺 description（pi 会跳过）。
    // 这种情况必须吵一声：表现出来只是"模型不知道有这个技能"，不会有任何报错。
    logger.warn('配置了 SKILL_DIRS 但没读到任何技能', { dirs: skillDirs })
  }

  /**
   * 个人技能：从共享盘上这个用户自己的目录里读。
   *
   * 与平台技能的区别只有"读的时机"：平台技能随镜像发布、不因人而异，启动读一次；
   * 个人技能因人而异，只能每轮按 username 解析。目录不存在是正常情况（新用户）。
   *
   * 读的是磁盘，所以搬进沙盒那条路一个字都不用改 —— `collectSkillFiles`
   * 本来就是从本地目录走 `baseDir`，共享盘对它来说就是本地目录。
   */
  function personalSkills(username) {
    if (!workspace?.enabled) return []
    try {
      const { skills: mine } = loadSkills({ dirs: workspace.skillDirs(username), logger })
      return mine
    } catch (error) {
      // 读不到个人技能不该让整轮跑不起来：平台技能还在，降级继续
      logger.warn('个人技能装载失败，本轮只用平台技能', { username, err: error?.message })
      return []
    }
  }

  /**
   * 平台技能 + 个人技能，**按名字去重，个人的赢**。
   *
   * 不能简单拼接：技能名同时是沙盒里的目录名（`skills/<name>/`）和系统提示里
   * 的标识。重名的话，提示里会出现两条同名条目让模型无从选择，而沙盒里两份
   * 文件会推到同一个目录互相覆盖 —— 最后跑的是哪一份取决于推送顺序。
   * 与其依赖这种隐式行为，不如明确定下"你自己的覆盖平台的"。
   */
  function mergeSkills(platform, personal, runLogger) {
    if (!personal.length) return platform
    const mine = new Set(personal.map((skill) => skill.name))
    const shadowed = platform.filter((skill) => mine.has(skill.name)).map((skill) => skill.name)
    if (shadowed.length) runLogger.debug?.('个人技能覆盖了同名平台技能', { skills: shadowed })
    return [...platform.filter((skill) => !mine.has(skill.name)), ...personal]
  }

  /**
   * 撤下这个用户停用的技能。
   *
   * 用 `selectSkills` 的 allowlist 而不是在这里 filter：那个函数本来就是为这件事
   * 写的，之前一直没人用。allowlist 语义是"传数组才生效"，所以没停用任何技能时
   * 传 undefined —— 与"停用了全部"（传空数组）区分得开。
   *
   * 读不到停用清单时**不撤任何技能**：把技能全关掉比多显示一个更糟。
   */
  async function applyDisabled(list, username, runLogger) {
    if (!skillManager?.enabled || !list.length) return list
    let disabled
    try {
      disabled = await skillManager.disabledNames(username)
    } catch (error) {
      runLogger.warn?.('读不到技能停用清单，本轮不做过滤', { username, err: error?.message })
      return list
    }
    if (!disabled.size) return list
    const allowlist = list.filter((skill) => !disabled.has(skill.name)).map((skill) => skill.name)
    if (allowlist.length !== list.length) {
      runLogger.debug?.('已按用户设置撤下技能', { username, count: list.length - allowlist.length })
    }
    return selectSkills({ skills: list, allowlist })
  }

  /**
   * 这一轮该带哪些上下文：项目指令 + 长期记忆。
   *
   * 会话归属哪个项目是**存储说了算**（会话 meta 上的 projectId），只有新会话才认
   * 请求里带来的 projectId —— 否则前端一个参数就能把一条老会话搬进别的项目，
   * 而那会连带改变它每轮看到的指令。
   *
   * 整段都包在 try 里：记忆读不出来不该让对话跑不起来。降级的表现是"这轮它不记得
   * 我是谁"，比"发不出消息"轻得多。
   */
  async function buildContext({ username, sessionKey, requestedProjectId }) {
    const prompts = []
    let projectId = ''
    // 起标题只在会话的第一轮做一次。判据就在这儿：这次跑之前存储里还没有它。
    // **不能事后判**（跑完它一定存在了），所以顺着这次已经发生的 load 一起带出去
    let isNew = false
    try {
      const existing = await store.load({ username, sessionKey })
      isNew = !existing
      projectId = existing ? String(existing.projectId || '') : String(requestedProjectId || '')

      let project = null
      if (projectId && projects?.enabled) {
        project = await projects.get({ username, projectId })
        // 项目被删了：会话上的 projectId 成了悬空引用，当作没有项目处理
        if (!project) projectId = ''
        else {
          const instructions = projectPrompt(project)
          if (instructions) prompts.push(instructions)
        }
      }

      if (memory?.enabled) {
        const personal = await memory.recall({ username })
        const projectMemory = projectId ? await memory.recall({ username, projectId }) : ''
        const block = memoryPrompt({
          personal,
          project: projectMemory,
          projectName: project?.name || '',
          /**
           * 没开自动抓取（默认）时，把"这份记忆归你管"讲给模型听。
           * 不讲的话关掉自动抓取就等于把记忆写入整个关掉了 —— 模型不会主动调。
           */
          curator: !memoryCapture?.enabled,
        })
        if (block) prompts.push(block)
      }
    } catch (error) {
      logger.warn('上下文装配失败，本轮不带项目与记忆', { username, sessionKey, err: error?.message })
    }
    return { prompts, projectId, isNew }
  }

  function snapshot() {
    return {
      activeRuns: active.size,
      budget: config.limits.maxConcurrentRuns,
      perUserLimit: config.limits.maxRunsPerUser,
      users: [...perUser.entries()].map(([username, count]) => ({ username, count })),
    }
  }

  function acquire(username) {
    if (active.size >= config.limits.maxConcurrentRuns) {
      throw Errors.busy(`本副本并发已满（${active.size}/${config.limits.maxConcurrentRuns}），请稍后重试`)
    }
    const used = perUser.get(username) || 0
    if (used >= config.limits.maxRunsPerUser) {
      throw Errors.busy(`你已有 ${used} 个进行中的任务，请等其中一个结束`)
    }
    perUser.set(username, used + 1)
  }

  function release(username, runId) {
    active.delete(runId)
    const left = (perUser.get(username) || 1) - 1
    if (left <= 0) perUser.delete(username)
    else perUser.set(username, left)
  }

  return {
    snapshot,

    /**
     * 技能清单，给界面展示用。
     *
     * 注意它回的是"本实例装载了什么"，不是"这一轮模型能用什么" —— 没有沙盒时
     * runTurn 会把技能全部撤下（见 run-turn.js 的 usableSkills）。所以调用方
     * 要连 sandboxMode 一起看，否则会出现"界面上列着一排技能、模型却说不知道"。
     */
    async listSkills({ username } = {}) {
      const platform = describeSkills(skills).map((skill) => ({ ...skill, scope: 'platform' }))
      if (!username) return platform.map((skill) => ({ ...skill, enabled: true }))

      const all = [
        ...platform,
        ...describeSkills(personalSkills(username)).map((skill) => ({ ...skill, scope: 'personal' })),
      ]
      /**
       * `enabled` 必须跟着清单一起回。界面上要画开关，而"这个技能开着没有"
       * 只有服务端知道 —— 让前端自己去另一个接口拼，两处状态迟早对不上。
       */
      let disabled = new Set()
      try {
        if (skillManager?.enabled) disabled = await skillManager.disabledNames(username)
      } catch (error) {
        logger.warn('读不到技能停用清单，清单里一律按启用展示', { username, err: error?.message })
      }
      return all.map((skill) => ({ ...skill, enabled: !disabled.has(skill.name) }))
    },

    abort({ runId, username }) {
      const entry = active.get(runId)
      if (!entry) throw Errors.notFound('run 不存在或已结束')
      // 不许中止别人的 run
      if (entry.username !== username) throw Errors.forbidden('无权中止其他用户的任务')
      entry.abort()
      return { ok: true }
    },

    /**
     * 执行一轮。调用方通过 onFrame 拿流式事件。
     * @param {object} params
     * @param {{username: string, credential: string}} params.subject 服务端校验过的主体
     */
    async execute({
      subject, sessionKey = 'main', prompt, attachments = [], modelId, projectId = '',
      source = 'api', onFrame = () => {},
    }) {
      const { username } = subject
      const runId = `run_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
      const runLogger = logger.child({ runId, username, source })

      acquire(username)
      active.set(runId, { username, abort: () => {}, startedAt: Date.now(), source })

      const startedAt = Date.now()
      try {
        onFrame('run_start', { runId, sessionKey })

        const access = await broker.getLlmAccess(subject)
        const llm = pickModel(access.models, modelId)
        if (!llm) {
          /**
           * 空清单的原因随 LLM_MODE 而不同，报错也要跟着不同 ——
           * db 模式下说"平台没有返回可用模型"会把管理员支到一个根本没在用的
           * 上游去查，而真正要做的只是在控制台里加一个模型、或者把它开给这个分组。
           */
          const emptyReason = config.llm?.mode === 'db'
            ? '你所在的分组没有可用模型，请让管理员在控制台的「模型」页配置'
            : '平台没有返回可用模型'
          throw Errors.badRequest(
            modelId ? `模型 ${modelId} 不在你可用的清单里` : emptyReason,
            { available: access.models.map((m) => m.model) },
          )
        }
        const model = buildModel(llm, {
          imageCapableModels: config.llm?.imageCapableModels || [],
          /**
           * 单条记录上的设置**盖过全局的那个环境变量**：db 模式下一个部署可以同时
           * 接好几个上游，而 max_tokens / max_completion_tokens 这件事恰恰是**按上游
           * 不同**的（老 schema 的只认前者）。全局开关在那种部署里必然有一半是错的。
           */
          maxTokensField: llm.maxTokensField || config.llm?.maxTokensField || '',
        })
        onFrame('model', { id: model.id, baseUrl: model.baseUrl, contextWindow: model.contextWindow, stale: access.stale })

        // 沙盒会话在这里创建而不是在 runTurn 里：工具（如 workstation_browser）也要用它，
        // 两边必须是同一个租约，否则浏览器开在一个副本、bash 跑在另一个副本上。
        // 租约仍然是懒申请的，真正用到才占槽位；释放由 runTurn 的 finally 负责。
        const sandboxSession = sandbox?.createSession ? sandbox.createSession({ runId, username }) : sandbox

        /**
         * 项目指令与长期记忆。
         *
         * 必须排在 buildApTools **之前**：memory 工具要知道本轮属于哪个项目
         * （决定它读写哪一份 MEMORY.md），而那个 projectId 正是这里算出来的。
         */
        const context = await buildContext({ username, sessionKey, requestedProjectId: projectId })

        // 移植过来的 AP 工具：闭包里绑本 run 的上下文，凭据取不出来（见 src/tools/context.js）
        const { tools: apTools, skipped, hooks: toolHooks } = buildApTools({
          runId,
          username,
          credential: subject.credential || '',
          logger: runLogger,
          sandboxSession,
          workspace,
          memory,
          crons,
          artifacts,
          projectId: context.projectId,
          // 作品挂在会话下，所以 sessionKey 必须一路带到工具上下文里
          sessionKey,
          config: {
            browserCookieDomains: config.sandbox?.browserCookieDomains || ['.xiaocaicai.com'],
            imageCapable: (model.input || []).includes('image'),
            webSearch: config.webSearch,
            // 预览 iframe 允许的外部源。工具描述要照着它告诉模型"能不能用 CDN"，
            // 说错了模型会产出一个在预览里必然白屏的页面
            artifacts: { allowedOrigins: config.artifacts?.allowedOrigins || [] },
          },
        })
        if (skipped.length) runLogger.debug('部分 AP 工具未启用', { skipped })

        /**
         * 起标题，**与本轮并行**。
         *
         * 不排在 runTurn 后面，是因为那样它的耗时会实打实地加在用户等待上 ——
         * memory capture 曾经就是这么干的，实测让界面在模型答完之后又转 4.3 秒。
         * 而标题只需要用户的第一句话，本来就不必等回复。等这一轮跑完时，
         * 它早就回来了，`await` 基本是零成本。
         *
         * 只在会话第一轮做一次；失败一律回空串，退回 runTurn 里那个截断标题。
         */
        const titling = context.isNew && config.sessions?.autoTitle !== false && config.llm?.mode !== 'faux'
          ? generateTitle({ model, apiKey: llm.key || access.apiKey, prompt, logger: runLogger })
          : null

        const result = await runTurn({
          runId,
          username,
          sessionKey,
          prompt,
          attachments,
          model,
          apTools,
          toolHooks,
          apiKey: llm.key || access.apiKey,
          store,
          sandbox: sandboxSession,
          sandboxCredentialEnv: buildSandboxCredentialEnv({
            credential: subject.credential || '',
            // `?.` 不是防御性冗余：测试里的 config 是手搭的局部对象，没有 sandbox 段。
            // 缺了就是"没开"，与 config.js 的默认值一致 —— 往安全那一侧倒。
            injectMeToken: config.sandbox?.injectMeToken === true,
          }),
          skillLibsDir: config.skills.libsDir,
          skills: await applyDisabled(mergeSkills(skills, personalSkills(username), runLogger), username, runLogger),
          contextPrompts: context.prompts,
          workspace,
          /**
           * 一轮结束后要不要驻留沙盒（见 docs/SANDBOX-LIFECYCLE.md）。
           *
           * **定时任务一律不驻留**：它没有"下一轮"——下一次触发是几小时后，
           * 那时驻留窗口早过了，留下来的只是一个白占槽位到超时的 slot。
           * 驻留是为交互式会话设计的，判据里必须有这一条。
           */
          parkPolicy: source === 'cron' ? 'off' : (config.sandbox?.park || 'off'),
          timeoutMs: config.limits.runTimeoutMs,
          // `?.` 不是防御性冗余：测试里的 config 是手搭的局部对象，没有 llm 段。
          // 缺了就走 runTurn 签名上的默认值（与 config.js 的默认值一致）。
          retry: config.llm?.retry,
          logger: runLogger,
          // 截断这类问题在服务端也要留痕：等用户来报"助手变笨了"太晚了，
          // 而且他们没法把 stopReason 描述出来。只记原因，不记任何正文。
          onFrame: (type, data) => {
            if (type === 'text_end' && isAbnormalStop(data?.stopReason)) {
              runLogger.warn('模型输出非正常结束', {
                stopReason: data.stopReason,
                model: model.id,
                /**
                 * 网关回的原文要留下来 —— 排查 `400 模型服务调用失败` 这类问题时，
                 * 光有 stopReason 说明不了任何事。截断是因为有些网关会在错误体里
                 * 回显部分请求内容，那属于用户数据，不该整段进日志。
                 *
                 * 真正完整的上游错误在后端：workers/llm.lua 的
                 * `ctx.log.error("LLM Server Error: ...")`，以及 llm_requests
                 * 表的 error_message 字段（GET /api/llm/admin/requests 可查）。
                 */
                err: String(data.errorMessage || '').slice(0, 300),
              })
            }
            if (type === 'retry' && data?.state === 'start') {
              runLogger.warn('模型调用失败，退避重试', {
                attempt: data.attempt, maxAttempts: data.maxAttempts, delayMs: data.delayMs, model: model.id,
              })
            }
            onFrame(type, data)
          },
          onStart: ({ abort }) => {
            const entry = active.get(runId)
            if (entry) entry.abort = abort
          },
        })

        /**
         * 标题落库要排在 final **之前**：前端收到 final 就会去刷会话列表，
         * 晚一步的话侧栏上会先闪一下截断标题，过一会儿才变 —— 而这一下闪动
         * 看起来就像"标题被改错了又改回来"。
         */
        let title = ''
        if (titling) {
          title = await titling
          if (title) {
            await store.patch?.({ username, sessionKey, title })?.catch?.((error) => {
              runLogger.warn('标题落库失败，保留截断标题', { err: error?.message })
            })
            runLogger.debug('已为新会话起标题', { sessionKey })
          }
        }

        metrics?.recordRun({ username, source, status: 'ok', durationMs: result.durationMs, usage: result.usage, modelId: model.id })
        /**
         * 落一行 token 用量台账（管理台按人看用量要的就是它）。
         *
         * **不 await**：这是一条 INSERT，本身很快，但它排在 `final` 帧之前 ——
         * await 了就等于把库的抖动直接加到用户看到答案的时延上。`record` 自己
         * 永不抛（见 telemetry/usage-store.js），所以这里也不需要 catch。
         *
         * 代价说清楚：进程在这一瞬间被 kill，这一行账会丢。可归因的账不等于账单，
         * 计费的真源在模型网关那边（llm_requests 表）；这张表是**给管理员看趋势**的。
         */
        usage?.record({
          username,
          runId,
          source,
          modelId: model.id,
          input: result.usage?.input,
          output: result.usage?.output,
          cacheRead: result.usage?.cacheRead,
          durationMs: result.durationMs,
        })
        runLogger.info('run 完成', {
          durationMs: result.durationMs,
          entryCount: result.entryCount,
          model: model.id,
          usageInput: result.usage.input,
          usageOutput: result.usage.output,
        })
        onFrame('final', {
          runId,
          text: result.finalText,
          entryCount: result.entryCount,
          sessionId: result.sessionId,
          usage: result.usage,
          // 本轮耗时与工具调用次数，给界面显示。与刷新后历史里的那份**同源同算法**
          // （见 sessions/transcript.js 的 attachTurnStats），所以刷新前后一定一致。
          turnStats: result.turnStats,
          // 新会话这一轮起的标题（没起成就是空串）。界面照常会去刷会话列表，
          // 带上它是给 OpenAPI 这类拿不到列表的调用方看的
          title,
        })

        /**
         * 会话归入项目。
         *
         * 必须排在 runTurn **之后**：会话的 meta 是 store.save 在那一轮末尾才建出来的，
         * 提前 patch 会打在一条还不存在的记录上（返回 null，静默什么都没发生）。
         */
        if (context.projectId && store.patch) {
          await store.patch({ username, sessionKey, projectId: context.projectId }).catch((error) => {
            runLogger.warn('会话归入项目失败', { projectId: context.projectId, err: error?.message })
          })
        }

        /**
         * 自动抓记忆（默认**关**，写记忆走 memory 工具）。
         *
         * `onTurnEnd` 是同步的：它只把这一轮塞进攒批缓冲、重排一个定时器，
         * 真正的抓取跑在请求之外。**不要给它加 await** —— 从前这里 await 了
         * 一整次模型调用，实测让界面在模型答完之后又转 4.3 秒，还白占着
         * 这个用户的并发名额（release 在下面的 finally 里）。
         */
        if (memoryCapture?.enabled) {
          try {
            memoryCapture.onTurnEnd({
              username,
              projectId: context.projectId,
              input: prompt,
              reply: result.finalText,
              model,
              apiKey: llm.key || access.apiKey,
            })
          } catch (error) {
            runLogger.debug('记忆入队异常', { err: error?.message })
          }
        }

        return result
      } catch (error) {
        const durationMs = Date.now() - startedAt
        metrics?.recordRun({ username, source, status: error.code || 'ERROR', durationMs })
        runLogger.warn('run 失败', { code: error.code, message: error.message, durationMs })
        onFrame('error', { runId, code: error.code || 'INTERNAL', message: error.message, retryable: Boolean(error.retryable) })
        throw error
      } finally {
        release(username, runId)
      }
    },
  }
}
