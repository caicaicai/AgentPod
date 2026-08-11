/**
 * 长期记忆（MEMORY.md）。
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────────
 *
 * 云端每一轮都是全新的 AgentSession，会话历史能水合回来，但**跨会话**的东西
 * 一样都留不下：用户是谁、他在做什么项目、喜欢什么样的回答、上次定下的约定。
 * 于是同一个人每开一个新会话就得把自己重新介绍一遍。
 *
 * memory 就是这份"跨会话仍然成立的事实"。它有两个作用域：
 *
 *   个人  <dataDir>/users/<username>/memory/MEMORY.md          —— 这个人的所有会话都带
 *   项目  <dataDir>/users/<username>/projects/<id>/MEMORY.md   —— 只有该项目下的会话带
 *
 * 分两层不是为了好看：个人层放"我是谁、我怎么工作"，项目层放"这个项目的现状"。
 * 混在一起的话，一个项目的临时状态会跟着你去所有别的对话里。
 *
 * ── 一致性 ──────────────────────────────────────────────────────────────
 *
 * 整段替换（用户在界面上编辑、或模型调 memory 工具重写）走 `replaceIfRevision`：
 * 带上读到时的 revision，对不上就拒绝。没有它的话，"模型正在追加一条"和
 * "用户正在界面上删一条"撞在一起，后写的会把对方整段抹掉 —— 而 memory 恰恰是
 * 那种丢了不会有人立刻发现的数据。
 */
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'

import { assertSegment, safeJoin, writeAtomic, userRoot } from '../persistence/paths.js'
import { RECALL_MAX_CHARS, bullets, capTail, dateStr, isBullet, normalize } from './notebook.js'

const MEMORY_FILE = 'MEMORY.md'
const MEMORY_HEADER = '# Memory'

/**
 * 单个作用域最多留多少条。超了从**最旧的**开始丢。
 *
 * 上限存在的理由不是磁盘，是上下文：无限增长的 MEMORY.md 迟早占满系统提示，
 * 把真正要干的活挤出去。300 条 ≈ 二十几 KB，recall 时还会再按字符数截一次。
 */
const MAX_FACTS = 300

function revisionOf(content) {
  return createHash('sha256').update(content || '').digest('hex').slice(0, 16)
}

/**
 * 把若干条新事实折进已有正文，返回新正文与真正新增的条数。
 *
 * 纯函数，单独拿出来是为了能直接测：去重、日期、上限这三件事都容易写出
 * "看着对、跑起来偏一点"的实现。
 */
export function foldCapture(existing, facts, at) {
  const clean = (facts || [])
    .map((fact) => String(fact || '').replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, ''))
    .filter(Boolean)
  if (!clean.length) return { body: existing, added: 0 }

  const seen = new Set(String(existing || '').split('\n').filter(isBullet).map(normalize))
  const date = dateStr(at)
  const added = []
  for (const fact of clean) {
    const key = normalize(fact)
    if (!key || seen.has(key)) continue
    seen.add(key)
    added.push(`- (${date}) ${fact}`)
  }
  if (!added.length) return { body: existing, added: 0 }

  let body = String(existing || '').trim()
    ? `${existing.replace(/\s+$/, '')}\n${added.join('\n')}`
    : `${MEMORY_HEADER}\n\n${added.join('\n')}`

  // 超上限时从最旧的条目开始丢。标题行与说明段不算 bullet，不会被误删。
  const lines = body.split('\n')
  const bulletIdx = lines.flatMap((line, index) => (isBullet(line) ? [index] : []))
  const overflow = bulletIdx.length - MAX_FACTS
  if (overflow > 0) {
    const drop = new Set(bulletIdx.slice(0, overflow))
    body = lines.filter((_, index) => !drop.has(index)).join('\n')
  }
  return { body, added: added.length }
}

/** 关键词检索：所有词都出现才算命中（AND 而不是 OR，OR 在几百条里几乎必然全中） */
export function queryBullets(body, keyword, limit) {
  const terms = String(keyword || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  return bullets(body)
    .filter((line) => terms.every((term) => line.toLowerCase().includes(term)))
    .slice(0, limit)
}

function normalizeReplace(content) {
  const trimmed = String(content || '').replace(/\s+$/, '')
  return trimmed ? `${trimmed}\n` : ''
}

/**
 * @param {object} params
 * @param {object} params.config  需要 config.memory.enabled / config.dataDir
 */
export function createMemoryStore({ config, logger = console }) {
  const dataDir = config.dataDir
  const enabled = config.memory?.enabled !== false

  /**
   * 作用域 → 文件路径。
   *
   * `projectId` 为空就是个人作用域。刻意不让调用方自己拼路径：越界检查只在这里做一次，
   * 多一个拼路径的地方就多一处要记得校验的地方。
   */
  function fileFor({ username, projectId = '' }) {
    const base = userRoot(dataDir, username)
    if (!projectId) return safeJoin(base, 'memory', MEMORY_FILE)
    return safeJoin(base, 'projects', assertSegment(projectId, 'projectId'), MEMORY_FILE)
  }

  async function readRaw(scope) {
    try {
      return await readFile(fileFor(scope), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return ''
      throw error
    }
  }

  return {
    enabled,

    /** 带进系统提示的那一份（截到上限，留最近的） */
    async recall(scope) {
      if (!enabled) return ''
      const body = (await readRaw(scope)).trim()
      return body ? capTail(body, RECALL_MAX_CHARS) : ''
    },

    /**
     * 追加若干条事实，返回真正新增的条数（去重之后）。
     *
     * 返回条数而不是 void：调用方（抓取策略）要据此决定记不记日志 ——
     * "抓到 3 条但全是重复"和"抓到 3 条全是新的"是完全不同的两件事。
     */
    async capture(scope, facts, at = Date.now()) {
      if (!enabled) return 0
      const existing = await readRaw(scope)
      const { body, added } = foldCapture(existing, facts, at)
      if (!added) return 0
      await writeAtomic(fileFor(scope), `${body}\n`, 'mem')
      return added
    },

    async query(scope, keyword, limit = 20) {
      if (!enabled) return []
      return queryBullets(await readRaw(scope), keyword, limit)
    },

    /** 原文 + revision。界面编辑与模型改写都必须先拿它，回写时带上 */
    async read(scope) {
      const content = enabled ? await readRaw(scope) : ''
      return { content, revision: revisionOf(content), bytes: Buffer.byteLength(content), count: bullets(content).length }
    },

    /**
     * 整段替换。`revision` 对不上返回 false —— 调用方该重读再改，而不是硬覆盖。
     * 传空串表示"清空"，此时直接删文件，别留一个空文件让 recall 每次白读一遍。
     */
    async replace(scope, content, revision) {
      if (!enabled) return false
      const current = await readRaw(scope)
      if (revision !== undefined && revisionOf(current) !== revision) return false
      const next = normalizeReplace(content)
      if (!next) {
        await rm(fileFor(scope), { force: true })
        return true
      }
      await writeAtomic(fileFor(scope), next, 'mem')
      return true
    },

    /**
     * 删掉某条（按归一化后的文本匹配）。
     *
     * 给模型的 `memory` 工具用："忘掉我说过的 X"必须有一条不需要整段重写的路径 ——
     * 让模型整段重写只为删一行，是在拿全部记忆赌它这次抄得全对。
     */
    async forget(scope, text) {
      if (!enabled) return 0
      const current = await readRaw(scope)
      if (!current) return 0
      const target = normalize(text)
      if (!target) return 0
      const kept = []
      let removed = 0
      for (const line of current.split('\n')) {
        if (isBullet(line) && normalize(line).includes(target)) { removed += 1; continue }
        kept.push(line)
      }
      if (!removed) return 0
      const body = normalizeReplace(kept.join('\n'))
      if (!body || !bullets(body).length) await rm(fileFor(scope), { force: true })
      else await writeAtomic(fileFor(scope), body, 'mem')
      return removed
    },

    /**
     * 这个作用域的 memory 文件在哪。
     * 给项目存储用：删项目时要把它那棵目录整个删掉，得知道自己写在哪儿。
     */
    fileFor,
  }
}
