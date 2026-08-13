/**
 * 真实技能 × 真实沙盒，端到端。
 *
 * 与 `test/skills.test.js` 的分工：那边用自造的 demo-skill + 假沙盒，测的是接线
 * （路径怎么改写、什么时候搬、搬哪些）。这里跑的是 `modules/ap/managed-skills`
 * 里那五个**真技能**，命令在**真 namespace 沙盒**里执行，python 是镜像里
 * `/opt/ap/venv` 的那个。
 *
 * 为什么两边都要有：假沙盒测不出属主。技能目录是 worker（root）通过接口写进去的，
 * job 降权到 slot uid 跑 —— 属主错了的话，`ls`/`cat`/`python` 全都正常，
 * 只有"往里写"会 EACCES。`skills/.venv` 这根软链接就是这么被挡住的，
 * 而假沙盒里根本不存在属主这回事。
 *
 * 需要 Linux + CAP_SYS_ADMIN/CAP_NET_ADMIN + 能 chown（root），不满足就清楚地跳过。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { registerFauxProvider, fauxAssistantMessage, fauxToolCall } from '@mariozechner/pi-ai'

import { loadConfig as loadWorkerConfig } from '../sandbox-worker/src/config.js'
import { createLeaseManager } from '../sandbox-worker/src/leases.js'
import { createSlotPool } from '../sandbox-worker/src/namespace/slot-pool.js'
import { createServer as createWorkerServer } from '../sandbox-worker/src/server.js'
import { probeNamespaceSupport } from '../sandbox-worker/test/support.js'
import { createHttpSandbox } from '../src/sandbox/client.js'
import { loadSkills } from '../src/agent/skills.js'
import { runTurn } from '../src/agent/run-turn.js'
import { createMemorySessionStore as createMemoryStore } from './helpers/memory-session-store.js'
import { buildModel } from '../src/models/model-factory.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = process.env.SKILL_DIRS || path.resolve(__dirname, '../../../modules/ap/managed-skills')
const TOKEN = 'skills-int-token-abcdef'
const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent } }

const support = await probeNamespaceSupport()
const canChown = typeof process.getuid === 'function' && process.getuid() === 0
const skip = !support.ok ? `跳过：${support.reason}`
  : !canChown ? '跳过：需要 root（属主断言要 chown）'
  : !existsSync(SKILLS_DIR) ? `跳过：找不到 ${SKILLS_DIR}，项目移出宿主仓库后请改用 SKILL_DIRS`
  : false

describe('真实技能 × 真实沙盒', { skip }, () => {
  let workRoot
  let slotPool
  let leaseManager
  let workerApp
  let sandbox
  let faux
  let model
  let skills

  before(async () => {
    skills = loadSkills({ dirs: [SKILLS_DIR], logger: silent }).skills

    workRoot = await mkdtemp(path.join(tmpdir(), 'skills-int-'))
    const config = loadWorkerConfig({
      NODE_ENV: 'test',
      SANDBOX_TOKEN: TOKEN,
      SANDBOX_SLOTS: '2',
      SANDBOX_WORK_ROOT: workRoot,
      SANDBOX_NS_BRIDGE: 'sbxskbr0',
      SANDBOX_NS_SUBNET: '10.249.0.0/16',
      EXEC_DEFAULT_TIMEOUT_MS: '30000',
      EXEC_MAX_OUTPUT_BYTES: '200000',
    })
    slotPool = createSlotPool({ config, logger: silent })
    await slotPool.init()
    leaseManager = createLeaseManager({ config, logger: silent, slotPool })
    workerApp = createWorkerServer({ config, logger: silent, leaseManager, slotPool })
    const address = await workerApp.listen(0)
    // 必须回填：租约响应里的 workerBase 用的是它，不改的话客户端会被指到
    // 容器默认 IP:8080（没人监听），一切操作都是一句没头没脑的 "fetch failed"
    config.advertiseBase = `http://127.0.0.1:${address.port}`

    sandbox = createHttpSandbox({
      config: { sandbox: { mode: 'http', url: config.advertiseBase, token: TOKEN, timeoutMs: 30000 } },
      logger: silent,
    })

    faux = registerFauxProvider({
      api: 'openai-completions',
      provider: 'ap-gateway',
      models: [{ id: 'test-model', name: 'test', contextWindow: 200000, maxTokens: 4096 }],
      tokensPerSecond: 1000000,
    })
    model = buildModel({ model: 'test-model', server: faux.getModel().baseUrl, key: 'k' })
    model.provider = faux.getModel().provider
    model.api = faux.getModel().api
  })

  after(async () => {
    faux?.unregister()
    await leaseManager?.releaseAll('test')
    await workerApp?.close()
    await slotPool?.shutdown()
    await rm(workRoot, { recursive: true, force: true })
  })

  /** 让 faux 依次发出给定的工具调用，回收每次的结果文本与系统提示 */
  async function turn(runId, calls) {
    const outputs = []
    let systemPrompt = ''
    let i = 0
    const responder = (context) => {
      systemPrompt = context.systemPrompt || systemPrompt
      for (const m of context.messages || []) {
        if (m.role !== 'toolResult') continue
        const text = JSON.stringify(m.content ?? m.output ?? '')
        if (!outputs.includes(text)) outputs.push(text)
      }
      if (i >= calls.length) return fauxAssistantMessage('done')
      const [name, params] = calls[i++]
      faux.appendResponses([responder])
      return fauxAssistantMessage([fauxToolCall(name, params)], { stopReason: 'toolUse' })
    }
    faux.setResponses([responder])

    const session = sandbox.createSession({ runId, username: 'zhangsan' })
    try {
      await runTurn({
        runId, username: 'zhangsan', sessionKey: 'main', prompt: '按技能说明操作',
        model, store: createMemoryStore(), sandbox: session, skills,
        logger: silent, timeoutMs: 120000,
      })
    } finally {
      await session.release?.().catch(() => {})
    }
    return { out: outputs.join('\n'), systemPrompt }
  }

  test('五个真技能都装载了，且没有告警', () => {
    const { diagnostics } = loadSkills({ dirs: [SKILLS_DIR], logger: silent })
    assert.ok(skills.length >= 5, `只装载到 ${skills.length} 个`)
    assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics.slice(0, 3)))
  })

  test('清单进系统提示，位置全是相对路径', async () => {
    const { systemPrompt } = await turn('i-prompt', [])
    for (const s of skills) {
      assert.match(systemPrompt, new RegExp(`<location>skills/${s.name}/SKILL\\.md</location>`), `没宣告 ${s.name}`)
    }
    // 绝对路径在沙盒里不存在，漏出去等于告诉模型一个读不了的位置
    assert.ok(!/<location>\//.test(systemPrompt), '有绝对路径漏进系统提示')
  })

  test('技能目录连同 scripts/ 真的落进沙盒', async () => {
    const { out } = await turn('i-ls', [['bash', { command: 'ls skills/ && ls skills/meeting/scripts/' }]])
    for (const s of skills) assert.ok(out.includes(s.name), `沙盒里没有 ${s.name}`)
    assert.ok(out.includes('huiji_cli.py'), 'scripts/ 没搬过去')
    assert.ok(!out.includes('__pycache__'), '__pycache__ 不该搬')
  })

  test('技能目录归 job 属主 —— 否则脚本连自己目录都写不了', async () => {
    const { out } = await turn('i-own', [[
      'bash',
      { command: 'stat -c "%U:%u" skills skills/meeting; touch skills/meeting/_w && echo WRITABLE' },
    ]])
    assert.ok(out.includes('WRITABLE'), `技能目录对 job 不可写：${out.slice(0, 200)}`)
  })

  test('模型按宣告的位置 read，拿到真实技能正文', async () => {
    const { out } = await turn('i-read', [['read', { path: 'skills/joymail-search/SKILL.md' }]])
    assert.ok(out.includes('joymail-search'), '没读到技能正文')
    assert.ok(out.includes('scripts/run.sh'), '读到的不是完整正文')
  })

  test('真的能执行技能脚本（meeting 的 CLI 跑起来了）', async () => {
    const { out } = await turn('i-exec', [[
      'bash',
      { command: 'cd skills/meeting && python3 scripts/huiji_cli.py --help 2>&1 | head -20' },
    ]])
    assert.ok(out.includes('range-details') || out.includes('usage'), `CLI 没跑起来：${out.slice(0, 300)}`)
  })

  test('skills/.venv 软链接让 joymail 的 run.sh 零改动可跑', async () => {
    const { out } = await turn('i-venv', [[
      'bash',
      { command: 'cd skills/joymail-search && bash scripts/run.sh --help 2>&1 | head -20' },
    ]])
    // ENV_NOT_READY 是 run.sh 找不到 .venv 时的自报错误码
    assert.ok(!out.includes('ENV_NOT_READY'), `软链接没生效，run.sh 一步都跑不下去：${out.slice(0, 300)}`)
    assert.ok(out.includes('usage') || out.includes('search'), `run.sh 没把 python 拉起来：${out.slice(0, 300)}`)
  })
})
