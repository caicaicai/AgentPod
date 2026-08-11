/**
 * 个人技能管理面。
 *
 * 对应桌面端 `extensions/chat` 里的 `skill.local.*` / `skill.remote.updateStatus`
 * 网关方法（云端没有 gateway，对应物是 HTTP 路由）。
 *
 * 这组用例分三块，第三块最要紧：
 *   1. CRUD 本身对不对
 *   2. 停用状态真的让技能从这一轮里消失（不只是界面上灰掉）
 *   3. **越界**：所有入口都只收"技能名"，任何路径形态都得被顶回去
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createWorkspaceStore } from '../src/workspace/store.js'
import { createSkillManager, createDisabledSkillManager, SkillManagerError } from '../src/workspace/skill-manager.js'
import { loadSkills, selectSkills } from '../src/agent/skills.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

let root
let workspace
let manager

const SKILL_MD = [
  '---',
  'name: weekly-report',
  'description: 周报生成',
  '---',
  '',
  '# 周报',
  '正文',
  '',
].join('\n')

async function seedSkill(username, name, files = { 'SKILL.md': SKILL_MD }, scope = 'created') {
  const dir = path.join(workspace.skillScopeDir(username, scope), name)
  await mkdir(dir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), content)
  }
  return dir
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ap-skillmgr-'))
  workspace = createWorkspaceStore({ config: { userWorkspace: { root } }, logger: silentLogger })
  manager = createSkillManager({ workspace, logger: silentLogger })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('读', () => {
  test('回文件清单与内容', async () => {
    await seedSkill('u1', 'weekly-report', {
      'SKILL.md': SKILL_MD,
      'scripts/run.py': 'print(1)\n',
    })
    const result = await manager.read({ username: 'u1', name: 'weekly-report' })
    assert.equal(result.scope, 'created')
    assert.deepEqual(result.files.map((f) => f.path), ['SKILL.md', 'scripts/run.py'])
    assert.equal(result.files[1].content, 'print(1)\n')
  })

  test('二进制文件标出来，不塞进 JSON', async () => {
    await seedSkill('u1', 'weekly-report', { 'SKILL.md': SKILL_MD })
    await writeFile(path.join(workspace.skillScopeDir('u1', 'created'), 'weekly-report', 'icon.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    const result = await manager.read({ username: 'u1', name: 'weekly-report' })
    const icon = result.files.find((f) => f.path === 'icon.png')
    assert.equal(icon.binary, true)
    assert.equal(icon.content, undefined)
  })

  test('别人的技能读不到 —— 路径是拿 username 拼出来的（隔离契约 #4）', async () => {
    await seedSkill('u1', 'weekly-report')
    await assert.rejects(() => manager.read({ username: 'u2', name: 'weekly-report' }), /不存在/)
  })

  test('不存在回 404 而不是 500', async () => {
    // 500 会让客户端重试、日志里堆一片 error 级，而这其实是最正常不过的情况
    await assert.rejects(() => manager.read({ username: 'u1', name: 'nope' }), (error) => {
      assert.ok(error instanceof SkillManagerError)
      assert.equal(error.status, 404)
      return true
    })
  })
})

describe('改文件', () => {
  test('覆盖式：没传的文件会消失', async () => {
    await seedSkill('u1', 'weekly-report', { 'SKILL.md': SKILL_MD, 'scripts/old.py': 'x' })
    await manager.writeFiles({
      username: 'u1', name: 'weekly-report',
      files: [{ path: 'SKILL.md', content: SKILL_MD }, { path: 'scripts/new.py', content: 'y' }],
    })
    const after = await manager.read({ username: 'u1', name: 'weekly-report' })
    assert.deepEqual(after.files.map((f) => f.path), ['SKILL.md', 'scripts/new.py'])
  })

  test('不许把 SKILL.md 删掉', async () => {
    // 删了它 pi 就不认这个技能了，而且没有任何报错 —— 表现只是技能凭空消失
    await seedSkill('u1', 'weekly-report')
    await assert.rejects(
      () => manager.writeFiles({ username: 'u1', name: 'weekly-report', files: [{ path: 'a.py', content: 'x' }] }),
      /SKILL\.md 不能删除/,
    )
    assert.ok(existsSync(path.join(workspace.skillScopeDir('u1', 'created'), 'weekly-report', 'SKILL.md')))
  })
})

describe('改展示信息', () => {
  test('插入 displayName，正文一个字不动', async () => {
    await seedSkill('u1', 'weekly-report')
    await manager.updateInfo({ username: 'u1', name: 'weekly-report', displayName: '周报生成器' })
    const text = await readFile(path.join(workspace.skillScopeDir('u1', 'created'), 'weekly-report', 'SKILL.md'), 'utf8')
    assert.match(text, /^displayName: 周报生成器$/m)
    assert.ok(text.includes('# 周报\n正文'), '正文被改动了')
    // 装载器真的读得到（不只是文本里有）
    const { skills } = loadSkills({ dirs: workspace.skillDirs('u1'), logger: silentLogger })
    assert.equal(skills[0].displayName, '周报生成器')
  })

  test('已有的键是替换不是追加', async () => {
    await seedSkill('u1', 'weekly-report')
    await manager.updateInfo({ username: 'u1', name: 'weekly-report', description: '第一版' })
    await manager.updateInfo({ username: 'u1', name: 'weekly-report', description: '第二版' })
    const text = await readFile(path.join(workspace.skillScopeDir('u1', 'created'), 'weekly-report', 'SKILL.md'), 'utf8')
    assert.equal((text.match(/^description:/gm) || []).length, 1)
    assert.match(text, /description: 第二版/)
  })

  test('description 里的换行会被压平 —— 它会破坏 frontmatter 结构', async () => {
    await seedSkill('u1', 'weekly-report')
    await manager.updateInfo({ username: 'u1', name: 'weekly-report', description: '第一行\n第二行' })
    const { skills } = loadSkills({ dirs: workspace.skillDirs('u1'), logger: silentLogger })
    assert.equal(skills.length, 1, 'frontmatter 被写坏了，技能装不进来')
    assert.equal(skills[0].description, '第一行 第二行')
  })

  test('description 不许改成空', async () => {
    // 空 description 会让 pi 静默跳过这个技能，表现成"技能凭空消失"
    await seedSkill('u1', 'weekly-report')
    await assert.rejects(() => manager.updateInfo({ username: 'u1', name: 'weekly-report', description: '   ' }), /不能为空/)
  })

  test('不改 metadata 块里的同名键', async () => {
    await seedSkill('u1', 'weekly-report', {
      'SKILL.md': ['---', 'name: weekly-report', 'description: 原描述',
        'metadata: {"openclaw": {"emoji": "📊"}}', '---', '', '正文', ''].join('\n'),
    })
    await manager.updateInfo({ username: 'u1', name: 'weekly-report', description: '新描述' })
    const text = await readFile(path.join(workspace.skillScopeDir('u1', 'created'), 'weekly-report', 'SKILL.md'), 'utf8')
    assert.ok(text.includes('metadata: {"openclaw": {"emoji": "📊"}}'), 'metadata 块被动了')
  })
})

describe('停用要真的生效', () => {
  test('停用之后技能从这一轮的清单里消失', async () => {
    await seedSkill('u1', 'weekly-report')
    // frontmatter 的 name 才是技能标识，不是目录名 —— 两个技能必须给不同的 name，
    // 否则 loadSkills 装出来两个同名技能，停用一个会把两个都带走
    await seedSkill('u1', 'daily-report', { 'SKILL.md': SKILL_MD.replace('weekly-report', 'daily-report') })
    const { skills } = loadSkills({ dirs: workspace.skillDirs('u1'), logger: silentLogger })
    assert.deepEqual(skills.map((s) => s.name).sort(), ['daily-report', 'weekly-report'])

    await manager.setEnabled({ username: 'u1', name: 'weekly-report', enabled: false })
    const disabled = await manager.disabledNames('u1')
    const allowlist = skills.filter((s) => !disabled.has(s.name)).map((s) => s.name)
    // 这就是 run-service 里那一步：停用不是界面上灰掉，是真的不进系统提示
    assert.deepEqual(selectSkills({ skills, allowlist }).map((s) => s.name), ['daily-report'])
  })

  test('平台技能也能停用 —— 它不在用户目录里，但用户同样该能关掉', async () => {
    await manager.setEnabled({ username: 'u1', name: 'ap_http_bridge', enabled: false })
    assert.ok((await manager.disabledNames('u1')).has('ap_http_bridge'))
  })

  test('停用状态按 username 隔离', async () => {
    await manager.setEnabled({ username: 'u1', name: 'weekly-report', enabled: false })
    assert.equal((await manager.disabledNames('u2')).size, 0)
  })

  test('重新启用就恢复', async () => {
    await manager.setEnabled({ username: 'u1', name: 'weekly-report', enabled: false })
    await manager.setEnabled({ username: 'u1', name: 'weekly-report', enabled: true })
    assert.equal((await manager.disabledNames('u1')).size, 0)
  })

  test('删除技能会把它的停用记录一起清掉', async () => {
    // 不清的话，同名技能重建之后是关着的，而用户完全想不起来自己关过
    await seedSkill('u1', 'weekly-report')
    await manager.setEnabled({ username: 'u1', name: 'weekly-report', enabled: false })
    await manager.remove({ username: 'u1', name: 'weekly-report' })
    assert.equal((await manager.disabledNames('u1')).size, 0)
  })

  test('停用清单读不出来时不撤任何技能', async () => {
    // 把技能全关掉比多显示一个更糟
    await writeFile(path.join(workspace.userRoot('u1'), 'skills', 'state.json'), '{ 坏 JSON', { flag: 'w' })
      .catch(async () => {
        await mkdir(path.join(workspace.userRoot('u1'), 'skills'), { recursive: true })
        await writeFile(path.join(workspace.userRoot('u1'), 'skills', 'state.json'), '{ 坏 JSON')
      })
    assert.equal((await manager.disabledNames('u1')).size, 0)
  })
})

describe('删', () => {
  test('删掉之后装载器也扫不到了', async () => {
    await seedSkill('u1', 'weekly-report')
    await manager.remove({ username: 'u1', name: 'weekly-report' })
    const { skills } = loadSkills({ dirs: workspace.skillDirs('u1'), logger: silentLogger })
    assert.deepEqual(skills, [])
  })

  test('删别人的技能删不动', async () => {
    await seedSkill('u1', 'weekly-report')
    await assert.rejects(() => manager.remove({ username: 'u2', name: 'weekly-report' }), /不存在/)
    assert.ok(existsSync(path.join(workspace.skillScopeDir('u1', 'created'), 'weekly-report')))
  })
})

describe('越界一律顶回去', () => {
  const evilNames = ['../../etc', 'a/b', '..', '', '.', 'UPPER', 'has space', '-lead']

  for (const name of evilNames) {
    test(`技能名 ${JSON.stringify(name)} 被拒`, async () => {
      await assert.rejects(() => manager.read({ username: 'u1', name }), /不合法/)
      await assert.rejects(() => manager.remove({ username: 'u1', name }), /不合法/)
    })
  }

  const evilPaths = ['../evil.py', 'a/../../b.py', '/etc/passwd', '', 'x/'.repeat(200)]
  for (const rel of evilPaths) {
    test(`文件路径 ${JSON.stringify(rel.slice(0, 24))} 被拒`, async () => {
      await seedSkill('u1', 'weekly-report')
      await assert.rejects(
        () => manager.writeFiles({
          username: 'u1', name: 'weekly-report',
          files: [{ path: 'SKILL.md', content: SKILL_MD }, { path: rel, content: 'x' }],
        }),
        /越界|不能为空|过长|必须是相对路径/,
      )
    })
  }

  test('写越界路径时一个字节都没落盘', async () => {
    // 校验必须在**写之前**全部做完。边写边校验的话，前几个文件已经出去了
    await seedSkill('u1', 'weekly-report')
    await assert.rejects(() => manager.writeFiles({
      username: 'u1', name: 'weekly-report',
      files: [{ path: 'SKILL.md', content: 'NEW' }, { path: '../escaped.py', content: 'x' }],
    }))
    const text = await readFile(path.join(workspace.skillScopeDir('u1', 'created'), 'weekly-report', 'SKILL.md'), 'utf8')
    assert.equal(text, SKILL_MD, 'SKILL.md 已经被改了，说明校验发生在写之后')
    assert.ok(!existsSync(path.join(workspace.skillScopeDir('u1', 'created'), 'escaped.py')))
  })
})

describe('没有工作空间时', () => {
  test('整体关闭，且报的是 503 不是 500', async () => {
    const off = createDisabledSkillManager()
    assert.equal(off.enabled, false)
    assert.equal((await off.disabledNames('u1')).size, 0)
    await assert.rejects(() => off.read({ username: 'u1', name: 'x' }), (error) => {
      assert.equal(error.status, 503)
      return true
    })
  })
})
