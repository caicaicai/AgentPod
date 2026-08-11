/**
 * openclaw 插件 API 兼容层。
 *
 * 桌面端的扩展都长这样：
 *
 *   const plugin = { id, register(api) { api.registerTool({ name, label, description, parameters, execute }) } }
 *
 * 而 pi 要的是 `ToolDefinition[]`。两者差别很小 —— openclaw 的插件 API 本来就是
 * pi ToolDefinition 的薄封装 —— 所以与其把每个扩展改写一遍，不如做一层薄适配：
 * 扩展的注册代码原样保留，改的只有"凭据从哪来"。
 *
 * 与桌面 api 的差异（都是共享进程的必然要求）：
 *   api.http    新增。取代 process.env 凭据：已绑定该 run 用户，出站经统一 egress
 *   api.ctx     新增。run 上下文（username/runId/credentialFacts）
 *   api.on      只支持工具相关的少数事件；通道/cron 类事件云端归控制面，不在这里
 *   api.config  只读快照，不是可写的全局配置
 *
 * 返回值形状两端都兼容：pi 要 `{content:[...], details}`，而仓库里的扩展有的返回
 * `{type:'text', text}`（ap-skills 自己的 jsonResult），这里统一归一化。
 */

/** openclaw / pi 两种工具返回形状 → pi 的 AgentToolResult */
export function normalizeToolResult(result) {
  if (result && Array.isArray(result.content)) return result // 已经是 pi 形状
  if (result && result.type === 'text') {
    return { content: [{ type: 'text', text: String(result.text ?? '') }], details: result.details }
  }
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }], details: undefined }
  return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }], details: result }
}

/** 与 openclaw `jsonResult` 等价，供移植过来的工具直接用 */
export function jsonResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload }
}

/** 与 openclaw `textResult` 等价 */
export function textResult(text, details) {
  return { content: [{ type: 'text', text: String(text ?? '') }], details }
}

/**
 * 云端真的会派发的事件。**加进这个集合之前先去 applyToolHooks 里加派发**，
 * 否则就回到了这一层曾经犯过的错：`on()` 收下 handler、`loadPlugins` 把它丢掉，
 * 插件作者看不出自己的钩子从没跑过。
 *
 * 桌面端另外还有 before_agent_start / llm_input / llm_output / agent_end /
 * before_message_write / gateway_start。它们在云端各有去处，但**都不在这里**：
 *
 *   before_agent_start   → 往系统提示注入：DefaultResourceLoader 的 appendSystemPrompt
 *   llm_* / agent_end    → 只观察：session.subscribe（run-turn.js 已经在用）
 *   before_message_write → 无对应物，会话回写归 src/session，不开放给插件
 *   gateway_start        → 云端没有 gateway；启动期的事归控制面
 */
const SUPPORTED_EVENTS = new Set(['before_tool_call', 'after_tool_call'])

/**
 * 造一个绑定到本次 run 的插件 API，并收集它注册的工具。
 * @returns {{api: object, collect: () => Array, handlers: Map}}
 */
export function createPluginApi({ ctx, config = {} }) {
  const tools = []
  const handlers = new Map()

  const api = {
    ctx,
    http: ctx.http,
    logger: ctx.logger,
    config,

    registerTool(definition) {
      if (!definition?.name) throw new Error('registerTool 缺少 name')
      if (typeof definition.execute !== 'function') throw new Error(`工具 ${definition.name} 缺少 execute`)

      tools.push({
        name: definition.name,
        label: definition.label || definition.name,
        description: definition.description || '',
        parameters: definition.parameters || { type: 'object', properties: {}, required: [] },
        // pi 的签名是 (toolCallId, params, signal, onUpdate, toolCtx)，
        // openclaw 扩展只用前两个 —— 位置完全对得上，所以原样透传。
        async execute(toolCallId, params, signal, onUpdate, toolCtx) {
          const result = await definition.execute(toolCallId, params, signal, onUpdate, toolCtx)
          return normalizeToolResult(result)
        },
      })
    },

    on(event, handler) {
      if (!SUPPORTED_EVENTS.has(event)) {
        // 明确说不支持，而不是静默丢掉 —— 静默丢掉会让人以为钩子生效了
        ctx.logger.warn?.('插件订阅了云端不支持的事件，已忽略', { event, supported: [...SUPPORTED_EVENTS] })
        return
      }
      const list = handlers.get(event) || []
      list.push(handler)
      handlers.set(event, list)
    },
  }

  return { api, collect: () => tools, handlers }
}

/**
 * 装载一批 openclaw 形态的插件，产出 pi 工具集 + 钩子。
 * @param {Array<{id: string, register: (api) => void}>} plugins
 * @returns {{tools: Array, hooks: {before_tool_call: Array, after_tool_call: Array}}}
 */
export function loadPlugins(plugins, { ctx, config = {} }) {
  const tools = []
  const hooks = { before_tool_call: [], after_tool_call: [] }

  for (const plugin of plugins) {
    const { api, collect, handlers } = createPluginApi({ ctx, config })
    try {
      plugin.register(api)
      tools.push(...collect())
      // 记住是哪个插件注册的：钩子出问题时，日志里只有 "before_tool_call 抛错"
      // 是查不下去的 —— 钩子对所有工具生效，嫌疑范围是全部插件。
      for (const [event, list] of handlers) {
        for (const handler of list) hooks[event].push({ plugin: plugin?.id || '(匿名)', handler })
      }
    } catch (error) {
      // 一个插件塌了不该把整轮对话带走，但必须留下痕迹
      ctx.logger.error?.('插件装载失败，已跳过', { plugin: plugin?.id, err: error?.message })
    }
  }
  return { tools, hooks }
}

/** 钩子一个都没有时，别去包装工具 —— 白套一层闭包 */
export function hasToolHooks(hooks) {
  return Boolean(hooks?.before_tool_call?.length || hooks?.after_tool_call?.length)
}

/**
 * 把插件钩子套到工具上。
 *
 * ── 为什么是包 execute，而不是用 pi 原生的 beforeToolCall ──────────────
 *
 * pi 确实有原生钩子（`pi-agent-core` 的 `beforeToolCall` / `afterToolCall`），
 * 但 `createAgentSession` 没把它们透出来，要用就得像 `installRetryPolicy` 那样
 * 去够 session 内部。而且 pi 的 `beforeToolCall` **只能拦截、不能改写入参**，
 * openclaw 的契约里 `{ params }` 改写是有人用的（channel 就靠它规范 cron 入参）。
 *
 * 包 execute 则两件事一起解决，且不依赖 pi 的任何内部结构。覆盖面也是全的：
 * `noTools:'builtin'` 意味着这一轮的**每个**工具都出自我们的 buildTools()。
 *
 * ── 三条刻意的取舍 ────────────────────────────────────────────────────
 *
 * 1. **钩子抛错不带走这次工具调用**，只记一条 warn 就跳过。一个用来打日志的钩子
 *    不该有能力让所有工具挂掉。
 * 2. **block 用 throw 表达。** pi 捕获 execute 抛出的错并生成 `isError: true`
 *    的工具结果（agent-loop.js 的 executePreparedToolCall），正是"这次调用被拒绝"
 *    该有的语义。返回一个普通结果的话，模型多半会当成执行成功了。
 * 3. **after_tool_call 只观察。** openclaw 那边它就没有返回值语义，
 *    这里也不给 —— 凭空发明一套"云端能改结果、桌面端不能"只会让扩展两端行为不一致。
 *
 * ⚠️ **钩子里不许记 params 和结果。** 桌面端的 chat 就是
 * `JSON.stringify(event.params).slice(0, 200)` 直接进日志的写法，那是用户数据
 * （邮件内容、文档正文、搜索词都从这儿过）。移植时把它删掉，只留工具名和耗时。
 */
export function applyToolHooks(tools, hooks, { logger } = {}) {
  if (!hasToolHooks(hooks)) return tools
  const before = hooks.before_tool_call || []
  const after = hooks.after_tool_call || []

  return tools.map((tool) => {
    const original = tool.execute
    if (typeof original !== 'function') return tool

    return {
      ...tool,
      async execute(toolCallId, params, signal, onUpdate, toolCtx) {
        let effective = params

        for (const { plugin, handler } of before) {
          let outcome
          try {
            outcome = await handler({ toolName: tool.name, params: effective })
          } catch (error) {
            logger?.warn?.('before_tool_call 钩子抛错，已跳过该钩子', {
              plugin, tool: tool.name, err: error?.message,
            })
            continue
          }
          if (!outcome) continue
          if (outcome.block) {
            logger?.info?.('工具调用被插件拦截', { plugin, tool: tool.name })
            throw new Error(outcome.blockReason || `工具 ${tool.name} 被 ${plugin} 拦截，未执行`)
          }
          // 只认对象。返回 `{params: null}` 时保持原样，而不是把 null 传给工具
          if (outcome.params && typeof outcome.params === 'object') effective = outcome.params
        }

        const startedAt = Date.now()
        const notifyAfter = (error) => {
          for (const { plugin, handler } of after) {
            try {
              handler({ toolName: tool.name, error: error || null, durationMs: Date.now() - startedAt })
            } catch (hookError) {
              logger?.warn?.('after_tool_call 钩子抛错，已忽略', {
                plugin, tool: tool.name, err: hookError?.message,
              })
            }
          }
        }

        try {
          const result = await original.call(tool, toolCallId, effective, signal, onUpdate, toolCtx)
          notifyAfter(null)
          return result
        } catch (error) {
          // 工具自己失败时 after 钩子也要收到 —— 桌面端就是靠它统计失败率的
          notifyAfter(error?.message || String(error))
          throw error
        }
      },
    }
  })
}
