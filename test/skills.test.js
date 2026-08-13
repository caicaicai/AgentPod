/**
 * 技能打通链路：装载 → 进系统提示 → 铺进沙盒 → 被 read 读到、被 bash 跑到。
 *
 * 这条链上任何一环断了，技能就是"配了但不能用"，而且**不会报错** ——
 * 模型只会照着 SKILL.md 执行，然后一路 `No such file or directory`。
 * 所以这里既测每一环，也测端到端。
 *
 * 最要紧的三条：
 *   1. 系统提示里的技能位置必须是**相对工作区根**的路径。绝对路径两端对不上：
 *      agent 侧是 /tmp/ap-run-xxx/workspace，沙盒侧是 worker 分配的目录。
 *   2. 技能的 scripts/ 必须真的落在沙盒里，且**在第一条命令执行之前**落好。
 *   3. 搬运是懒的 —— 纯聊天的 run 不该为此占一个沙盒槽位。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { registerFauxProvider, fauxAssistantMessage, fauxToolCall } from '@mariozechner/pi-ai'

import { runTurn } from '../src/agent/run-turn.js'
import { loadSkills } from '../src/agent/skills.js'
import { toSandboxSkills, attachSkillMaterialization, SKILLS_ROOT } from '../src/agent/skill-materializer.js'
import { createMemorySessionStore as createMemoryStore } from './helpers/memory-session-store.js'
import { buildModel } from '../src/models/model-factory.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

let faux
let model
let skillsRoot
/** 非空 = 本机建不了软链接，那条依赖软链接的断言要降级（见 setup 里的说明） */
let symlinkNote = ''

before(async () => {
  faux = registerFauxProvider({
    api: 'openai-completions',
    provider: 'ap-gateway',
    models: [{ id: 'test-model', name: 'test', contextWindow: 100000, maxTokens: 2048 }],
    tokensPerSecond: 100000,
  })
  model = buildModel({ model: 'test-model', server: faux.getModel().baseUrl, key: 'k' })
  model.provider = faux.getModel().provider
  model.api = faux.getModel().api

  // 照着 managed-skills 的真实形状搭：SKILL.md + scripts/，外加几样不该被搬走的东西
  skillsRoot = await mkdtemp(path.join(tmpdir(), 'ap-skills-'))
  const demo = path.join(skillsRoot, 'demo-skill')
  await mkdir(path.join(demo, 'scripts'), { recursive: true })
  await writeFile(
    path.join(demo, 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: 演示技能，用于验证技能目录能被搬进沙盒并执行。用户说"跑一下演示技能"时使用。',
      '---',
      '',
      '# demo-skill',
      '',
      '```bash',
      'cd skills/demo-skill',
      'bash scripts/run.sh',
      '```',
    ].join('\n'),
  )
  await writeFile(path.join(demo, 'scripts', 'run.sh'), '#!/usr/bin/env bash\necho demo-ok\n')
  await writeFile(path.join(demo, 'scripts', 'lib.py'), 'VALUE = 1\n')

  // 这三样都不该出现在沙盒里
  await mkdir(path.join(demo, 'node_modules'), { recursive: true })
  await writeFile(path.join(demo, 'node_modules', 'junk.js'), 'x')
  await mkdir(path.join(demo, '__pycache__'), { recursive: true })
  await writeFile(path.join(demo, '__pycache__', 'lib.pyc'), 'x')
  /**
   * ⚠️ 建软链接**必须是尽力而为**。
   *
   * Windows 上非管理员、又没开开发者模式时，symlink 直接 EPERM。而这一句
   * 待在共用的 setup 里 —— 它一抛，这个文件里全部 24 条用例会以
   * "test did not finish before its parent and was cancelled" 一起消失，
   * 报错还指向 setup，看不出跟软链接有任何关系。
   *
   * 这个夹具只服务下面**一条**断言。建不了就记下来，那一条降级，其余照跑。
   */
  try {
    await symlink('/etc/passwd', path.join(demo, 'escape.txt'))
    symlinkNote = ''
  } catch (error) {
    symlinkNote = `本机建不了软链接（${error.code}）——Windows 非管理员且未开开发者模式时如此`
  }
})

after(async () => {
  faux?.unregister()
  await rm(skillsRoot, { recursive: true, force: true })
})

/** 把沙盒工作区当成一个 Map；记录每一次调用的先后顺序 */
function fakeSandbox() {
  const files = new Map()
  const calls = []
  return {
    mode: 'http',
    files,
    calls,
    async exec({ command }) {
      calls.push({ op: 'exec', command })
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    async putFiles(list) {
      calls.push({ op: 'putFiles', paths: list.map((f) => f.path) })
      for (const f of list) files.set(f.path, Buffer.from(f.content))
      return { ok: true, count: list.length }
    },
    async putFile({ path: p, content }) {
      calls.push({ op: 'putFile', path: p })
      files.set(p, Buffer.from(content))
      return { ok: true }
    },
    async getFile({ path: p }) {
      calls.push({ op: 'getFile', path: p })
      if (!files.has(p)) {
        const error = new Error(`沙盒里没有文件 ${p}`)
        error.code = 'NOT_FOUND'
        throw error
      }
      return { path: p, content: files.get(p) }
    },
    async statFile({ path: p }) {
      calls.push({ op: 'statFile', path: p })
      if (!files.has(p)) throw new Error(`沙盒里没有 ${p}`)
      return { path: p, kind: 'file', size: files.get(p).length }
    },
    async browserAction(action) {
      calls.push({ op: 'browser', action })
      return { ok: true }
    },
    async release() {},
  }
}

describe('技能装载与路径改写', () => {
  test('从目录读到技能，name/description 来自 frontmatter', () => {
    const { skills } = loadSkills({ dirs: [skillsRoot], logger: silentLogger })
    const demo = skills.find((s) => s.name === 'demo-skill')
    assert.ok(demo, '没读到 demo-skill')
    assert.match(demo.description, /演示技能/)
  })

  test('位置改写成相对工作区根 —— 绝对路径两端对不上', () => {
    const { skills } = loadSkills({ dirs: [skillsRoot], logger: silentLogger })
    const [demo] = toSandboxSkills(skills.filter((s) => s.name === 'demo-skill'))

    assert.equal(demo.filePath, 'skills/demo-skill/SKILL.md')
    assert.equal(demo.baseDir, 'skills/demo-skill')
    assert.ok(!path.isAbsolute(demo.filePath), '技能位置不能是绝对路径')
    // 描述必须原样保留：模型是靠它判断该不该用这个技能的
    assert.match(demo.description, /演示技能/)
  })

  test('SKILLS_ROOT 是 skills —— SKILL.md 里写死了 cd skills/<name>', () => {
    assert.equal(SKILLS_ROOT, 'skills')
  })
})

describe('技能铺进沙盒', () => {
  let skills
  let sandbox
  let session

  beforeEach(() => {
    skills = loadSkills({ dirs: [skillsRoot], logger: silentLogger }).skills
    sandbox = fakeSandbox()
    session = attachSkillMaterialization({ session: sandbox, skills, logger: silentLogger })
  })

  test('懒搬：没碰沙盒之前一个文件都不推', async () => {
    // 必须真的等一会儿再断言。搬运是异步的，套完壳立刻检查的话，
    // 就算实现改成了饿汉式（构造时就 ensure()），putFiles 也还没来得及发出去 ——
    // 这条用例会绿得毫无道理。等一段静默期才是对"什么都没发生"的诚实检验。
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(sandbox.calls, [], '还没用沙盒就推文件了 —— 纯聊天的 run 会白占槽位')
  })

  test('第一次 exec 之前技能已经就位', async () => {
    await session.exec({ command: 'cd skills/demo-skill && bash scripts/run.sh' })

    const put = sandbox.calls.findIndex((c) => c.op === 'putFiles')
    const exec = sandbox.calls.findIndex((c) => c.op === 'exec')
    assert.ok(put >= 0, '没有把技能推进沙盒')
    assert.ok(put < exec, '命令跑在了技能铺好之前 —— 脚本会 No such file or directory')
  })

  test('scripts/ 里的脚本真的落到了沙盒里', async () => {
    await session.exec({ command: 'true' })

    assert.equal(sandbox.files.get('skills/demo-skill/SKILL.md').toString().includes('# demo-skill'), true)
    assert.equal(sandbox.files.get('skills/demo-skill/scripts/run.sh').toString(), '#!/usr/bin/env bash\necho demo-ok\n')
    assert.equal(sandbox.files.get('skills/demo-skill/scripts/lib.py').toString(), 'VALUE = 1\n')
  })

  test('node_modules / __pycache__ / 软链接都不搬', async (t) => {
    await session.exec({ command: 'true' })

    const paths = [...sandbox.files.keys()]
    assert.ok(!paths.some((p) => p.includes('node_modules')), 'node_modules 被搬进沙盒了')
    assert.ok(!paths.some((p) => p.includes('__pycache__')), '__pycache__ 被搬进沙盒了')
    // 软链接尤其要紧：跟着走等于把 agent 主机上任意路径的文件搬进沙盒。
    // 这一条要有软链接才测得了；建不了就**说出来**，而不是静悄悄地当它通过了
    if (symlinkNote) t.diagnostic(`跳过软链接那一项：${symlinkNote}`)
    else assert.ok(!paths.some((p) => p.endsWith('escape.txt')), '技能目录里的软链接被跟进去了')
  })

  test('只搬一次 —— 后续命令不重复推', async () => {
    await session.exec({ command: 'a' })
    await session.exec({ command: 'b' })
    await session.getFile({ path: 'skills/demo-skill/SKILL.md' })

    const puts = sandbox.calls.filter((c) => c.op === 'putFiles')
    assert.equal(puts.length, 1, `技能被推了 ${puts.length} 次`)
  })

  test('read 走的是沙盒里那份', async () => {
    const file = await session.getFile({ path: 'skills/demo-skill/SKILL.md' })
    assert.match(file.content.toString(), /cd skills\/demo-skill/)
  })

  test('写文件和开浏览器不触发搬运 —— 跟技能在不在场没关系', async () => {
    await session.putFile({ path: 'a.txt', content: 'x' })
    await session.browserAction('open', { url: 'http://x' })

    assert.ok(!sandbox.calls.some((c) => c.op === 'putFiles'), '不该为这两个操作付搬运代价')
  })

  test('没有技能时原样返回会话，不套壳', () => {
    const bare = fakeSandbox()
    assert.equal(attachSkillMaterialization({ session: bare, skills: [], logger: silentLogger }), bare)
  })

  test('透传未覆盖的方法（release / browserAction 等）', async () => {
    assert.equal(session.mode, 'http')
    assert.equal(typeof session.release, 'function')
    await session.browserAction('close')
    assert.ok(sandbox.calls.some((c) => c.op === 'browser'))
  })

  test('搬运失败可重试，不会把这一轮永久钉死', async () => {
    let fail = true
    const flaky = fakeSandbox()
    flaky.putFiles = async (list) => {
      if (fail) throw new Error('沙盒暂时不可用')
      flaky.calls.push({ op: 'putFiles', paths: list.map((f) => f.path) })
      for (const f of list) flaky.files.set(f.path, Buffer.from(f.content))
      return { ok: true }
    }
    const s = attachSkillMaterialization({ session: flaky, skills, logger: silentLogger })

    await assert.rejects(() => s.exec({ command: 'x' }), /沙盒暂时不可用/)
    fail = false
    await s.exec({ command: 'x' })
    assert.ok(flaky.files.has('skills/demo-skill/scripts/run.sh'), '重试之后技能应该就位')
  })
})

describe('.venv 软链接（joymail 系技能的 run.sh 写死了这个路径）', () => {
  test('技能引用了 .venv 就建软链接', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ap-venv-skill-'))
    try {
      const dir = path.join(root, 'venv-skill')
      await mkdir(path.join(dir, 'scripts'), { recursive: true })
      await writeFile(
        path.join(dir, 'SKILL.md'),
        '---\nname: venv-skill\ndescription: 需要 python 虚拟环境的演示技能，用户说跑一下时使用。\n---\n# venv-skill\n',
      )
      // 与 managed-skills/joymail-*/scripts/run.sh 同样的写法
      await writeFile(path.join(dir, 'scripts', 'run.sh'), 'VENV_PYTHON="$SKILLS_DIR/.venv/bin/python3"\n')

      const { skills } = loadSkills({ dirs: [root], logger: silentLogger })
      const sandbox = fakeSandbox()
      const session = attachSkillMaterialization({ session: sandbox, skills, logger: silentLogger })
      await session.exec({ command: 'true' })

      const link = sandbox.calls.find((c) => c.op === 'exec' && c.command.includes('ln -sfn'))
      assert.ok(link, '没有建 skills/.venv 软链接 —— joymail 系技能会直接 ENV_NOT_READY')
      assert.match(link.command, /AP_PYTHON_BIN/, '应当用 worker 注入的 AP_PYTHON_BIN 定位解释器')
      assert.match(link.command, /skills\/\.venv/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('技能不需要 venv 就不多跑这一条命令', async () => {
    const skills = loadSkills({ dirs: [skillsRoot], logger: silentLogger }).skills
    const sandbox = fakeSandbox()
    const session = attachSkillMaterialization({ session: sandbox, skills, logger: silentLogger })
    await session.exec({ command: 'true' })

    assert.ok(!sandbox.calls.some((c) => c.op === 'exec' && c.command.includes('ln -sfn')), '不该无条件付这个来回')
  })
})

describe('端到端：模型看得见技能，也用得上', () => {
  function baseArgs(store, sandbox, skills) {
    return { model, store, sandbox, skills, logger: silentLogger, timeoutMs: 30000 }
  }

  test('技能清单进系统提示，位置是相对路径', async () => {
    let systemPrompt = ''
    const responder = (context) => {
      systemPrompt = context.systemPrompt || ''
      return fauxAssistantMessage('好的')
    }
    faux.setResponses([responder])

    const skills = loadSkills({ dirs: [skillsRoot], logger: silentLogger }).skills
    await runTurn({
      ...baseArgs(createMemoryStore(), fakeSandbox(), skills),
      runId: 's1', username: 'userS', prompt: '你能做什么',
    })

    assert.match(systemPrompt, /<available_skills>/, '系统提示里没有技能清单')
    assert.match(systemPrompt, /demo-skill/)
    assert.match(systemPrompt, /<location>skills\/demo-skill\/SKILL\.md<\/location>/,
      '技能位置必须是相对工作区根的路径，绝对路径在沙盒里不存在')
  })

  test('模型 read 技能位置 → 读到沙盒里那份', async () => {
    let readBack = ''
    let usedLocation = ''
    const responder = (context) => {
      faux.appendResponses([responder])
      const done = (context.messages || []).some((m) => m.role === 'toolResult')
      if (done) {
        for (const m of context.messages) {
          if (m.role !== 'toolResult') continue
          const text = JSON.stringify(m.content || m.output || '')
          if (text.includes('demo-skill')) readBack = text
        }
        return fauxAssistantMessage('读到了')
      }
      // 关键：位置**从系统提示里现读**，不写死。
      // 写死的话，即便宣告出去的是个沙盒里根本不存在的绝对路径，这条用例照样绿。
      usedLocation = (context.systemPrompt || '').match(/<location>([^<]*demo-skill[^<]*)<\/location>/)?.[1] || ''
      return fauxAssistantMessage([fauxToolCall('read', { path: usedLocation })], { stopReason: 'toolUse' })
    }
    faux.setResponses([responder])

    const skills = loadSkills({ dirs: [skillsRoot], logger: silentLogger }).skills
    const sandbox = fakeSandbox()
    await runTurn({
      ...baseArgs(createMemoryStore(), sandbox, skills),
      runId: 's2', username: 'userS', prompt: '跑一下演示技能',
    })

    assert.ok(usedLocation, '系统提示里没给出 demo-skill 的位置')
    assert.match(readBack, /cd skills/, `照系统提示给的位置 ${usedLocation} 读不到技能正文`)
    assert.ok(sandbox.files.has('skills/demo-skill/SKILL.md'), '技能没被铺进沙盒')
  })

  test('模型按 SKILL.md 执行 → 脚本已经在沙盒里', async () => {
    const responder = (context) => {
      faux.appendResponses([responder])
      const done = (context.messages || []).some((m) => m.role === 'toolResult')
      if (done) return fauxAssistantMessage('执行完了')
      return fauxAssistantMessage(
        [fauxToolCall('bash', { command: 'cd skills/demo-skill && bash scripts/run.sh' })],
        { stopReason: 'toolUse' },
      )
    }
    faux.setResponses([responder])

    const skills = loadSkills({ dirs: [skillsRoot], logger: silentLogger }).skills
    const sandbox = fakeSandbox()
    await runTurn({
      ...baseArgs(createMemoryStore(), sandbox, skills),
      runId: 's3', username: 'userS', prompt: '跑一下演示技能',
    })

    assert.ok(sandbox.files.has('skills/demo-skill/scripts/run.sh'), '脚本不在沙盒里，命令必然 No such file or directory')
    const put = sandbox.calls.findIndex((c) => c.op === 'putFiles')
    const exec = sandbox.calls.findIndex((c) => c.op === 'exec')
    assert.ok(put >= 0 && put < exec, '脚本必须在命令执行前就位')
  })

  test('没有沙盒就不宣告技能 —— 免得模型对着跑不了的东西反复试', async () => {
    let systemPrompt = ''
    faux.setResponses([(context) => {
      systemPrompt = context.systemPrompt || ''
      return fauxAssistantMessage('好的')
    }])

    const skills = loadSkills({ dirs: [skillsRoot], logger: silentLogger }).skills
    await runTurn({
      ...baseArgs(createMemoryStore(), { mode: 'none' }, skills),
      runId: 's4', username: 'userS', prompt: '你能做什么',
    })

    assert.ok(!systemPrompt.includes('demo-skill'), '没有执行端却把技能宣告出去了')
  })

  test('不扫本机磁盘找技能 —— 只认配置里给的那些', async () => {
    let systemPrompt = ''
    faux.setResponses([(context) => {
      systemPrompt = context.systemPrompt || ''
      return fauxAssistantMessage('好的')
    }])

    await runTurn({
      ...baseArgs(createMemoryStore(), fakeSandbox(), []),
      runId: 's5', username: 'userS', prompt: '你能做什么',
    })

    assert.ok(!systemPrompt.includes('<available_skills>'), '没配技能却冒出来一份清单 —— loader 在扫宿主机磁盘')
  })
})
