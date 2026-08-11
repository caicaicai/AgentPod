/**
 * 多租户隔离回归测试 —— 这是本项目最重要的测试，坏了不许合并。
 *
 * 用 pi 的 faux provider 顶掉真实模型，所以不需要凭据、不发网络请求、不烧 token。
 *
 * 两个方向都要测：
 *   正向：并发多用户时互不可见
 *   反向：故意破坏隔离（忘记按 username 过滤）时测试必须失败
 *        —— 否则你分不清"真通过"还是"检测器失效"。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { registerFauxProvider, fauxAssistantMessage, fauxToolCall } from '@mariozechner/pi-ai'

import { runTurn } from '../src/agent/run-turn.js'
import { createMemoryStore } from '../src/sessions/store.js'
import { buildModel } from '../src/models/model-factory.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

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

/** 回显模型：把它看到的用户历史说出来 —— 让"谁看到了谁的内容"变成可断言的事实 */
function echoResponder() {
  const responder = (context) => {
    faux.appendResponses([responder])
    const texts = []
    for (const message of context.messages || []) {
      if (message.role !== 'user') continue
      if (typeof message.content === 'string') texts.push(message.content)
      else for (const part of message.content || []) if (part?.type === 'text') texts.push(part.text)
    }
    return fauxAssistantMessage(`历史：${texts.join(' | ')}`)
  }
  faux.setResponses([responder])
}

function createRecordingSandbox() {
  const calls = []
  return {
    mode: 'http',
    calls,
    async exec({ runId, username, command, onData }) {
      calls.push({ runId, username, command })
      onData(Buffer.from('ok\n'))
      return { exitCode: 0 }
    },
  }
}

function baseArgs(store, sandbox) {
  return { model, store, sandbox, logger: silentLogger, timeoutMs: 30000 }
}

describe('多租户隔离', () => {
  test('并发多用户：上下文互不可见，存储互不串', async () => {
    echoResponder()
    const store = createMemoryStore()
    const sandbox = createRecordingSandbox()
    const args = baseArgs(store, sandbox)

    await Promise.all([
      runTurn({ ...args, runId: 'a1', username: 'userA', sessionKey: 'main', prompt: '我的代号是 ALPHA-1' }),
      runTurn({ ...args, runId: 'b1', username: 'userB', sessionKey: 'main', prompt: '我的代号是 BETA-2' }),
    ])
    const [a, b] = await Promise.all([
      runTurn({ ...args, runId: 'a2', username: 'userA', sessionKey: 'main', prompt: '我的代号是什么' }),
      runTurn({ ...args, runId: 'b2', username: 'userB', sessionKey: 'main', prompt: '我的代号是什么' }),
    ])

    // 泄漏判定（硬）：不能出现对方的代号
    assert.ok(!a.finalText.includes('BETA-2'), 'userA 的回复里出现了 userB 的代号')
    assert.ok(!b.finalText.includes('ALPHA-1'), 'userB 的回复里出现了 userA 的代号')
    // 记忆判定（软，仅在 faux 回显模型下成立，真实模型不作要求）
    assert.ok(a.finalText.includes('ALPHA-1'))
    assert.ok(b.finalText.includes('BETA-2'))

    // 存储层（与模型行为无关，权威依据）
    const rowA = await store.load({ username: 'userA', sessionKey: 'main' })
    const rowB = await store.load({ username: 'userB', sessionKey: 'main' })
    assert.ok(!rowA.jsonl.includes('BETA-2'), '存储层串号：userA 的会话含 userB 内容')
    assert.ok(!rowB.jsonl.includes('ALPHA-1'), '存储层串号：userB 的会话含 userA 内容')
    assert.notEqual(rowA.sessionId, rowB.sessionId, '两个用户拿到了同一个 sessionId')
  })

  test('反向验证：破坏 username 隔离时，测试必须能抓到', async () => {
    echoResponder()
    // 故意做一个"忘记按 username 过滤"的 store —— 正是隔离契约 #4 被违反的样子
    const rows = new Map()
    const brokenStore = {
      async load({ sessionKey }) { return rows.get(sessionKey) || null },
      async save({ username, sessionKey, sessionId, jsonl, entryCount }) {
        rows.set(sessionKey, { username, sessionKey, sessionId, jsonl, entryCount })
      },
      async list() { return [] },
      async remove({ sessionKey }) { return rows.delete(sessionKey) },
    }
    const args = baseArgs(brokenStore, createRecordingSandbox())

    await runTurn({ ...args, runId: 'x1', username: 'userA', sessionKey: 'main', prompt: '我的代号是 ALPHA-1' })
    await runTurn({ ...args, runId: 'x2', username: 'userB', sessionKey: 'main', prompt: '我的代号是 BETA-2' })
    const leaked = await runTurn({ ...args, runId: 'x3', username: 'userA', sessionKey: 'main', prompt: '我的代号是什么' })

    assert.ok(leaked.finalText.includes('BETA-2'), '检测器失效：破坏隔离后仍未观察到串号')
  })

  test('凭据不进 process.env', async () => {
    echoResponder()
    const store = createMemoryStore()
    await runTurn({
      ...baseArgs(store, createRecordingSandbox()),
      runId: 'c1',
      username: 'userC',
      sessionKey: 'main',
      prompt: '你好',
      apiKey: 'SUPER_SECRET_TOKEN_VALUE',
    })
    const leaked = Object.entries(process.env).filter(([, value]) => String(value).includes('SUPER_SECRET_TOKEN_VALUE'))
    assert.equal(leaked.length, 0, `凭据泄漏到环境变量：${leaked.map(([k]) => k).join(',')}`)
  })

  test('工具执行下沉沙盒，且带正确的 username', async () => {
    const responder = (context) => {
      faux.appendResponses([responder])
      const sawToolResult = (context.messages || []).some((m) => m.role === 'toolResult')
      if (sawToolResult) return fauxAssistantMessage('执行完了')
      return fauxAssistantMessage([fauxToolCall('bash', { command: 'echo hello' })], { stopReason: 'toolUse' })
    }
    faux.setResponses([responder])

    const store = createMemoryStore()
    const sandbox = createRecordingSandbox()
    await runTurn({ ...baseArgs(store, sandbox), runId: 'd1', username: 'userD', sessionKey: 'main', prompt: '跑个命令' })

    assert.equal(sandbox.calls.length, 1, '应恰好派发一次沙盒执行')
    assert.equal(sandbox.calls[0].username, 'userD', '沙盒调用没带上正确的用户身份')
    assert.match(sandbox.calls[0].command, /echo hello/)
  })

  test('run 结束后临时目录被清理', async () => {
    echoResponder()
    const { readdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    // 只看这个 run 自己的目录（`ap-run-<runId>-xxxx`）。
    // 早先这里数的是 tmpdir 里 ap-run-* 的总数 —— node --test 并行跑多个测试文件时，
    // 别的文件正在跑的 run 会把计数顶上去，于是变成一条会随机变红的测试。
    const runId = `e1-${process.pid}-${Date.now().toString(36)}`
    await runTurn({
      ...baseArgs(createMemoryStore(), createRecordingSandbox()),
      runId,
      username: 'userE',
      sessionKey: 'main',
      prompt: '你好',
    })

    const leftover = (await readdir(tmpdir())).filter((name) => name.startsWith(`ap-run-${runId}-`))
    assert.equal(leftover.length, 0, `临时目录未清理，残留用户数据：${leftover.join(', ')}`)
  })

  test('store 接口强制按 username 隔离（缺 username 直接抛错）', async () => {
    const store = createMemoryStore()
    await assert.rejects(() => store.load({ sessionKey: 'main' }), /username/)
    await assert.rejects(() => store.list({}), /username/)
  })
})
