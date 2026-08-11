/**
 * 「复制调试信息」攒出来的那份 Markdown。
 *
 * 两类东西要钉住：
 *   1. **该被一眼看到的疑点**（假模型、没有执行端、工具停在未完成…）。漏掉的代价是
 *      拿着一份"看着一切正常"的调试信息去分析，前提全错。
 *   2. **长度与结构不能失控** —— 它是要贴进聊天框的。
 *
 * 凭据那一条不在这里测：那是"根本不去取"，靠 scripts/check-isolation-rules.js 的
 * 静态规则挡（把 document.cookie 写进去，`npm run check:isolation` 立刻红）。
 * 运行时断言"结果里没有 cookie"是弱的 —— 它只能证明这一次没漏。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { buildDebugBundle } from '../web/src/lib/debug-bundle.js'

/** 这个模块跑在浏览器里，要用到 location / navigator */
const saved = {}
before(() => {
  saved.location = globalThis.location
  saved.navigator = globalThis.navigator
  globalThis.location = { href: 'http://ap.xiaocaicai.com/?a=1' }
  if (!globalThis.navigator) globalThis.navigator = { userAgent: 'test-agent' }
})
after(() => {
  if (saved.location === undefined) delete globalThis.location
  else globalThis.location = saved.location
})

const HEALTH_OK = {
  authMode: 'password', llmMode: 'platform', sandbox: 'manager',
  activeRuns: 1, budget: 8, perUserLimit: 2, devConsole: false,
  bridge: { port: 8788, egressMode: 'allowlist', activeTickets: 1 },
}

const base = (overrides = {}) => ({
  health: HEALTH_OK, turns: [], live: null, events: [],
  sessionKey: 's_1', modelId: 'JoyAI-Pro', skills: [{ name: 'meeting' }], skillsUsable: true,
  ...overrides,
})

const assistantTurn = (overrides = {}) => ({
  role: 'assistant', done: true, blocks: [], error: '', ...overrides,
})

describe('调试信息的骨架', () => {
  test('该有的几节都在', () => {
    const text = buildDebugBundle(base())
    for (const section of ['# 云端助手 · 调试信息', '## 运行环境', '## 自动挑出来的疑点', '## 最近的请求问题', '## 对话']) {
      assert.ok(text.includes(section), `缺 ${section}`)
    }
  })

  test('头部写明"里面有会话原文"', () => {
    // 用户要把它贴给别人，得先知道自己在分享什么
    assert.match(buildDebugBundle(base()), /贴给别人前请先确认可以分享/)
  })

  test('连不上服务端时也能生成，而不是抛异常', () => {
    const text = buildDebugBundle(base({ health: null }))
    assert.match(text, /拿不到 \/healthz/)
  })
})

describe('自动挑疑点', () => {
  const suspicionsOf = (input) => buildDebugBundle(base(input)).split('## 自动挑出来的疑点')[1].split('##')[0]

  test('假模型要被点出来', () => {
    // 不点出来的话，会拿假模型的回复当真实模型行为去分析，方向从一开始就错
    assert.match(suspicionsOf({ health: { ...HEALTH_OK, llmMode: 'faux' } }), /LLM_MODE=faux/)
  })

  test('dev 身份要被点出来', () => {
    assert.match(suspicionsOf({ health: { ...HEALTH_OK, authMode: 'dev' } }), /AUTH_MODE=dev/)
  })

  test('没有执行端要被点出来', () => {
    assert.match(suspicionsOf({ health: { ...HEALTH_OK, sandbox: 'none' } }), /没有执行端/)
  })

  test('桥没启用要被点出来', () => {
    assert.match(suspicionsOf({ health: { ...HEALTH_OK, bridge: null } }), /Cloud Bridge 没启用/)
  })

  test('技能清单为空要被点出来', () => {
    assert.match(suspicionsOf({ skills: [] }), /技能清单是空的/)
  })

  test('停在"未完成"的工具要被数出来', () => {
    // 这正是"跑到一半断了"的痕迹，是最常见的一类故障现场
    const turns = [assistantTurn({
      blocks: [
        { type: 'tool', toolName: 'bash', status: 'aborted', args: {}, preview: '' },
        { type: 'tool', toolName: 'bash', status: 'running', args: {}, preview: '' },
        { type: 'tool', toolName: 'bash', status: 'done', args: {}, preview: 'ok' },
      ],
    })]
    assert.match(suspicionsOf({ turns }), /有 2 个工具调用停在"未完成"/)
  })

  test('失败的工具、带错误的轮次都要数', () => {
    const turns = [assistantTurn({
      error: '模型调用失败',
      blocks: [{ type: 'tool', toolName: 'bash', status: 'error', args: {}, preview: 'boom' }],
    })]
    const notes = suspicionsOf({ turns })
    assert.match(notes, /有 1 个工具调用失败/)
    assert.match(notes, /有 1 轮带错误信息/)
  })

  test('401 / 5xx 分开点，因为处理方式不一样', () => {
    const events = [
      { at: Date.now(), method: 'GET', path: '/v1/models', status: 401, code: 'UNAUTHENTICATED', message: 'x' },
      { at: Date.now(), method: 'POST', path: '/v1/chat/stream', status: 502, code: 'UPSTREAM', message: 'y' },
    ]
    const notes = suspicionsOf({ events })
    assert.match(notes, /401.*登录态/)
    assert.match(notes, /5xx.*requestId/)
  })

  test('一切正常时明说没发现问题，而不是留个空段落', () => {
    assert.match(suspicionsOf({}), /没发现明显异常/)
  })
})

describe('对话内容', () => {
  test('用户与助手的内容、每轮统计都带上', () => {
    const text = buildDebugBundle(base({
      turns: [
        { role: 'user', text: '帮我查会议', images: 0 },
        assistantTurn({
          stats: { durationMs: 12300, toolCalls: 2 },
          blocks: [
            { type: 'thinking', text: '要用 meeting' },
            { type: 'tool', toolName: 'bash', status: 'done', args: { command: 'ls' }, preview: '会议A' },
            { type: 'text', text: '你今天有一个会' },
          ],
        }),
      ],
    }))
    assert.match(text, /帮我查会议/)
    assert.match(text, /耗时 12\.3s · 工具 2 次/)
    assert.match(text, /工具 `bash` — 成功/)
    assert.match(text, /会议A/)
    assert.match(text, /你今天有一个会/)
    assert.match(text, /要用 meeting/)
  })

  test('内容里带 ``` 也不会把 Markdown 结构撑破', () => {
    // 模型回复里出现代码块是家常便饭。用固定三个反引号包的话，
    // 贴出去之后整段结构塌掉，后面的内容全被吞进代码块里。
    const text = buildDebugBundle(base({
      turns: [{ role: 'user', text: '看这段：\n```js\nconsole.log(1)\n```', images: 0 }],
    }))
    const after = text.split('## 对话')[1]
    assert.ok(after.includes('````'), '没有用更长的围栏包住带反引号的内容')
    assert.match(text, /## 对话/)
  })

  test('超长会话从最老的开始丢，并说明丢了多少', () => {
    const turns = []
    for (let i = 0; i < 200; i += 1) {
      turns.push({ role: 'user', text: `第 ${i} 问`.padEnd(600, '啊'), images: 0 })
      turns.push(assistantTurn({ blocks: [{ type: 'text', text: `第 ${i} 答`.padEnd(600, '哦') }] }))
    }
    const text = buildDebugBundle(base({ turns }))
    assert.ok(text.length < 70000, `太长了：${text.length}`)
    assert.match(text, /因长度只保留最后 \d+ 条/)
    // 最后一轮（现场）必须还在
    assert.ok(text.includes('第 199 答'), '把最后一轮丢掉了 —— 出问题的现场恰恰在那儿')
  })

  test('正在跑的那一轮也带上，并标出未完成', () => {
    const text = buildDebugBundle(base({
      turns: [{ role: 'user', text: '在跑', images: 0 }],
      live: assistantTurn({ done: false, blocks: [{ type: 'tool', toolName: 'bash', status: 'running', args: {} }] }),
    }))
    assert.match(text, /助手（未完成）/)
    assert.match(text, /仍在执行/)
  })

  test('单个工具结果会被截断，并写明原长', () => {
    const huge = 'x'.repeat(9000)
    const text = buildDebugBundle(base({
      turns: [assistantTurn({ blocks: [{ type: 'tool', toolName: 'bash', status: 'done', args: {}, preview: huge }] })],
    }))
    assert.match(text, /已截断，原长 9000 字符/)
    assert.ok(text.length < 20000)
  })

  test('空会话不炸', () => {
    assert.match(buildDebugBundle(base({ turns: [] })), /这个会话还没有内容/)
  })
})

describe('失败请求那一节', () => {
  test('requestId / traceId 要出现 —— 这是去服务端日志里定位的钥匙', () => {
    const text = buildDebugBundle(base({
      events: [{
        at: Date.now(), method: 'POST', path: '/v1/chat/stream', status: 502,
        code: 'UPSTREAM', message: '沙盒调度失败', requestId: 'req_abc', traceId: 'trace_xyz',
      }],
    }))
    assert.match(text, /req_abc/)
    assert.match(text, /trace_xyz/)
    assert.match(text, /\/v1\/chat\/stream/)
  })

  test('消息里的竖线要转义，否则表格会散架', () => {
    const text = buildDebugBundle(base({
      events: [{ at: Date.now(), method: 'GET', path: '/x', status: 500, code: 'E', message: 'a|b|c' }],
    }))
    assert.match(text, /a\\\|b\\\|c/)
  })
})
