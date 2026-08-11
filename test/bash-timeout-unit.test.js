/**
 * pi 的 bash 工具 `timeout` 单位是**秒**，沙盒要的是**毫秒**。
 *
 * ── 这条守的是一个查了三天的 bug ────────────────────────────────────
 *
 * `createSandboxBashOperations` 曾经写的是 `timeout: options.timeout` —— 直接把
 * pi 的秒当成毫秒传下去。pi 的 schema 原文是 "Timeout in seconds"，它自带的执行器
 * 是 `setTimeout(..., timeout * 1000)`，所以这是我们这边读错了。
 *
 * 后果：模型写 `timeout: 30`（想要 30 秒）→ worker 收到 `timeoutMs: 30` →
 * 命令在 python 解释器还没启动完的时候就被 SIGTERM。
 *
 * 难认在两点：
 *   1. **只影响带 timeout 参数的调用。** `pwd` / `ls` / `echo` 这类模型不会加超时的
 *      一直正常（回落到 SANDBOX_TIMEOUT_MS）。模型越谨慎（"这条可能慢，加个超时吧"）
 *      死得越多，看起来像"复杂命令才会失败"。
 *   2. 30ms 正好卡在解释器启动中间，成不成带随机性 —— 于是表现为"偶发"。
 *
 * 实测代价：一次简单任务 76 次工具调用、302 秒，模型一路在排查并不存在的
 * 「stdout 缓冲」「沙盒禁网」。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createSandboxBashOperations } from '../src/agent/tools.js'

const runContext = { runId: 'r1', username: 'me', bridgeUrl: '', ticket: '', skillLibsDir: '' }

/** 接住 sandbox.exec 收到的参数 */
function spyOperations() {
  const calls = []
  const sandbox = {
    mode: 'http',
    async exec(params) { calls.push(params); return { exitCode: 0 } },
  }
  return { calls, ops: createSandboxBashOperations({ sandbox, runContext }) }
}

describe('bash 工具的 timeout 单位换算', () => {
  test('30 秒 → 30000 毫秒', async () => {
    const { calls, ops } = spyOperations()
    await ops.exec('sleep 1', '/w', { timeout: 30, onData() {}, signal: null })
    assert.equal(calls[0].timeoutMs, 30000, '秒当成毫秒用了 —— 命令会在 30ms 就被杀')
  })

  test('小数秒也要换算', async () => {
    const { calls, ops } = spyOperations()
    await ops.exec('x', '/w', { timeout: 1.5, onData() {}, signal: null })
    assert.equal(calls[0].timeoutMs, 1500)
  })

  test('不传就不传 —— 让 client 回落到 SANDBOX_TIMEOUT_MS', async () => {
    const { calls, ops } = spyOperations()
    await ops.exec('x', '/w', { onData() {}, signal: null })
    assert.equal(calls[0].timeoutMs, undefined, '不该在这一层编一个默认值')
  })

  test('0 和负数当作没传，不要算出 0 毫秒', async () => {
    // timeoutMs: 0 会被 client 的 `|| config.sandbox.timeoutMs` 兜住，
    // 但依赖这个巧合不好 —— 显式表达"没传"。
    for (const timeout of [0, -5]) {
      const { calls, ops } = spyOperations()
      await ops.exec('x', '/w', { timeout, onData() {}, signal: null })
      assert.equal(calls[0].timeoutMs, undefined, `timeout=${timeout} 应当视作没传`)
    }
  })

  /**
   * 这条盯着 pi 那边的契约。pi 哪天把单位改成毫秒，这里会红 ——
   * 而不是线上又一次"命令偶发被杀"。
   */
  test('pi 的 schema 仍然写着 seconds', async () => {
    const { createBashToolDefinition } = await import('@mariozechner/pi-coding-agent')
    const tool = createBashToolDefinition('/w', { operations: { exec: async () => ({}) } })
    const description = JSON.stringify(tool.parameters)
    assert.match(
      description,
      /Timeout in seconds/i,
      'pi 改了 timeout 的单位 —— src/agent/tools.js 的换算要跟着改',
    )
  })
})
