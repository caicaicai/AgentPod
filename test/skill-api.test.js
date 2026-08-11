/**
 * 技能管理的 HTTP 面。
 *
 * `src/workspace/skill-manager.js` 那一层的用例覆盖了语义，这里只管**路由到
 * 那一层之间**的事：username 从登录态取（不从请求里取）、方法/路径的分派、
 * 领域错误的状态码。
 *
 * 最要紧的一条是 username：管理接口能改和删文件，一旦让请求方指定用户，
 * 就是"改别人的技能"。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createServer } from '../src/http/server.js'
import { createWorkspaceStore } from '../src/workspace/store.js'
import { createSkillManager } from '../src/workspace/skill-manager.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

const SKILL_MD = ['---', 'name: weekly-report', 'description: 周报生成', '---', '', '# 周报', ''].join('\n')

let root
let workspace
let skillManager
let app
let base
/** 当前请求被认成谁 —— 单条用例可以改它来模拟另一个用户 */
let currentErp

async function seed(username, name, files = { 'SKILL.md': SKILL_MD }) {
  const dir = path.join(workspace.skillScopeDir(username, 'created'), name)
  await mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), content)
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ap-skillapi-'))
  workspace = createWorkspaceStore({ config: { userWorkspace: { root } }, logger: silentLogger })
  skillManager = createSkillManager({ workspace, logger: silentLogger })
  currentErp = 'u1'

  app = createServer({
    config: {
      auth: { mode: 'dev' },
      llm: { mode: 'faux' },
      sandbox: { mode: 'none' },
      bridge: { enabled: false },
      limits: { bodyLimitBytes: 1024 * 1024 },
      devConsole: false,
      webUi: false,
    },
    logger: silentLogger,
    identity: { resolve: async () => ({ username: currentErp, credential: '', verified: true }) },
    broker: { getLlmAccess: async () => ({ models: [], user: null }), invalidate() {} },
    runService: {
      snapshot: () => ({}),
      async listSkills({ username }) {
        const disabled = await skillManager.disabledNames(username)
        return [{ name: 'weekly-report', scope: 'personal', enabled: !disabled.has('weekly-report') }]
      },
      abort: () => ({ ok: true }),
      execute: async () => {},
    },
    store: null,
    llmInfoClient: null,
    metrics: { snapshot: () => ({}) },
    workspace,
    skillManager,
  })
  await app.listen(0)
  base = `http://127.0.0.1:${app.server.address().port}`
})

afterEach(async () => {
  await app.close()
  await rm(root, { recursive: true, force: true })
})

const call = async (method, urlPath, body) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

describe('路由分派', () => {
  test('GET /v1/skills/:name 回文件与内容', async () => {
    await seed('u1', 'weekly-report', { 'SKILL.md': SKILL_MD, 'scripts/run.py': 'print(1)\n' })
    const { status, body } = await call('GET', '/v1/skills/weekly-report')
    assert.equal(status, 200)
    assert.equal(body.scope, 'created')
    assert.equal(body.files.find((f) => f.path === 'scripts/run.py').content, 'print(1)\n')
  })

  test('PUT /v1/skills/:name/files 覆盖文件', async () => {
    await seed('u1', 'weekly-report')
    const { status } = await call('PUT', '/v1/skills/weekly-report/files', {
      files: [{ path: 'SKILL.md', content: SKILL_MD }, { path: 'a.py', content: 'x' }],
    })
    assert.equal(status, 200)
    const after = await call('GET', '/v1/skills/weekly-report')
    assert.deepEqual(after.body.files.map((f) => f.path), ['SKILL.md', 'a.py'])
  })

  test('PATCH 改展示信息', async () => {
    await seed('u1', 'weekly-report')
    const { status } = await call('PATCH', '/v1/skills/weekly-report', { displayName: '周报' })
    assert.equal(status, 200)
    const after = await call('GET', '/v1/skills/weekly-report')
    assert.match(after.body.files[0].content, /displayName: 周报/)
  })

  test('PATCH 启停，且清单里的 enabled 跟着变', async () => {
    await seed('u1', 'weekly-report')
    assert.equal((await call('GET', '/v1/skills')).body.skills[0].enabled, true)
    await call('PATCH', '/v1/skills/weekly-report', { enabled: false })
    assert.equal((await call('GET', '/v1/skills')).body.skills[0].enabled, false)
  })

  test('PATCH 什么都没带 = 400，不是静默成功', async () => {
    await seed('u1', 'weekly-report')
    const { status, body } = await call('PATCH', '/v1/skills/weekly-report', { nothing: 1 })
    assert.equal(status, 400)
    assert.match(body.error?.message || body.message || '', /没有可更新的字段/)
  })

  test('DELETE 删掉', async () => {
    await seed('u1', 'weekly-report')
    assert.equal((await call('DELETE', '/v1/skills/weekly-report')).status, 200)
    assert.equal((await call('GET', '/v1/skills/weekly-report')).status, 404)
  })

  test('/v1/skills 报 canManage', async () => {
    assert.equal((await call('GET', '/v1/skills')).body.canManage, true)
  })
})

describe('username 只从登录态取', () => {
  test('换一个用户就读不到了 —— 请求里没有任何地方能指定 username', async () => {
    await seed('u1', 'weekly-report')
    assert.equal((await call('GET', '/v1/skills/weekly-report')).status, 200)
    currentErp = 'u2'
    assert.equal((await call('GET', '/v1/skills/weekly-report')).status, 404)
  })

  test('请求体里塞 username 也没用', async () => {
    await seed('u1', 'weekly-report')
    await seed('u2', 'weekly-report', { 'SKILL.md': SKILL_MD.replace('周报生成', 'u2 的') })
    currentErp = 'u2'
    // body 里的 username 是个未知字段，会被忽略；改的必须是 u2 自己那一份
    await call('PATCH', '/v1/skills/weekly-report', { username: 'u1', displayName: '被改了' })
    currentErp = 'u1'
    const mine = await call('GET', '/v1/skills/weekly-report')
    assert.ok(!mine.body.files[0].content.includes('被改了'), 'u2 改到了 u1 的技能')
  })
})

describe('错误状态码', () => {
  test('技能不存在是 404，不是 500', async () => {
    // 500 会让客户端重试、日志里堆 error 级，而这是最正常不过的情况
    const { status } = await call('GET', '/v1/skills/nope')
    assert.equal(status, 404)
  })

  test('技能名不合法是 400', async () => {
    assert.equal((await call('GET', '/v1/skills/Bad_Name')).status, 400)
  })

  test('路径穿越拿不到东西', async () => {
    for (const evil of ['/v1/skills/..%2F..%2Fetc', '/v1/skills/a%2Fb', '/v1/skills/weekly-report/other']) {
      const { status } = await call('GET', evil)
      assert.ok(status === 400 || status === 404, `${evil} 回了 ${status}`)
    }
  })

  test('未知子路径是 404，不会被当成技能名', async () => {
    // 落到"技能名带斜杠"会得到一句莫名其妙的"技能名不合法"
    assert.equal((await call('GET', '/v1/skills/weekly-report/files')).status, 404)
  })
})
