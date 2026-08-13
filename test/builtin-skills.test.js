/**
 * `builtin-skills/` 的守卫。
 *
 * ── 这里真正要防的事 ──────────────────────────────────────────────────
 *
 * `src/tools/index.js` 的能力闸门说：后端没上云的工具不注册，因为"注册了只会让
 * 模型反复尝试、每次拿回一句 501，白烧 token 又把对话带偏"。
 *
 * **技能是同一件事的另一半。** 一份讲 `artifact_create` 怎么用的 SKILL.md，
 * 在没有 artifact 工具的环境里比不放更糟：模型会认真按它执行，然后卡在
 * "工具不存在"上重试，而用户看到的只是助手莫名其妙地失败 —— 日志里也查不出
 * 是哪份 SKILL.md 把它带过去的。
 *
 * 所以下面第二组用例把"技能不许宣告不存在的工具"机械化了：扫描 builtin-skills
 * 里出现的桌面端工具名，逐个比对 buildApTools() 实际注册出来的清单。
 * 从桌面端整包拷技能过来时，这一组会当场变红。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadSkills } from '../src/agent/skills.js'
import { buildApTools } from '../src/tools/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const BUILTIN_DIR = path.join(REPO, 'builtin-skills')

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

/**
 * 收集**会进到模型眼前**的文件，也就是各技能目录里的那些。
 *
 * 有意漏掉 `builtin-skills/README.md`：它不在任何技能目录下，pi 不装载它，
 * skill-materializer 也不会铺它（那个只走 skill.baseDir 的树）。它是写给人看的，
 * 里面正大光明地写着"artifact-author 为什么不迁"，扫它只会把这条用例判红。
 */
function collectSkillDocs(skills) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md')) out.push(full)
    }
  }
  for (const skill of skills) {
    if (statSync(skill.baseDir).isDirectory()) walk(skill.baseDir)
  }
  return [...new Set(out)]
}

/**
 * 把工具集装满：所有能力都给到，拿到的就是"这个版本最多能提供哪些工具"。
 * 技能只要引用了不在这个集合里的工具名，就是无论如何都跑不通的。
 */
function allRegisteredToolNames() {
  const egress = { async request() { throw new Error('不该被调用') }, classifyHost: () => 'trusted' }
  const sandboxSession = {
    async listFiles() { return { items: [] } },
    async getFiles() { return [] },
    async browserAction() { return { ok: true } },
  }
  const { tools } = buildApTools({
    runId: 'r',
    username: 'e',
    credential: 'me_token=x',
    egress,
    logger: silentLogger,
    sandboxSession,
    workspace: { enabled: true, async writeSkillFiles() {} },
  })
  return new Set(tools.map((tool) => tool.name))
}

/**
 * 桌面端 AP 扩展注册过的工具名。
 *
 * 前面加 `(?<![/\w])` 是为了放过**端点路径** —— `ap-http-bridge` 的 501 表里
 * 就写着 `/tools/knowledge_search`，那是在说"这个端点还没上云"，不是在教模型
 * 去调一个叫 knowledge_search 的工具。少了这个否定环视，那张表本身会把用例判红。
 */
const AP_TOOL_RE = /(?<![/\w])(joyme_[a-z_]+|artifact_[a-z_]+|workstation_browser|task_plan|skill_save|knowledge_search|file_upload|web_search|list_knowledge_bases)\b/g

describe('builtin-skills 装得进来', () => {
  test('每个技能的 frontmatter 都有 name 和 description', () => {
    const { skills } = loadSkills({ dirs: [BUILTIN_DIR], logger: silentLogger })

    /**
     * 断言的是"**每个技能目录都装进来了**"，不是一个写死的数目。
     *
     * 从前写的是 `>= 4`，而开源出来的 builtin-skills/ 只有两个 —— 于是这条用例
     * 一直红着，报的还是"只装到 2 个技能"，看起来像装载器坏了。数目是会变的，
     * 而"有目录却没装进来"才是真正要抓的那件事：pi 在 frontmatter 缺字段时
     * **静默跳过**，下一轮表现成"模型不知道有这个技能"，没有任何报错可查。
     */
    const dirs = readdirSync(BUILTIN_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(BUILTIN_DIR, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
    assert.ok(dirs.length >= 1, 'builtin-skills/ 下一个带 SKILL.md 的目录都没有')
    assert.deepEqual(
      skills.map((skill) => skill.name).sort(),
      dirs.sort(),
      '有技能目录没被装进来（多半是 frontmatter 缺字段，pi 会静默跳过）',
    )
    for (const skill of skills) {
      // 缺任何一个，pi 装载时会**静默跳过** —— 下一轮表现成"模型不知道有这个技能"，
      // 没有任何报错可查。所以在这里顶回来。
      assert.ok(skill.name, `技能缺 name：${skill.filePath}`)
      assert.ok(skill.description, `技能 ${skill.name} 缺 description`)
    }
  })

  test('技能名互不重复，也不与 managed-skills 撞车', () => {
    const builtin = loadSkills({ dirs: [BUILTIN_DIR], logger: silentLogger }).skills.map((s) => s.name)
    const managed = loadSkills({ dirs: [path.join(REPO, 'managed-skills')], logger: silentLogger }).skills.map((s) => s.name)
    assert.equal(new Set(builtin).size, builtin.length, `builtin 内部重名：${builtin}`)
    // 重名的后果很隐蔽：两者都会铺到沙盒的 skills/<name>/，后铺的把先铺的覆盖掉，
    // 而系统提示里两条都在 —— 模型照着 A 的说明去跑 B 的脚本。
    const clash = builtin.filter((name) => managed.includes(name))
    assert.deepEqual(clash, [], `与 managed-skills 重名：${clash}`)
  })
})

describe('技能不许宣告不存在的工具', () => {
  test('builtin-skills 里出现的每个工具名都真的注册了', () => {
    const registered = allRegisteredToolNames()
    const { skills } = loadSkills({ dirs: [BUILTIN_DIR], logger: silentLogger })
    const files = collectSkillDocs(skills)
    // 同样别写死数目（理由见上一条）：真正要防的是"收集逻辑回了个空数组，
    // 于是下面那个循环一次都没跑，用例却绿着"。每个技能至少要有自己那份 SKILL.md。
    assert.ok(skills.length >= 1, '一个技能都没装到')
    assert.ok(files.length >= skills.length, `${skills.length} 个技能只扫到 ${files.length} 个文件，收集逻辑可能失效了`)
    const offenders = []

    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(AP_TOOL_RE)) {
        const tool = match[1]
        if (!registered.has(tool)) {
          offenders.push(`${path.relative(REPO, file)} 提到了 ${tool}`)
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      '这些技能引用了本版本没有注册的工具。先迁工具，再迁技能 —— ' +
        '否则模型会照着说明去调一个不存在的东西，然后反复重试：\n  ' +
        offenders.join('\n  '),
    )
  })

  test('检测器本身有效：塞一个未迁工具的引用必须被抓出来', () => {
    const registered = allRegisteredToolNames()
    // artifact_* 阻塞于 MIGRATION #16。哪天它真迁了，这条会红 —— 那时把它换成
    // 另一个还没迁的工具名即可。没有这条反向用例，上面那条绿灯分不清是
    // "真的干净"还是"正则写错了一个字，什么都没匹配到"。
    const sample = '按 artifact_create(type="html") 生成产物'
    const found = [...sample.matchAll(AP_TOOL_RE)].map((m) => m[1])
    assert.deepEqual(found, ['artifact_create'])
    assert.ok(!registered.has('artifact_create'), 'artifact_* 已经迁了？请更新本用例的样本')
  })

  test('端点路径不算工具引用', () => {
    // /tools/knowledge_search 是"这个端点返回 501"的说明，不是让模型去调工具。
    const found = [...'| `/tools/knowledge_search` | 云端知识库 |'.matchAll(AP_TOOL_RE)]
    assert.deepEqual(found, [])
  })
})

describe('builtin-skills 真的会被发出去', () => {
  const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8')

  test('镜像里有这个目录', () => {
    assert.match(read('Dockerfile'), /COPY.*builtin-skills/m)
  })

  test('SKILL_DIRS 的样例把两段都写上了', () => {
    const env = read('.env.example')
    const line = env.split('\n').find((l) => l.startsWith('SKILL_DIRS='))
    assert.ok(line?.includes('managed-skills'), 'SKILL_DIRS 缺 managed-skills')
    assert.ok(line?.includes('builtin-skills'), 'SKILL_DIRS 缺 builtin-skills')
  })

  test('同步脚本不碰 builtin-skills', () => {
    // sync-skills.sh 走的是 rsync --delete。真源在本仓库的目录一旦被它纳管，
    // 云端改写会被桌面端原文覆盖回去，或者目录直接被清空 —— 两种都不报错。
    const script = read('bin/sync-skills.sh')
    assert.ok(!/^sync_dir builtin-skills/m.test(script), 'sync-skills.sh 不能同步 builtin-skills')
  })
})

describe('云端浏览器技能与工具契约一致', () => {
  test('不教模型用桌面端才有的 network 参数', () => {
    // 桌面端 SKILL.md 教的 networkOp:"detail" / includeHeaders / includeBodies，
    // 云端 worker 一个都没有（只记 {method,url,resourceType,status}）。
    // 照抄过来的表现是模型反复传这些参数、反复拿不到 body，最后编一个出来。
    const text = readFileSync(path.join(BUILTIN_DIR, 'cloud-browser/SKILL.md'), 'utf8')
    for (const banned of ['includeHeaders', 'includeBodies', 'requestId']) {
      const asUsage = new RegExp(`"${banned}"\\s*:`)
      assert.ok(!asUsage.test(text), `cloud-browser 里出现了 ${banned} 的用法示例`)
    }
    assert.ok(text.includes('没有'), 'cloud-browser 应当显式说明这些参数不存在')
  })
})
