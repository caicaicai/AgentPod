/**
 * 个人技能的管理面 —— 读、改、改展示信息、启停、删。
 *
 * ── 这块能力原本长在哪儿 ────────────────────────────────────────────
 *
 * 桌面端把它做成了 14 个 `api.registerGatewayMethod("skill.*")`，而且塞在
 * `extensions/chat` 里（那个包名义上是"京ME 聊天"）。所以盘点扩展时它
 * 一直被当成消息通道的一部分跳过 —— 实际上它跟聊天毫无关系，是技能中心的后端。
 *
 * 网关方法在云端没有对应物（没有 gateway），对应物是 HTTP API。映射关系：
 *
 *   skill.local.get        → GET    /v1/skills/:name
 *   skill.local.edit       → PUT    /v1/skills/:name/files
 *   skill.local.updateInfo → PATCH  /v1/skills/:name  { displayName, description, emoji }
 *   skill.remote.updateStatus → PATCH /v1/skills/:name  { enabled }
 *   skill.local.delete     → DELETE /v1/skills/:name
 *
 * **没做的四个**，因为它们要的东西云端还没有：`skill.local.upload`（zip 上传，
 * 要 multipart + 解包，而云端造技能的主路径是在沙盒里写完 `skill_save`）、
 * `skill.remote.list/add/delete`（要共享技能库后端的契约）。
 *
 * ── 一条贯穿始终的约束 ──────────────────────────────────────────────
 *
 * 每个方法第一件事都是拿 username 去解析路径（隔离契约 #4）。这里**没有**任何一个
 * 接受完整路径的入口 —— 调用方只能给"技能名"，路径一律由 username + scope 拼出来。
 * 拼路径的活儿留在 store 里（它做 safeJoin），这一层只负责把名字校验干净。
 */
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import path from 'node:path'

import { SKILL_SCOPES } from './store.js'

/**
 * 能作为**路径段**的技能名。与 `skill_save` 的校验保持一致 ——
 * 两处不一致的话，会出现"存得进去、管理面打不开"这种查不出来的状态。
 */
const PATH_SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * 能进**停用清单**的名字。比上面松：平台技能的名字不受我们控制
 * （`ap_http_bridge` 就带下划线），而停用清单只是 JSON 里的一个字符串，
 * 从来不参与拼路径 —— 所以这里要挡的只有"别塞进来一个路径"。
 */
const LISTABLE_NAME = /^[\w.-]{1,120}$/

/** 单个技能的护栏。技能是文本资产，超了说明放错了东西 */
const MAX_FILES = 100
const MAX_TOTAL_BYTES = 4 * 1024 * 1024
/** 单文件读回上限：管理面是给人看的编辑器，不是给模型灌上下文的 */
const MAX_FILE_BYTES = 512 * 1024

const STATE_FILE = 'state.json'

export class SkillManagerError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'SkillManagerError'
    this.status = status
  }
}

function assertName(name) {
  const value = String(name || '').trim()
  if (!PATH_SAFE_NAME.test(value)) {
    throw new SkillManagerError(`技能名 ${value || '(空)'} 不合法：只能是小写字母、数字和连字符，且以字母或数字开头`)
  }
  return value
}

function assertListableName(name) {
  const value = String(name || '').trim()
  if (!LISTABLE_NAME.test(value)) throw new SkillManagerError(`技能名不合法：${value || '(空)'}`)
  return value
}

/**
 * 相对路径校验。**不是防御性冗余**：这些路径来自 HTTP 请求体，
 * 一个 `../../../etc/passwd` 就能写出用户目录 —— 而写出去是不可逆的。
 */
function assertRelPath(relPath) {
  const value = String(relPath || '').trim()
  if (!value) throw new SkillManagerError('文件路径不能为空')
  if (value.length > 255) throw new SkillManagerError('文件路径过长')
  // 绝对路径**直接拒**，不要顺手去掉开头的斜杠 —— 那样 `/etc/passwd` 会被
  // 悄悄理解成技能目录下的 `etc/passwd`，请求方以为自己写的是系统文件、
  // 我们以为自己收到的是相对路径，两边都没报错。
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) {
    throw new SkillManagerError(`文件路径必须是相对路径：${value}`)
  }
  if (value.includes('\\')) throw new SkillManagerError(`文件路径只能用 /：${value}`)
  const normalized = path.posix.normalize(value)
  if (normalized.startsWith('..') || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new SkillManagerError(`文件路径越界：${value}`)
  }
  if (normalized === '.' || normalized.endsWith('/')) throw new SkillManagerError(`文件路径不是一个文件：${value}`)
  return normalized
}

/** 只取我们要动的几个键，不引 YAML 解析器（理由见 src/agent/skills.js 的同款说明） */
function splitFrontmatter(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/)
  if (!match) return null
  return { block: match[1], rest: String(text).slice(match[0].length), eol: text.includes('\r\n') ? '\r\n' : '\n' }
}

/**
 * 在 frontmatter 里改/插一个顶层键。
 *
 * 刻意只动**顶层单行**：技能的 `metadata` 在不同技能里一会儿是单行 JSON、
 * 一会儿是多行缩进块，为了改一个 emoji 去重写嵌套结构，改坏的概率远大于收益。
 * 而 `src/agent/skills.js` 的 readDisplayMeta 本来就先认顶层行 —— 写顶层就够了。
 */
function upsertFrontmatterKey(block, key, value) {
  const line = `${key}: ${value}`
  // 只匹配顶层（行首无缩进）的那一行，别把 metadata 块里的同名键改了
  const re = new RegExp(`^${key}\\s*:.*$`, 'm')
  if (re.test(block)) return block.replace(re, line)
  // 插在 name 后面：人读 frontmatter 时期望 name/displayName/description 挨着
  const afterName = block.match(/^name\s*:.*$/m)
  if (afterName) return block.replace(afterName[0], `${afterName[0]}\n${line}`)
  return `${line}\n${block}`
}

async function walkSkillDir(dir) {
  const out = []
  let totalBytes = 0
  async function walk(current, prefix) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name === '__pycache__' || entry.name === '.git') continue
      const full = path.join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      // lstat 而不是 entry.isDirectory()：软链接可能指到用户目录外面去
      const info = await stat(full).catch(() => null)
      if (!info) continue
      if (info.isDirectory()) {
        await walk(full, rel)
        continue
      }
      if (!info.isFile()) continue
      totalBytes += info.size
      out.push({ path: rel, size: info.size })
    }
  }
  await walk(dir, '')
  // 按码位排，不用 localeCompare —— 后者的结果随 ICU/locale 变
  //（`SKILL.md` 与 `scripts/` 的先后在不同环境下就不一样），
  // 而这份清单会被前端拿去做 diff 和渲染顺序，必须稳定。
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files: out, totalBytes }
}

export function createSkillManager({ workspace, logger = console } = {}) {
  const enabled = Boolean(workspace?.enabled)

  const stateFilePath = (username) => path.join(workspace.userRoot(username), 'skills', STATE_FILE)

  /** 找技能在哪个桶里。找不到就是不存在 —— 两个桶都查过了 */
  async function locate(username, name) {
    for (const scope of SKILL_SCOPES) {
      const dir = path.join(workspace.skillScopeDir(username, scope), name)
      const info = await stat(dir).catch(() => null)
      if (info?.isDirectory()) return { scope, dir }
    }
    return null
  }

  async function readState(username) {
    if (!enabled) return { disabled: [] }
    try {
      const raw = await readFile(stateFilePath(username), 'utf8')
      const parsed = JSON.parse(raw)
      const disabled = Array.isArray(parsed?.disabled) ? parsed.disabled.filter((n) => LISTABLE_NAME.test(n)) : []
      return { disabled }
    } catch {
      // 文件不存在是正常状态（没人停用过任何技能），不是错误
      return { disabled: [] }
    }
  }

  async function writeState(username, state) {
    const file = stateFilePath(username)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ disabled: [...new Set(state.disabled)].sort() }, null, 2), 'utf8')
  }

  return {
    enabled,

    /**
     * 这个用户停用了哪些技能。
     * 平台技能也能被停用 —— 用户要的是"这个技能别再出现在我的助手里"，
     * 跟它是谁发布的没关系。
     */
    async disabledNames(username) {
      const { disabled } = await readState(username)
      return new Set(disabled)
    },

    /** 启停。技能不必存在也能停用：平台技能不在用户目录里，但同样该能关掉 */
    async setEnabled({ username, name, enabled: want }) {
      if (!enabled) throw new SkillManagerError('未启用用户工作空间，技能状态无处保存', 503)
      const skillName = assertListableName(name)
      const state = await readState(username)
      const set = new Set(state.disabled)
      if (want) set.delete(skillName)
      else set.add(skillName)
      await writeState(username, { disabled: [...set] })
      logger.info?.('技能启停已更新', { username, skill: skillName, enabled: Boolean(want) })
      return { name: skillName, enabled: Boolean(want) }
    },

    /** 技能详情：文件清单 + 每个文件的内容（管理面要在编辑器里显示） */
    async read({ username, name, withContent = true }) {
      if (!enabled) throw new SkillManagerError('未启用用户工作空间', 503)
      const skillName = assertName(name)
      const found = await locate(username, skillName)
      if (!found) throw new SkillManagerError(`技能 ${skillName} 不存在`, 404)

      const { files, totalBytes } = await walkSkillDir(found.dir)
      const result = { name: skillName, scope: found.scope, files, totalBytes }
      if (!withContent) return result

      result.files = await Promise.all(files.map(async (file) => {
        if (file.size > MAX_FILE_BYTES) {
          // 不静默截断：编辑器里拿到半截文件、存回去就把后半截删了
          return { ...file, tooLarge: true }
        }
        const buf = await readFile(path.join(found.dir, file.path))
        // 二进制（图标、字体）不塞进 JSON，标出来让前端换个展示方式
        // 判据用 NUL 字节：utf8 文本里不会出现它，而二进制格式几乎必然有
        if (buf.includes(0)) return { ...file, binary: true }
        return { ...file, content: buf.toString('utf8') }
      }))
      return result
    },

    /**
     * 整体替换技能文件。**覆盖式**，与 `skill_save` 同语义：
     * 传什么就是什么，没传的文件会消失。增量补丁式的编辑会让"删掉一个脚本"
     * 变成不可能的操作。
     */
    async writeFiles({ username, name, files }) {
      if (!enabled) throw new SkillManagerError('未启用用户工作空间', 503)
      const skillName = assertName(name)
      const found = await locate(username, skillName)
      if (!found) throw new SkillManagerError(`技能 ${skillName} 不存在`, 404)
      // 平台技能不在用户目录里，locate 也找不到 —— 这里再挡一道是为了讲清原因
      if (!Array.isArray(files) || !files.length) throw new SkillManagerError('files 不能为空')
      if (files.length > MAX_FILES) throw new SkillManagerError(`文件数 ${files.length} 超过上限 ${MAX_FILES}`)

      const normalized = files.map((file) => ({
        relPath: assertRelPath(file?.path),
        content: Buffer.from(String(file?.content ?? ''), 'utf8'),
      }))
      const totalBytes = normalized.reduce((sum, file) => sum + file.content.length, 0)
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new SkillManagerError(`技能体积 ${totalBytes} 字节超过上限 ${MAX_TOTAL_BYTES}`)
      }
      if (!normalized.some((file) => file.relPath === 'SKILL.md')) {
        // pi 靠 SKILL.md 认技能根。删掉它 = 这个技能从此不存在，而且没有报错
        throw new SkillManagerError('SKILL.md 不能删除，它是技能的入口')
      }

      await workspace.writeSkillFiles({ username, scope: found.scope, name: skillName, files: normalized, tag: 'edit' })
      logger.info?.('技能已更新', { username, skill: skillName, files: normalized.length, bytes: totalBytes })
      return { name: skillName, scope: found.scope, files: normalized.length, bytes: totalBytes }
    },

    /** 只改展示信息，不动正文与脚本 */
    async updateInfo({ username, name, displayName, description, emoji }) {
      if (!enabled) throw new SkillManagerError('未启用用户工作空间', 503)
      const skillName = assertName(name)
      const found = await locate(username, skillName)
      if (!found) throw new SkillManagerError(`技能 ${skillName} 不存在`, 404)

      const file = path.join(found.dir, 'SKILL.md')
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text === null) throw new SkillManagerError(`技能 ${skillName} 缺少 SKILL.md`, 404)
      const parsed = splitFrontmatter(text)
      if (!parsed) throw new SkillManagerError('SKILL.md 没有 frontmatter，无法改展示信息')

      let block = parsed.block
      // description 会进系统提示，换行会把 frontmatter 结构破坏掉
      const clean = (value) => String(value).replace(/[\r\n]+/g, ' ').trim()
      if (typeof displayName === 'string') block = upsertFrontmatterKey(block, 'displayName', clean(displayName))
      if (typeof description === 'string') {
        const value = clean(description)
        if (!value) throw new SkillManagerError('description 不能为空 —— 少了它技能装载时会被静默跳过')
        block = upsertFrontmatterKey(block, 'description', value)
      }
      if (typeof emoji === 'string') block = upsertFrontmatterKey(block, 'emoji', clean(emoji))

      const next = `---${parsed.eol}${block}${parsed.eol}---${parsed.eol}${parsed.rest}`
      await writeFile(file, next, 'utf8')
      logger.info?.('技能展示信息已更新', { username, skill: skillName })
      return { name: skillName, scope: found.scope }
    },

    async remove({ username, name }) {
      if (!enabled) throw new SkillManagerError('未启用用户工作空间', 503)
      const skillName = assertName(name)
      const found = await locate(username, skillName)
      if (!found) throw new SkillManagerError(`技能 ${skillName} 不存在`, 404)
      await workspace.removeSkill({ username, scope: found.scope, name: skillName })
      // 顺手把停用记录清掉，免得同名技能重建之后莫名其妙是关着的
      const state = await readState(username)
      if (state.disabled.includes(skillName)) {
        await writeState(username, { disabled: state.disabled.filter((n) => n !== skillName) })
      }
      logger.info?.('技能已删除', { username, skill: skillName, scope: found.scope })
      return { name: skillName, scope: found.scope }
    },
  }
}

/** 便于在没有工作空间时保持调用方形状不变 */
export function createDisabledSkillManager() {
  // 必须是 async：同步 throw 的话调用方拿不到被拒的 Promise，
  // 而所有调用点都是 `await manager.xxx()`
  const nope = async () => { throw new SkillManagerError('未启用用户工作空间', 503) }
  return {
    enabled: false,
    async disabledNames() { return new Set() },
    setEnabled: nope,
    read: nope,
    writeFiles: nope,
    updateInfo: nope,
    remove: nope,
  }
}
