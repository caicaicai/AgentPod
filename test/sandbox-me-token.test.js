/**
 * 把用户 me_token 注入沙盒 —— 隔离契约上一道**显式开的口子**。
 *
 * 这组用例守的不是"功能能用"，而是这道口子**恰好只有开的那么大**：
 *
 *   1. 默认关着。谁把默认值改成 true，这里必须红。
 *   2. 只放 me_token 一个 cookie 进去。整串 Cookie 里还有 sso.xiaocaicai.com，
 *      那是权限更大的票，漏进沙盒等于这道口子白开了限制。
 *   3. 开关开着但用户没有 me_token 时，**不注入一个空的 ME_TOKEN** ——
 *      空值让技能的 `if me_token:` 走进"没注入"分支，行为对；但一个存在
 *      却为空的变量会让排查的人以为注入生效了，方向就歪了。
 *   4. 注入的 key 必须能过 worker 那层键名白名单。三个开关里就数这个不对齐
 *      时最难查：token 被静默丢掉，技能报鉴权失败，线索只在 worker 的一行 warn。
 *
 * 背景与代价见 src/agent/sandbox-credentials.js 的文件头。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'

import { extractMeToken, buildSandboxCredentialEnv } from '../src/agent/sandbox-credentials.js'
import { loadConfig } from '../src/config.js'
import { loadConfig as loadWorkerConfig } from '../sandbox-worker/src/config.js'
import { buildJobEnv } from '../sandbox-worker/src/executor.js'
import { createSandboxBashOperations } from '../src/agent/tools.js'

/** 长得像真票 —— 短字符串会让"没泄露"的断言误报通过 */
const ME = 'ee.AAAAbbbbCCCCddddEEEEffff1234567890'
const SSO = 'eyJhbGciOiJIUzI1NiJ9.dGVzdC10aWNrZXQ.c2ln'
const COOKIE = `username.lang=zh; sso.xiaocaicai.com=${SSO}; me_token=${ME}; __jda=1`

describe('从整串 Cookie 里抽 me_token', () => {
  test('抽得出来，且不受前后其它 cookie 影响', () => {
    assert.equal(extractMeToken(COOKIE), ME)
  })

  test('名字必须精确匹配，前缀不同的不算', () => {
    // `x-me_token=` 这种如果被当成命中，注入的就是个错值，
    // 而现象是"token 无效"，没人会想到是解析问题
    assert.equal(extractMeToken(`x-me_token=${ME}`), '')
    assert.equal(extractMeToken('me_token_v2=abc'), '')
  })

  test('没有就是空串', () => {
    assert.equal(extractMeToken(`sso.xiaocaicai.com=${SSO}`), '')
    assert.equal(extractMeToken(''), '')
  })
})

describe('注入开关', () => {
  test('默认不注入 —— 开这道口子必须是显式的部署决定', () => {
    assert.deepEqual(buildSandboxCredentialEnv({ credential: COOKIE }), {})
  })

  test('开着但用户没有 me_token → 不注入空值', () => {
    const env = buildSandboxCredentialEnv({ credential: `sso.xiaocaicai.com=${SSO}`, injectMeToken: true })
    assert.deepEqual(env, {}, '注入了一个空的 ME_TOKEN，会把排查方向带偏')
    assert.ok(!('ME_TOKEN' in env))
  })
})

describe('config 默认值', () => {
  const BASE = { SANDBOX_MODE: 'none' }
  // **不要用仓库根当 cwd**：loadConfig 会读那里的 .env，
  // 于是这组用例的结果会取决于开发机上那份私有配置。
  const CWD = tmpdir()

  test('SANDBOX_INJECT_ME_TOKEN 默认关', () => {
    const config = loadConfig({ cwd: CWD, env: { ...BASE } })
    assert.equal(config.sandbox.injectMeToken, false)
  })

  test('显式开', () => {
    const config = loadConfig({ cwd: CWD, env: { ...BASE, SANDBOX_INJECT_ME_TOKEN: '1' } })
    assert.equal(config.sandbox.injectMeToken, true)
  })
})

describe('三个开关要对得上', () => {
  /**
   * agent 注入的 key 必须能过 worker 的键名白名单，否则被静默丢弃。
   * 这条用例把两端的默认值直接对撞，任何一边改了都会红。
   */
  test('ME_TOKEN 能过 worker 的 ENV_KEY_ALLOW 默认值', () => {
    const worker = loadWorkerConfig({ ALLOW_ANONYMOUS: '1' })
    const { env, rejected } = buildJobEnv({
      config: worker,
      workspace: { homeDir: '/h', tmpDir: '/t', rootDir: '/w' },
      extraEnv: { ME_TOKEN: ME, AP_RUN_ID: 'r1' },
    })
    assert.deepEqual(rejected, [], 'ME_TOKEN 被 worker 的键名白名单丢掉了')
    assert.equal(env.ME_TOKEN, ME)
    assert.equal(env.AP_RUN_ID, 'r1')
  })

  test('白名单没放宽到什么都收', () => {
    const worker = loadWorkerConfig({ ALLOW_ANONYMOUS: '1' })
    const { env, rejected } = buildJobEnv({
      config: worker,
      workspace: { homeDir: '/h', tmpDir: '/t', rootDir: '/w' },
      extraEnv: { LD_PRELOAD: '/evil.so', PATH: '/evil', SSO_TOKEN: 'x' },
    })
    assert.deepEqual(rejected.sort(), ['LD_PRELOAD', 'PATH', 'SSO_TOKEN'])
    assert.equal(env.PATH, worker.jobPath, 'PATH 被调用方覆盖了')
    assert.ok(!('SSO_TOKEN' in env), 'SSO_TOKEN 不该能注入 —— 这道口子只给 me_token')
  })
})

describe('exec 时真的带上了', () => {
  function spy(runContext) {
    const calls = []
    const sandbox = { mode: 'http', async exec(params) { calls.push(params); return { exitCode: 0 } } }
    return { calls, ops: createSandboxBashOperations({ sandbox, runContext }) }
  }

  const base = { runId: 'r1', username: 'me', bridgeUrl: 'http://b/r/t', ticket: 't', skillLibsDir: '/libs' }

  test('credentialEnv 会随每条命令下发', async () => {
    const { calls, ops } = spy({ ...base, credentialEnv: { ME_TOKEN: ME } })
    await ops.exec('ls', '/w', { onData() {}, signal: null })
    assert.equal(calls[0].env.ME_TOKEN, ME)
    assert.equal(calls[0].env.AP_NATIVE_BRIDGE_URL, 'http://b/r/t', '原有的 AP_* 被挤掉了')
  })

  test('没有 credentialEnv 时行为与从前完全一致', async () => {
    const { calls, ops } = spy(base)
    await ops.exec('ls', '/w', { onData() {}, signal: null })
    assert.ok(!('ME_TOKEN' in calls[0].env))
    assert.deepEqual(
      Object.keys(calls[0].env).sort(),
      ['AP_NATIVE_BRIDGE_URL', 'AP_RUN_ID', 'AP_RUN_TICKET', 'AP_SKILL_LIBS_DIR'],
    )
  })

  /**
   * credentialEnv 是外部算出来的对象，万一哪天它里面出现同名 key，
   * 也不能把票据/桥地址顶掉 —— 那会让沙盒连回一个攻击者指定的地址。
   */
  test('credentialEnv 覆盖不掉 AP_* ', async () => {
    const { calls, ops } = spy({
      ...base,
      credentialEnv: { ME_TOKEN: ME, AP_NATIVE_BRIDGE_URL: 'http://evil/' },
    })
    await ops.exec('ls', '/w', { onData() {}, signal: null })
    assert.equal(calls[0].env.AP_NATIVE_BRIDGE_URL, 'http://b/r/t')
  })
})
