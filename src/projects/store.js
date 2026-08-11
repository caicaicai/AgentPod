/**
 * 项目：一组会话 + 一份长期指令 + 一份项目记忆。
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────────
 *
 * 会话列表拉长之后，"上次那个排期的对话在哪"就开始变成翻找。更麻烦的是**重复交代**：
 * 同一个项目里的每个新会话，都要把背景、约定、术语再讲一遍。
 *
 * 项目就是把这两件事一起解决：会话按项目归堆；项目自带 `instructions`（每轮进系统提示）
 * 和自己的 `MEMORY.md`（只在该项目的会话里带）。于是"这个项目的上下文"只交代一次。
 *
 * ── 落盘形状 ────────────────────────────────────────────────────────────
 *
 *   <dataDir>/users/<username>/projects/
 *     <id>.json        项目元信息（名字、说明、instructions）
 *     <id>/MEMORY.md   该项目的长期记忆（由 src/memory/store.js 写）
 *
 * 元信息是文件、记忆是目录，同名并列。看着有点怪，但换来的是两边各自用最合适的
 * 存储原语：元信息走通用的 file-map（原子写 + 串行队列），记忆是给人读的 markdown。
 *
 * ── 为什么没有成员与共享 ────────────────────────────────────────────────
 *
 * 参考实现（qm）的项目是多人共享的，靠一整套 directory / ACL 支撑。云端 agent 现在
 * 没有这些 —— 所有存储都按 username 强隔离（隔离契约 #4）。硬做共享等于在没有权限模型的
 * 地基上开一个跨用户读写的口子。所以这一版是**个人项目**：属于谁就只有谁能看见。
 * 将来要共享，加的是权限层，不是把这里的 username 拿掉。
 */
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'

import { createFileMap } from '../persistence/file-map.js'
import { assertSegment, safeJoin, userRoot } from '../persistence/paths.js'

const NAME_MAX = 60
const DESCRIPTION_MAX = 500

/**
 * instructions 是每轮都要进系统提示的。
 * 不设上限的话，一段几万字的"项目背景"会把上下文吃掉大半，而现象只是"模型变笨了"。
 */
const INSTRUCTIONS_MAX = 8000

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

function cleanText(text, max) {
  return String(text || '').replace(/\r\n/g, '\n').trim().slice(0, max)
}

function newProjectId() {
  // 短一点，它会出现在路径和界面上；随机足够避免同一个人手动新建时撞号
  return `p_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function toPublic(project) {
  if (!project) return null
  return {
    id: project.id,
    name: project.name || '',
    description: project.description || '',
    instructions: project.instructions || '',
    archived: Boolean(project.archived),
    createdAt: project.createdAt || 0,
    updatedAt: project.updatedAt || 0,
  }
}

export function createProjectStore({ config, logger = console }) {
  const dataDir = config.dataDir
  const enabled = config.projects?.enabled !== false

  function mapFor(username) {
    assertSegment(username, 'username')
    return createFileMap({ dir: safeJoin(userRoot(dataDir, username), 'projects'), logger })
  }

  /** 项目自己那棵目录（记忆、将来的项目级文件都放这儿） */
  function dirFor(username, projectId) {
    return safeJoin(userRoot(dataDir, username), 'projects', assertSegment(projectId, 'projectId'))
  }

  return {
    enabled,
    dirFor,

    async create({ username, name, description = '', instructions = '' }) {
      const clean = cleanName(name)
      if (!clean) throw new Error('项目名不能为空')
      const now = Date.now()
      const project = {
        id: newProjectId(),
        username,
        name: clean,
        description: cleanText(description, DESCRIPTION_MAX),
        instructions: cleanText(instructions, INSTRUCTIONS_MAX),
        archived: false,
        createdAt: now,
        updatedAt: now,
      }
      await mapFor(username).put(project.id, project)
      return toPublic(project)
    },

    async get({ username, projectId }) {
      if (!projectId) return null
      return toPublic(await mapFor(username).get(assertSegment(projectId, 'projectId')))
    },

    async list({ username, includeArchived = false } = {}) {
      const all = await mapFor(username).all()
      return all
        .filter((project) => includeArchived || !project.archived)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map(toPublic)
    },

    /**
     * 局部更新。只认这四个字段 —— **不要写成 `{...patch}`**：
     * 那样请求体里塞一个 `username` 就能把归属改掉，等于把别人的项目搬到自己名下。
     * （同一个坑在 skill-manager 的 PATCH 上真实发生过，见 http/server.js 的注释。）
     */
    async update({ username, projectId, name, description, instructions, archived }) {
      const fields = { updatedAt: Date.now() }
      if (name !== undefined) {
        const clean = cleanName(name)
        if (!clean) throw new Error('项目名不能为空')
        fields.name = clean
      }
      if (description !== undefined) fields.description = cleanText(description, DESCRIPTION_MAX)
      if (instructions !== undefined) fields.instructions = cleanText(instructions, INSTRUCTIONS_MAX)
      if (archived !== undefined) fields.archived = Boolean(archived)
      return toPublic(await mapFor(username).merge(assertSegment(projectId, 'projectId'), fields))
    },

    /**
     * 删项目。
     *
     * **不删它下面的会话** —— 那是用户的对话记录，删项目的人想删的是这个分组，
     * 不是几十轮聊天。会话的 projectId 由调用方（http 层）清成空串，退回"未分组"。
     * 反过来做（连会话一起删）是不可逆的，而"我只是想把这个文件夹删掉"是最常见的意图。
     */
    async remove({ username, projectId }) {
      const id = assertSegment(projectId, 'projectId')
      const existing = await mapFor(username).get(id)
      if (!existing) return false
      await mapFor(username).delete(id)
      // 项目记忆跟着走：留着就是一份谁也访问不到、却还占着盘的孤儿文件
      await rm(dirFor(username, id), { recursive: true, force: true }).catch((error) => {
        logger.warn?.('项目目录清理失败', { username, projectId: id, err: error?.message })
      })
      return true
    },
  }
}

/**
 * 项目指令进系统提示的那一段。
 *
 * 与 memory 分开是有意的：memory 是"观察到的事实"，可能过时、模型该有判断；
 * 而 instructions 是用户**明确下达**的长期要求，就该当指令执行。两者混在一句话里
 * 说明，模型只会各打五折。
 */
export function projectPrompt(project) {
  if (!project?.instructions) return ''
  return [
    `## 当前项目：${project.name}`,
    '',
    ...(project.description ? [project.description, ''] : []),
    '以下是这个项目的长期要求，本轮及之后的每一轮都适用：',
    '',
    project.instructions,
  ].join('\n')
}
