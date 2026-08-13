/**
 * 系统提示里的工作区约定。
 *
 * ── 这条测试守的是一次真实故障 ──────────────────────────────────────
 *
 * pi 的 buildSystemPrompt 在提示**末尾**（最显眼的位置）追加：
 *
 *     Current working directory: /var/folders/w9/.../ap-run-xxx/workspace
 *
 * 那是 agent 侧 mkdtemp 出来的临时目录，沙盒里不存在。线上会话里模型照着它办事：
 * `write` 到该绝对路径（pi 原样回显，看着成功），然后 `bash` 里 `cd` 过去 ——
 * No such file or directory；再 `pwd` 拿到 `/sandbox-root/work` 改用真路径，
 * 又被 toWorkspaceRelative 拒掉。5 次工具调用，模型全程没做错任何事。
 *
 * 单测 workspacePrompt() 的返回值没有意义 —— 那只证明函数会拼字符串。
 * 这里跑**真的一轮** runTurn，把模型实际收到的 systemPrompt 抓出来断言。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { registerFauxProvider, fauxAssistantMessage } from '@mariozechner/pi-ai'

import { runTurn } from '../src/agent/run-turn.js'
import { createMemorySessionStore as createMemoryStore } from './helpers/memory-session-store.js'
import { buildModel } from '../src/models/model-factory.js'
import { SANDBOX_WORKSPACE_ROOT } from '../src/agent/sandbox-files.js'

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }

describe('工作区约定进了系统提示（跑真的一轮）', () => {
  let faux
  let model

  before(() => {
    faux = registerFauxProvider({
      api: 'openai-completions',
      provider: 'ap-gateway',
      models: [{ id: 'test-model', name: 'test', contextWindow: 100000, maxTokens: 2048 }],
      tokensPerSecond: 100000,
    })
    model = buildModel({ model: 'test-model', server: faux.getModel().baseUrl, key: 'k' })
    model.provider = faux.getModel().provider
    model.api = faux.getModel().api
  })

  after(() => faux?.unregister())

  /** 跑一轮，回收模型真正收到的系统提示 */
  async function systemPromptOf(sandbox) {
    let systemPrompt = ''
    faux.setResponses([(context) => {
      systemPrompt = context.systemPrompt || systemPrompt
      return fauxAssistantMessage('好的')
    }])
    await runTurn({
      runId: `r_${Math.random().toString(36).slice(2)}`,
      username: 'zhangsan',
      sessionKey: 'main',
      prompt: '你好',
      model,
      store: createMemoryStore(),
      sandbox,
      logger: silent,
      timeoutMs: 30000,
    })
    return systemPrompt
  }

  const withSandbox = () => ({ mode: 'http', exec: async () => ({ exitCode: 0 }) })

  test('点名否掉 Current working directory 那一行', async () => {
    const prompt = await systemPromptOf(withSandbox())

    // pi 那行还在（我们改不动它），所以**必须**有一段明确说它不作数。
    assert.match(prompt, /Current working directory/, 'pi 的行为变了，这条测试的前提要重新确认')
    assert.match(prompt, /沙盒里\*\*不存在\*\*|沙盒里不存在/, '没有点名否掉那一行')
    assert.match(prompt, /不要 cd 过去/)
  })

  test('给出沙盒里的真实工作区根', async () => {
    const prompt = await systemPromptOf(withSandbox())
    assert.ok(prompt.includes(SANDBOX_WORKSPACE_ROOT), `系统提示里没有 ${SANDBOX_WORKSPACE_ROOT}`)
  })

  test('明确要求文件工具用相对路径', async () => {
    const prompt = await systemPromptOf(withSandbox())
    assert.match(prompt, /相对路径/)
    assert.match(prompt, /write.*read.*edit|write \/ read \/ edit/)
  })

  /**
   * 没有沙盒时 cwd 就是 agent 侧那个目录，pi 那行是**对的** ——
   * 这时候再说"它不存在"就成了睁眼说瞎话，反而会让模型不敢用文件工具。
   */
  test('没有沙盒时不加这段 —— 那种情况下 pi 那行是对的', async () => {
    const prompt = await systemPromptOf({ mode: 'none' })
    assert.ok(!prompt.includes('沙盒工作区'), '无沙盒时不该出现工作区纠正段')
    assert.ok(!prompt.includes(SANDBOX_WORKSPACE_ROOT), '无沙盒时不该提沙盒路径')
  })
})
