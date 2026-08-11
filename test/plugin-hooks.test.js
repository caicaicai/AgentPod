/**
 * 插件钩子（before_tool_call / after_tool_call）。
 *
 * 这组用例的由来是一个**静默失效**：兼容层的 SUPPORTED_EVENTS 声称支持这两个事件，
 * `createPluginApi` 也把 handler 收进了 Map，但 `loadPlugins` 只解构了
 * `{ api, collect }` —— handlers 掉在地上，全仓库没有任何派发点。
 * 插件作者看到的现象是"钩子注册成功了，就是从来不触发"，没有任何报错。
 *
 * 所以第一条用例直接盯着"注册了到底跑没跑"，剩下的盯着契约的三个分支：
 * 放行 / 改写入参 / 拦截。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { loadPlugins, applyToolHooks, hasToolHooks, jsonResult } from '../src/tools/plugin-api.js'
import { buildTools } from '../src/agent/tools.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

/** 最小工具上下文：钩子这层用不到凭据与出站 */
const ctx = { runId: 'r1', username: 'u1', logger: silentLogger, http: {}, credentialFacts: { present: false } }

/** 造一个会记录自己被调用时收到什么参数的工具 */
function echoTool(name = 'echo') {
  const calls = []
  const plugin = {
    id: `p-${name}`,
    register(api) {
      api.registerTool({
        name,
        description: 'echo',
        parameters: { type: 'object', properties: {} },
        async execute(_id, params) {
          calls.push(params)
          return jsonResult({ ok: true, got: params })
        },
      })
    },
  }
  return { plugin, calls }
}

const run = (tools, name, params) => tools.find((t) => t.name === name).execute('call-1', params)

describe('钩子真的会被派发', () => {
  test('注册的 before/after 都跑到了 —— 这条就是当初静默失效的那个洞', async () => {
    const seen = { before: [], after: [] }
    const { plugin } = echoTool()
    const hookPlugin = {
      id: 'observer',
      register(api) {
        api.on('before_tool_call', (event) => { seen.before.push(event.toolName) })
        api.on('after_tool_call', (event) => { seen.after.push({ tool: event.toolName, error: event.error }) })
      },
    }

    const { tools, hooks } = loadPlugins([plugin, hookPlugin], { ctx })
    assert.ok(hasToolHooks(hooks), 'loadPlugins 没有把 handler 带出来')

    const wrapped = applyToolHooks(tools, hooks, { logger: silentLogger })
    await run(wrapped, 'echo', { a: 1 })

    assert.deepEqual(seen.before, ['echo'])
    assert.deepEqual(seen.after, [{ tool: 'echo', error: null }])
  })

  test('一个插件的钩子对别的插件的工具同样生效', async () => {
    // openclaw 的 before_tool_call 是全局的：ap-skills 就是靠它否决 `browser`——
    // 一个它自己没注册过的工具。缩成"只管自己的工具"会悄悄改掉语义。
    const seen = []
    const a = echoTool('tool_a')
    const b = echoTool('tool_b')
    const observer = { id: 'observer', register(api) { api.on('before_tool_call', (e) => seen.push(e.toolName)) } }

    const { tools, hooks } = loadPlugins([a.plugin, b.plugin, observer], { ctx })
    const wrapped = applyToolHooks(tools, hooks, { logger: silentLogger })
    await run(wrapped, 'tool_a', {})
    await run(wrapped, 'tool_b', {})
    assert.deepEqual(seen, ['tool_a', 'tool_b'])
  })

  test('钩子覆盖沙盒内置工具（bash/read/write/edit），不只是插件工具', async () => {
    const seen = []
    const observer = { id: 'observer', register(api) { api.on('before_tool_call', (e) => seen.push(e.toolName)) } }
    const { hooks } = loadPlugins([observer], { ctx })

    const sandbox = {
      mode: 'http',
      async exec() { return { exitCode: 0, stdout: '', stderr: '' } },
      async getFile() { return { content: Buffer.from('') } },
    }
    const tools = buildTools({
      cwd: '/tmp/x',
      sandbox,
      runContext: { runId: 'r1', username: 'u1' },
      toolHooks: hooks,
      logger: silentLogger,
    })
    const names = tools.map((t) => t.name)
    assert.ok(names.includes('bash'), `没装上 bash：${names}`)
    // 只验证包装到位（bash 真跑要一整套沙盒），所以看的是"钩子被调用"这件事
    await tools.find((t) => t.name === 'bash').execute('c', { command: 'true' }).catch(() => {})
    assert.deepEqual(seen, ['bash'])
  })
})

describe('契约的三个分支', () => {
  test('返回 undefined = 放行，入参原样送到工具', async () => {
    const { plugin, calls } = echoTool()
    const noop = { id: 'noop', register(api) { api.on('before_tool_call', () => undefined) } }
    const { tools, hooks } = loadPlugins([plugin, noop], { ctx })
    await run(applyToolHooks(tools, hooks, { logger: silentLogger }), 'echo', { keep: 'me' })
    assert.deepEqual(calls, [{ keep: 'me' }])
  })

  test('返回 { params } = 改写入参（pi 原生 beforeToolCall 做不到这件事）', async () => {
    const { plugin, calls } = echoTool()
    const rewrite = {
      id: 'rewrite',
      register(api) {
        api.on('before_tool_call', (e) => ({ params: { ...e.params, injected: true } }))
      },
    }
    const { tools, hooks } = loadPlugins([plugin, rewrite], { ctx })
    await run(applyToolHooks(tools, hooks, { logger: silentLogger }), 'echo', { a: 1 })
    assert.deepEqual(calls, [{ a: 1, injected: true }])
  })

  test('两个改写钩子串联，后一个看到的是前一个的产物', async () => {
    const { plugin, calls } = echoTool()
    const mk = (id, key) => ({
      id, register(api) { api.on('before_tool_call', (e) => ({ params: { ...e.params, [key]: true } })) },
    })
    const { tools, hooks } = loadPlugins([plugin, mk('h1', 'first'), mk('h2', 'second')], { ctx })
    await run(applyToolHooks(tools, hooks, { logger: silentLogger }), 'echo', {})
    assert.deepEqual(calls, [{ first: true, second: true }])
  })

  test('返回 { block } = 工具不执行，且以错误形式抛出', async () => {
    // 用 throw 而不是返回一个普通结果：pi 会把 execute 抛出的错变成 isError:true
    // 的工具结果。返回普通结果的话，模型多半会当成执行成功了。
    const { plugin, calls } = echoTool()
    const veto = {
      id: 'veto',
      register(api) {
        api.on('before_tool_call', (e) => (e.toolName === 'echo' ? { block: true, blockReason: '这个环境不许用 echo' } : undefined))
      },
    }
    const { tools, hooks } = loadPlugins([plugin, veto], { ctx })
    const wrapped = applyToolHooks(tools, hooks, { logger: silentLogger })

    await assert.rejects(() => run(wrapped, 'echo', {}), /这个环境不许用 echo/)
    assert.deepEqual(calls, [], '被拦截的调用不该真的执行')
  })

  test('block 没给 reason 时也要说清是谁拦的', async () => {
    const { plugin } = echoTool()
    const veto = { id: 'ap-skills', register(api) { api.on('before_tool_call', () => ({ block: true })) } }
    const { tools, hooks } = loadPlugins([plugin, veto], { ctx })
    await assert.rejects(
      () => run(applyToolHooks(tools, hooks, { logger: silentLogger }), 'echo', {}),
      /ap-skills/,
    )
  })
})

describe('钩子出问题不该带走整轮对话', () => {
  test('before 钩子抛错 = 跳过它，工具照常执行', async () => {
    const warns = []
    const logger = { ...silentLogger, warn: (msg, meta) => warns.push({ msg, meta }) }
    const { plugin, calls } = echoTool()
    const boom = { id: 'boom', register(api) { api.on('before_tool_call', () => { throw new Error('钩子自己炸了') }) } }

    const { tools, hooks } = loadPlugins([plugin, boom], { ctx })
    const result = await run(applyToolHooks(tools, hooks, { logger }), 'echo', { a: 1 })

    assert.deepEqual(calls, [{ a: 1 }], '一个打日志的钩子不该有能力让所有工具挂掉')
    assert.ok(result.content, '工具结果应当正常返回')
    assert.equal(warns.length, 1, '但必须留下痕迹')
    assert.equal(warns[0].meta.plugin, 'boom', '要说清是哪个插件的钩子')
  })

  test('after 钩子抛错也一样', async () => {
    const warns = []
    const logger = { ...silentLogger, warn: (msg, meta) => warns.push({ msg, meta }) }
    const { plugin } = echoTool()
    const boom = { id: 'boom', register(api) { api.on('after_tool_call', () => { throw new Error('炸') }) } }
    const { tools, hooks } = loadPlugins([plugin, boom], { ctx })
    const result = await run(applyToolHooks(tools, hooks, { logger }), 'echo', {})
    assert.ok(result.content)
    assert.equal(warns.length, 1)
  })

  test('工具自己失败时 after 钩子也收得到 —— 桌面端靠它统计失败率', async () => {
    const seen = []
    const failing = {
      id: 'failing',
      register(api) {
        api.registerTool({
          name: 'boom', description: '', parameters: { type: 'object', properties: {} },
          async execute() { throw new Error('上游 500') },
        })
        api.on('after_tool_call', (e) => seen.push(e.error))
      },
    }
    const { tools, hooks } = loadPlugins([failing], { ctx })
    await assert.rejects(() => run(applyToolHooks(tools, hooks, { logger: silentLogger }), 'boom', {}))
    assert.deepEqual(seen, ['上游 500'])
  })
})

describe('不支持的事件要明说', () => {
  test('订阅 before_agent_start 会 warn，而不是假装收下', async () => {
    const warns = []
    const logger = { ...silentLogger, warn: (msg, meta) => warns.push({ msg, meta }) }
    const localCtx = { ...ctx, logger }
    const p = { id: 'kb', register(api) { api.on('before_agent_start', () => {}) } }

    const { hooks } = loadPlugins([p], { ctx: localCtx })
    assert.equal(hasToolHooks(hooks), false)
    assert.equal(warns.length, 1)
    assert.deepEqual(warns[0].meta.supported, ['before_tool_call', 'after_tool_call'])
  })

  test('没有钩子时 applyToolHooks 原样返回，不白套一层闭包', () => {
    const { plugin } = echoTool()
    const { tools, hooks } = loadPlugins([plugin], { ctx })
    assert.equal(applyToolHooks(tools, hooks, { logger: silentLogger }), tools)
  })
})
