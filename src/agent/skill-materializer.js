/**
 * 把技能目录搬进沙盒。
 *
 * ── 为什么必须有 ────────────────────────────────────────────────────
 *
 * 技能不是一段提示词，是**一个目录**：SKILL.md 讲怎么用，旁边 `scripts/` 里放着
 * 真正干活的 Python/Node/Shell。managed-skills 五个技能无一例外，SKILL.md 的
 * 快速开始清一色是
 *
 *     cd skills/joymail-search
 *     bash scripts/run.sh search --keyword "项目评审"
 *
 * 而 `bash` 工具跑在沙盒里，SKILL.md 与 scripts/ 躺在 agent 主机上 ——
 * 不搬过去，模型照着说明执行的每一条命令都是 `No such file or directory`。
 *
 * ── 路径为什么是相对的 ──────────────────────────────────────────────
 *
 * pi 会把技能位置以 `<location>{skill.filePath}</location>` 写进系统提示，
 * 模型据此 `read` 它、并在 bash 命令里引用同级文件。两端的绝对路径对不上：
 * agent 侧是 `/tmp/ap-run-xxx/workspace`，沙盒侧是 worker 分配的工作区。
 * 所以这里把 filePath / baseDir 一律改写成**相对工作区根**的形式：
 *
 *   - `read skills/x/SKILL.md` → sandbox-files.js 解析成 `<cwd>/skills/x/SKILL.md`
 *     再换算回 `skills/x/SKILL.md`，正好落在沙盒里那份上；
 *   - `cd skills/x && bash scripts/run.sh` → 沙盒的 cwd 就是工作区根，直接命中。
 *
 * 相对路径是唯一能同时被这两条路正确解析的写法，也正是 SKILL.md 里原本就在用的。
 *
 * ── 为什么是懒搬 ────────────────────────────────────────────────────
 *
 * 租约是懒申请的（第一次真的用沙盒才占槽位）。要是在 run 开头就推文件，
 * 每一句"你好"都会占掉一个槽位再释放。所以搬运挂在**第一次沙盒读/执行**上：
 * 那一刻模型必然是要用工作区了，槽位本来就要占。
 */
import path from 'node:path'
import { readdir, readFile, lstat } from 'node:fs/promises'

/** 技能在沙盒工作区里的根目录。**必须叫 skills** —— SKILL.md 里写死了 `cd skills/<name>` */
export const SKILLS_ROOT = 'skills'

/**
 * 不搬进沙盒的目录。
 * `.venv` 是关键的一条：技能自带的虚拟环境是按 agent 主机的解释器路径生成的，
 * 搬进去也用不了（而且动辄上百兆），沙盒侧改用软链接指向镜像里的 venv，见 linkVenv()。
 */
const SKIP_ENTRIES = new Set(['node_modules', '__pycache__', '.git', '.venv', '.DS_Store'])

/** 单个技能树的护栏。技能是我们自己维护的资产，超限说明放错了东西，宁可报出来 */
const MAX_FILES = 200
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
/** worker 的 /files/batch 上限是 100 个，留足余量分批推 */
const BATCH_SIZE = 40

/**
 * 把技能改写成"沙盒里的样子"：路径全部相对工作区根。
 * 其余字段（name/description/sourceInfo/disableModelInvocation）原样保留 ——
 * 系统提示里模型看到的描述必须和桌面端一致。
 */
export function toSandboxSkills(skills = []) {
  return skills.map((skill) => {
    const dir = `${SKILLS_ROOT}/${skill.name}`
    return {
      ...skill,
      filePath: `${dir}/${path.basename(skill.filePath)}`,
      baseDir: dir,
    }
  })
}

/**
 * 收集一个技能要搬的文件。
 *
 * `basename === 'SKILL.md'` 时 baseDir 就是这个技能独占的目录（pi 的发现规则如此），
 * 整棵搬；否则它只是某个技能根下的单个 .md 文件，baseDir 是**共享的**，
 * 整棵搬会把同目录下别的技能重复复制一遍，所以只搬它自己。
 */
async function collectSkillFiles(skill, logger) {
  const isDirSkill = path.basename(skill.filePath) === 'SKILL.md'
  const target = `${SKILLS_ROOT}/${skill.name}`

  if (!isDirSkill) {
    const content = await readFile(skill.filePath)
    return [{ path: `${target}/${path.basename(skill.filePath)}`, content }]
  }

  const files = []
  let totalBytes = 0

  async function walk(localDir, sandboxDir) {
    const entries = await readdir(localDir, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP_ENTRIES.has(entry.name)) continue
      const localPath = path.join(localDir, entry.name)
      const sandboxPath = `${sandboxDir}/${entry.name}`

      // 用 lstat 而不是 entry.isDirectory()：软链接可能指到技能目录外面去，
      // 跟着走等于把 agent 主机上任意一处的文件搬进沙盒。
      const info = await lstat(localPath)
      if (info.isSymbolicLink()) {
        logger?.warn?.('技能目录里的软链接被跳过', { skill: skill.name, entry: entry.name })
        continue
      }
      if (info.isDirectory()) {
        await walk(localPath, sandboxPath)
        continue
      }
      if (!info.isFile()) continue

      if (files.length >= MAX_FILES) throw new Error(`技能 ${skill.name} 的文件数超过 ${MAX_FILES}`)
      totalBytes += info.size
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`技能 ${skill.name} 的体积超过 ${MAX_TOTAL_BYTES} 字节`)

      files.push({ path: sandboxPath, content: await readFile(localPath) })
    }
  }

  await walk(skill.baseDir, target)
  return files
}

/**
 * 建 `skills/.venv` → 镜像里 venv 的软链接。
 *
 * joymail 三个技能的 `scripts/run.sh` 写死了去找 `<skills 根>/.venv/bin/python3`
 * （桌面端的布局），找不到就直接返回 ENV_NOT_READY，一步都跑不下去。
 * 沙盒镜像里的解释器在 `/opt/ap/venv`（由 worker 注入 `AP_PYTHON_BIN`），
 * 搭一根软链接就能让这些脚本**一行不改**地跑起来 —— 这正是"技能零改动上云"的承诺。
 *
 * 取两层 dirname 是为了从 `.../venv/bin/python3` 回到 venv 根；
 * 就算 AP_PYTHON_BIN 是 `/usr/bin/python3` 这种非 venv 的路径，
 * 算出来的 `/usr` 依然满足 `$LINK/bin/python3` 这个形状，脚本照样能跑。
 */
async function linkVenv(session, logger) {
  // 不用 `set -e` + `cmd && cmd`：那样 `[ -x ]` 为假时整段以非零退出，
  // 和"软链接真的没建成"分不开。显式 if/exit 码才能在日志里区分。
  const command = [
    `mkdir -p ${SKILLS_ROOT}`,
    'py="${AP_PYTHON_BIN:-/opt/ap/venv/bin/python3}"',
    'if [ ! -x "$py" ]; then echo "解释器不可执行: $py" >&2; exit 3; fi',
    `ln -sfn "$(dirname "$(dirname "$py")")" ${SKILLS_ROOT}/.venv || exit 4`,
  ].join('\n')

  // 收着输出，失败时好定位。**这一步曾经是哑的**：exec 不传 onData 时
  // 一有输出就抛 "onData is not a function"，被下面的 catch 吞成一条 warn，
  // 表现为软链接神秘地不存在。现在 onData 可选了，这里仍然收着，
  // 因为失败原因（多半是 EACCES）只在 stderr 里。
  const chunks = []
  try {
    const result = await session.exec({ command, cwd: '', onData: (chunk) => chunks.push(chunk) })
    if (result?.exitCode !== 0) {
      logger?.warn?.('技能 venv 软链接未建成，依赖 .venv 的技能脚本会报 ENV_NOT_READY', {
        exitCode: result?.exitCode,
        output: Buffer.concat(chunks).toString('utf8').slice(0, 300),
      })
    }
  } catch (error) {
    // 软链接失败不该让整轮跑不动：不依赖 .venv 的技能（如 meeting 直接用 python3）照样能用
    logger?.warn?.('技能 venv 软链接失败', { err: error?.message })
  }
}

/**
 * 真正把文件推进沙盒。分批是因为 worker 的 /files/batch 一次最多收 100 个。
 */
async function materialize({ session, skills, stageFiles, logger }) {
  const files = []
  for (const skill of skills) {
    files.push(...(await collectSkillFiles(skill, logger)))
  }
  // 用户工作空间走同一趟推送：它和技能一样是"沙盒开始干活之前必须就位"的东西，
  // 各推各的等于把懒触发这件事做两遍，还得各自处理失败重试。
  const skillFileCount = files.length
  if (stageFiles) files.push(...(await stageFiles()))
  if (!files.length) return { count: 0 }

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    await session.putFiles(files.slice(i, i + BATCH_SIZE))
  }

  const bytes = files.reduce((sum, f) => sum + f.content.length, 0)
  // 只记形状，不记内容 —— 技能脚本本身不是用户数据，但保持和沙盒日志同一套口径
  logger?.info?.('技能已铺进沙盒工作区', {
    skills: skills.length,
    files: skillFileCount,
    workspaceFiles: files.length - skillFileCount,
    bytes,
  })

  if (files.some((f) => f.content.includes('.venv'))) await linkVenv(session, logger)

  return { count: files.length, bytes }
}

/**
 * 给沙盒会话套一层：第一次读/执行工作区之前，先把技能铺进去。
 *
 * 用 `Object.create(session)` 而不是逐个抄方法：会话上还有 browserAction / putFile /
 * release 等一堆方法，漏抄任何一个都是运行时才发现的洞。原型链把它们原样透过去，
 * 这里只覆盖需要等技能就位的那几个。
 *
 * 只拦"读和执行"：`putFile` 是模型自己写文件、`browserAction` 是开浏览器，
 * 都跟技能在不在场没关系，不该为它们付搬运的代价。
 */
export function attachSkillMaterialization({ session, skills = [], stageFiles = null, logger }) {
  if (!session || (!skills.length && !stageFiles)) return session

  let pending = null
  const ensure = () => {
    if (!pending) {
      pending = materialize({ session, skills, stageFiles, logger }).catch((error) => {
        pending = null // 允许下一次调用重试：多半是沙盒还没起来这类瞬时问题
        throw error
      })
    }
    return pending
  }

  const wrapped = Object.create(session)
  for (const name of ['exec', 'getFile', 'getFiles', 'statFile', 'listFiles']) {
    if (typeof session[name] !== 'function') continue
    wrapped[name] = async (...args) => {
      await ensure()
      return session[name](...args)
    }
  }
  /** 供测试与显式预热用 */
  wrapped.ensureSkills = ensure
  return wrapped
}
