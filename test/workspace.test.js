/**
 * 用户工作空间：跨 run 存活的那一份数据。
 *
 * 这里每一条测的都是"坏了会安静地坏"的地方：
 *   1. **跨用户越界** —— username / 沙盒报回来的路径都能被拼成别人的目录
 *   2. **静默丢数据** —— 镜像删除在看不全的时候必须退化成只增不删
 *   3. **配额** —— 共享盘没有 per-user quota，一个人写满就是所有人一起挂
 *   4. **软链接** —— 沙盒里跑的是用户写的代码，它能 ln -s 到任意位置
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createWorkspaceStore, WORKSPACE_DIR } from '../src/workspace/store.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

let root
let store

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ap-ws-'))
  store = createWorkspaceStore({
    config: { userWorkspace: { root, quotaBytes: 4096, maxFiles: 100, maxSyncFiles: 10 } },
    logger: silentLogger,
  })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 一个假沙盒会话：只实现 syncBack 用到的那两个方法 */
function fakeSession(files, { truncated = false } = {}) {
  const items = files.map((file) => ({
    path: `${WORKSPACE_DIR}/${file.rel}`,
    kind: file.kind || 'file',
    size: Buffer.byteLength(file.content ?? ''),
  }))
  return {
    async listFiles() {
      return { items, truncated }
    },
    async getFiles(paths) {
      return paths.map((p) => {
        const hit = files.find((file) => `${WORKSPACE_DIR}/${file.rel}` === p)
        return hit
          ? { path: p, ok: true, content: Buffer.from(hit.content) }
          : { path: p, ok: false, error: 'not-found' }
      })
    },
  }
}

const sessionFile = (username, key, rel) => path.join(root, 'users', username, 'sessions', key, WORKSPACE_DIR, rel)

describe('跨用户越界', () => {
  test('username 不能是带路径的东西', () => {
    for (const bad of ['../other', 'a/b', '..', '.', '', 'x'.repeat(65)]) {
      assert.throws(() => store.userRoot(bad), /目录名|username/, `${JSON.stringify(bad)} 应当被拒`)
    }
  })

  test('sessionKey 同样收口', () => {
    assert.throws(() => store.sessionWorkspaceDir('u1', '../../etc'), /目录名|sessionKey/)
  })

  test('沙盒报回来的相对路径不能指向别的用户', async () => {
    // 沙盒里跑的是用户/模型写的代码，它能造出任意名字的文件；
    // 照单全收就是拿别人的目录当写入目标
    const session = fakeSession([{ rel: '../../../victim/sessions/s/workspace/stolen.txt', content: 'x' }])
    await assert.rejects(
      store.syncBack({ username: 'u1', sessionKey: 's', session, runId: 'r1' }),
      /越界/,
    )
    // 确认真的没写出去
    await assert.rejects(readFile(path.join(root, 'users', 'victim', 'sessions', 's', 'workspace', 'stolen.txt')))
  })
})

describe('stage：工作区 → 沙盒', () => {
  test('把上一轮留下的文件推给沙盒，路径带 workspace/ 前缀', async () => {
    await mkdir(path.dirname(sessionFile('u1', 's1', 'notes/a.txt')), { recursive: true })
    await writeFile(sessionFile('u1', 's1', 'notes/a.txt'), 'hello')

    const staged = await store.stageFiles({ username: 'u1', sessionKey: 's1' })
    assert.deepEqual(staged.map((file) => file.path), ['workspace/notes/a.txt'])
    assert.equal(staged[0].content.toString(), 'hello')
  })

  test('新用户没有目录，返回空而不是抛异常', async () => {
    assert.deepEqual(await store.stageFiles({ username: 'newbie', sessionKey: 's1' }), [])
  })

  test('软链接不跟着走 —— 否则等于让沙盒里的代码指定我们读共享盘的哪一块', async () => {
    const dir = path.join(root, 'users', 'u1', 'sessions', 's1', WORKSPACE_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'real.txt'), 'ok')
    await symlink('/etc/passwd', path.join(dir, 'sneaky.txt'))

    const staged = await store.stageFiles({ username: 'u1', sessionKey: 's1' })
    assert.deepEqual(staged.map((file) => file.path), ['workspace/real.txt'])
  })
})

describe('syncBack：沙盒 → 工作区', () => {
  test('写回来，下一轮 stage 就能拿到（这就是"接着干"）', async () => {
    const session = fakeSession([{ rel: 'out/result.json', content: '{"ok":true}' }])
    const result = await store.syncBack({ username: 'u1', sessionKey: 's1', session, runId: 'r1' })
    assert.equal(result.written, 1)

    const staged = await store.stageFiles({ username: 'u1', sessionKey: 's1' })
    assert.deepEqual(staged.map((file) => file.path), ['workspace/out/result.json'])
  })

  test('两个会话互不干扰', async () => {
    await store.syncBack({ username: 'u1', sessionKey: 'sA', session: fakeSession([{ rel: 'a.txt', content: 'A' }]), runId: 'r' })
    await store.syncBack({ username: 'u1', sessionKey: 'sB', session: fakeSession([{ rel: 'b.txt', content: 'B' }]), runId: 'r' })

    assert.deepEqual((await store.stageFiles({ username: 'u1', sessionKey: 'sA' })).map((f) => f.path), ['workspace/a.txt'])
    assert.deepEqual((await store.stageFiles({ username: 'u1', sessionKey: 'sB' })).map((f) => f.path), ['workspace/b.txt'])
  })

  test('沙盒里删掉的，上游也删（镜像语义）', async () => {
    await store.syncBack({ username: 'u1', sessionKey: 's1', session: fakeSession([
      { rel: 'keep.txt', content: 'k' },
      { rel: 'gone.txt', content: 'g' },
    ]), runId: 'r1' })

    const after = await store.syncBack({ username: 'u1', sessionKey: 's1', session: fakeSession([
      { rel: 'keep.txt', content: 'k' },
    ]), runId: 'r2' })

    assert.equal(after.deleted, 1)
    assert.deepEqual((await store.stageFiles({ username: 'u1', sessionKey: 's1' })).map((f) => f.path), ['workspace/keep.txt'])
  })

  test('列表被截断时只增不删 —— 删了就是删掉没看见的那些', async () => {
    await store.syncBack({ username: 'u1', sessionKey: 's1', session: fakeSession([
      { rel: 'a.txt', content: 'a' },
      { rel: 'b.txt', content: 'b' },
    ]), runId: 'r1' })

    const after = await store.syncBack({
      username: 'u1',
      sessionKey: 's1',
      session: fakeSession([{ rel: 'a.txt', content: 'a' }], { truncated: true }),
      runId: 'r2',
    })
    assert.equal(after.deleted, 0)
    assert.equal(after.truncated, true)
    // b.txt 没被看见，但它还在
    const left = (await store.stageFiles({ username: 'u1', sessionKey: 's1' })).map((f) => f.path)
    assert.deepEqual(left.sort(), ['workspace/a.txt', 'workspace/b.txt'])
  })

  test('沙盒回空列表而上游有东西时不清空 —— 那更可能是这轮没碰工作区', async () => {
    await store.syncBack({ username: 'u1', sessionKey: 's1', session: fakeSession([{ rel: 'important.txt', content: 'x' }]), runId: 'r1' })

    const after = await store.syncBack({ username: 'u1', sessionKey: 's1', session: fakeSession([]), runId: 'r2' })
    assert.equal(after.deleted, 0)
    assert.deepEqual(
      (await store.stageFiles({ username: 'u1', sessionKey: 's1' })).map((f) => f.path),
      ['workspace/important.txt'],
    )
  })

  test('沙盒里的软链接不回写', async () => {
    const session = fakeSession([
      { rel: 'real.txt', content: 'ok' },
      { rel: 'link.txt', content: '', kind: 'symlink' },
    ])
    await store.syncBack({ username: 'u1', sessionKey: 's1', session, runId: 'r1' })
    assert.deepEqual((await store.stageFiles({ username: 'u1', sessionKey: 's1' })).map((f) => f.path), ['workspace/real.txt'])
  })

  test('沙盒没建过 workspace/ 是正常情况，不当错误', async () => {
    const session = {
      async listFiles() { throw Object.assign(new Error('沙盒里没有目录 workspace'), { code: 'NOT_FOUND' }) },
      async getFiles() { return [] },
    }
    const result = await store.syncBack({ username: 'u1', sessionKey: 's1', session, runId: 'r1' })
    assert.equal(result.empty, true)
  })

  test('不留临时文件 —— 原子写用的 .tmp 必须已经 rename 掉', async () => {
    await store.syncBack({ username: 'u1', sessionKey: 's1', session: fakeSession([{ rel: 'a.txt', content: 'a' }]), runId: 'r1' })
    const entries = await readdir(path.join(root, 'users', 'u1', 'sessions', 's1', WORKSPACE_DIR))
    assert.deepEqual(entries, ['a.txt'])
  })
})

describe('配额', () => {
  test('超了就拒绝，并说清楚为什么', async () => {
    const big = 'x'.repeat(5000) // quotaBytes 是 4096
    await assert.rejects(
      store.syncBack({ username: 'u1', sessionKey: 's1', session: fakeSession([{ rel: 'big.bin', content: big }]), runId: 'r1' }),
      /配额不足/,
    )
  })

  test('反复改同一个文件不该被算成一直在涨', async () => {
    const content = 'y'.repeat(3000)
    await store.syncBack({ username: 'u1', sessionKey: 's1', session: fakeSession([{ rel: 'f.bin', content }]), runId: 'r1' })
    // 同一个文件再写一遍：换掉而不是叠加，所以仍在 4096 以内
    const again = await store.syncBack({ username: 'u1', sessionKey: 's1', session: fakeSession([{ rel: 'f.bin', content }]), runId: 'r2' })
    assert.equal(again.written, 1)
  })

  test('单轮文件数有上限', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ rel: `f${i}.txt`, content: 'x' }))
    await assert.rejects(
      store.syncBack({ username: 'u1', sessionKey: 's1', session: fakeSession(many), runId: 'r1' }),
      /超过单次同步上限/,
    )
  })

  test('usage 报的是这个人的真实占用', async () => {
    await store.syncBack({ username: 'u1', sessionKey: 's1', session: fakeSession([{ rel: 'a.txt', content: 'abcde' }]), runId: 'r1' })
    await store.syncBack({ username: 'u2', sessionKey: 's1', session: fakeSession([{ rel: 'b.txt', content: 'xy' }]), runId: 'r1' })
    assert.equal((await store.usage('u1')).bytes, 5)
    assert.equal((await store.usage('u2')).bytes, 2)
  })
})

describe('个人技能', () => {
  test('发布之后 skillDirs 里能扫到，且落在自己的目录下', async () => {
    await store.writeSkillFiles({
      username: 'u1',
      scope: 'created',
      name: 'my-skill',
      files: [
        { relPath: 'SKILL.md', content: Buffer.from('---\nname: my-skill\ndescription: d\n---\n') },
        { relPath: 'scripts/run.sh', content: Buffer.from('echo hi') },
      ],
    })
    const dirs = store.skillDirs('u1')
    assert.equal(dirs.length, 2)
    assert.ok(dirs[0].endsWith(path.join('users', 'u1', 'skills', 'created')))
    assert.equal(
      (await readFile(path.join(dirs[0], 'my-skill', 'scripts', 'run.sh'), 'utf8')),
      'echo hi',
    )
  })

  test('重新发布是覆盖，不是叠加 —— 上一版的脚本不能留在里面', async () => {
    const write = (files) => store.writeSkillFiles({ username: 'u1', scope: 'created', name: 'demo', files })
    await write([
      { relPath: 'SKILL.md', content: Buffer.from('v1') },
      { relPath: 'old.py', content: Buffer.from('旧脚本') },
    ])
    await write([{ relPath: 'SKILL.md', content: Buffer.from('v2') }])

    const dir = path.join(store.skillDirs('u1')[0], 'demo')
    assert.deepEqual(await readdir(dir), ['SKILL.md'])
    assert.equal(await readFile(path.join(dir, 'SKILL.md'), 'utf8'), 'v2')
  })

  test('展示名两种写法都要认 —— 只认带引号的会让中文名静默丢掉', async () => {
    const { loadSkills, describeSkills } = await import('../src/agent/skills.js')
    await store.writeSkillFiles({
      username: 'u1',
      scope: 'created',
      name: 'weekly',
      files: [{
        relPath: 'SKILL.md',
        content: Buffer.from(
          '---\n' +
          'name: weekly\n' +
          'displayName: 周报助手\n' + // 顶层 YAML 行，不带引号（桌面端就是这么写的）
          'description: 生成本周工作周报。用户说"写周报"时使用。\n' +
          'metadata: { "openclaw": { "emoji": "📅" } }\n' + // JSON 块，带引号
          '---\n正文\n',
        ),
      }],
    })
    const { skills } = loadSkills({ dirs: store.skillDirs('u1'), logger: silentLogger })
    const [described] = describeSkills(skills)
    assert.equal(described.displayName, '周报助手')
    assert.equal(described.emoji, '📅')
  })

  test('技能名不能是路径', async () => {
    await assert.rejects(
      store.writeSkillFiles({ username: 'u1', scope: 'created', name: '../../escape', files: [] }),
      /目录名|技能名/,
    )
  })

  test('删会话会连带删掉它的工作区', async () => {
    await store.syncBack({ username: 'u1', sessionKey: 's1', session: fakeSession([{ rel: 'a.txt', content: 'a' }]), runId: 'r' })
    await store.removeSession({ username: 'u1', sessionKey: 's1' })
    assert.deepEqual(await store.stageFiles({ username: 'u1', sessionKey: 's1' }), [])
  })
})

/* ─────────── 与 runTurn 的接线 ─────────── */

describe('run 收尾的顺序', () => {
  /** 记录每一步发生的顺序，用来验"回写排在 release 之前" */
  function recordingSandbox({ leased = true, files = [] } = {}) {
    const order = []
    return {
      order,
      mode: 'http',
      leased,
      async listFiles() {
        order.push('listFiles')
        return {
          items: files.map((file) => ({
            path: `${WORKSPACE_DIR}/${file.rel}`,
            kind: 'file',
            size: Buffer.byteLength(file.content),
          })),
        }
      },
      async getFiles(paths) {
        order.push('getFiles')
        return paths.map((p) => {
          const hit = files.find((file) => `${WORKSPACE_DIR}/${file.rel}` === p)
          return { path: p, ok: true, content: Buffer.from(hit?.content ?? '') }
        })
      },
      async putFiles() { order.push('putFiles'); return { ok: true } },
      async exec() { order.push('exec'); return { exitCode: 0 } },
      async release() { order.push('release') },
    }
  }

  test('回写必须排在 release 之前 —— release 是整个 slot 销毁重建，之后什么都捞不到', async () => {
    const { runTurn } = await import('../src/agent/run-turn.js')
    const { createMemoryStore } = await import('../src/sessions/store.js')
    const { registerFauxProvider, fauxAssistantMessage } = await import('@mariozechner/pi-ai')
    const { buildModel } = await import('../src/models/model-factory.js')

    const faux = registerFauxProvider({
      api: 'openai-completions',
      provider: 'ws-test',
      models: [{ id: 'm', name: 'm', contextWindow: 100000, maxTokens: 2048 }],
      tokensPerSecond: 100000,
    })
    faux.setResponses([() => fauxAssistantMessage('好')])
    const model = buildModel({ model: 'm', server: faux.getModel().baseUrl, key: 'k' })
    model.provider = faux.getModel().provider
    model.api = faux.getModel().api

    const sandbox = recordingSandbox({ files: [{ rel: 'out.txt', content: '产出' }] })
    await runTurn({
      runId: 'r1',
      username: 'u1',
      sessionKey: 's1',
      prompt: '你好',
      model,
      store: createMemoryStore(),
      sandbox,
      workspace: store,
      logger: silentLogger,
      timeoutMs: 30000,
    })

    const listed = sandbox.order.indexOf('listFiles')
    const released = sandbox.order.indexOf('release')
    assert.ok(listed >= 0, '压根没试着回写')
    assert.ok(listed < released, `回写排在了 release 之后：${sandbox.order.join(' → ')}`)
    // 而且真的落盘了
    assert.deepEqual(
      (await store.stageFiles({ username: 'u1', sessionKey: 's1' })).map((f) => f.path),
      ['workspace/out.txt'],
    )
  })

  test('没占过槽位就别回写 —— 否则纯聊天的 run 会为了同步空目录白申请一个租约', async () => {
    const { runTurn } = await import('../src/agent/run-turn.js')
    const { createMemoryStore } = await import('../src/sessions/store.js')
    const { registerFauxProvider, fauxAssistantMessage } = await import('@mariozechner/pi-ai')
    const { buildModel } = await import('../src/models/model-factory.js')

    const faux = registerFauxProvider({
      api: 'openai-completions',
      provider: 'ws-test-2',
      models: [{ id: 'm2', name: 'm2', contextWindow: 100000, maxTokens: 2048 }],
      tokensPerSecond: 100000,
    })
    faux.setResponses([() => fauxAssistantMessage('纯聊天')])
    const model = buildModel({ model: 'm2', server: faux.getModel().baseUrl, key: 'k' })
    model.provider = faux.getModel().provider
    model.api = faux.getModel().api

    const sandbox = recordingSandbox({ leased: false })
    await runTurn({
      runId: 'r2',
      username: 'u1',
      sessionKey: 's2',
      prompt: '你好',
      model,
      store: createMemoryStore(),
      sandbox,
      workspace: store,
      logger: silentLogger,
      timeoutMs: 30000,
    })

    assert.ok(!sandbox.order.includes('listFiles'), `不该碰沙盒：${sandbox.order.join(' → ')}`)
  })
})

describe('未配置时整体关闭', () => {
  test('没有 USER_WORKSPACE_ROOT 就什么都不做，行为与没有这个功能时一致', async () => {
    const off = createWorkspaceStore({ config: { userWorkspace: { root: '' } }, logger: silentLogger })
    assert.equal(off.enabled, false)
    assert.deepEqual(off.skillDirs('u1'), [])
    assert.deepEqual(await off.stageFiles({ username: 'u1', sessionKey: 's' }), [])
    assert.equal((await off.syncBack({ username: 'u1', sessionKey: 's', session: fakeSession([]) })).skipped, true)
  })
})
