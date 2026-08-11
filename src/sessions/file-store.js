/**
 * 会话存储：文件版（`SESSION_STORE=file`）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 *
 * 之前只有两个驱动：`memory`（进程一重启，所有人的对话全没了）和 `mysql`
 * （要先有一套库表和运维）。中间是空的，而"聊天记录能留住"是个对话产品的
 * 及格线，不该跟"接不接数据库"绑在一起。
 *
 * ── 落盘形状 ────────────────────────────────────────────────────────────
 *
 *   <dataDir>/users/<username>/sessions/<sessionKey>/
 *     session.jsonl   pi 的 append-only 会话树，原样落地
 *     meta.json       标题、条数、所属项目、置顶/归档、时间戳
 *
 * 正文与元信息分开存，是因为两者的写入模式完全不同：正文只追加（一轮几十 KB），
 * 元信息是整体重写（几百字节）。混在一个文件里就得每轮把整段会话重写一遍 ——
 * 一个跑了两百轮的会话，每轮都要读写几 MB。
 *
 * 追加是**按已有行数比对**的，与 mysql 驱动同一套语义：pi 的会话是 append-only，
 * 历史行不会被改写，所以只写新增那几行。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 *
 * 单副本，或多副本挂同一份共享盘且同一会话不并发写。理由见
 * src/persistence/file-map.js 开头。多副本部署仍应使用 mysql 驱动。
 */
import { readFile, appendFile, readdir, rm, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { assertSegment, safeJoin, writeAtomic, userRoot } from '../persistence/paths.js'
import { normalizeTitle } from './store.js'

const META_FILE = 'meta.json'
const JSONL_FILE = 'session.jsonl'

/** 列表一次最多回多少条。够翻很久，又不至于把几千个会话一次灌进浏览器 */
const LIST_LIMIT = 200

/** 全文搜索最多扫多少个会话的正文 —— 再多就该上索引了，而不是硬扫 */
const SEARCH_SCAN_LIMIT = 200

function assertScoped(query, where) {
  if (!query?.username) throw new Error(`${where}: 缺少 username —— 会话读写必须按用户隔离（隔离契约 #4）`)
}

function countLines(text) {
  let n = 0
  for (const line of String(text || '').split('\n')) if (line.trim()) n += 1
  return n
}

/** 一条 JSONL entry 里的可读正文（用户说的 + 助手说的，不含工具输出） */
function readableText(line) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return ''
  }
  const content = entry?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part?.type === 'text').map((part) => part.text || '').join(' ')
}

/**
 * 命中位置附近的一段正文。没命中返回 null。
 *
 * **逐行解析出正文再匹配**，而不是在整段 JSONL 上直接找关键词。后者省事，
 * 但截出来的片段长这样：
 *   `ext","text":"我是跑在服务端的 pi agent（LLM_MODE=faux…`
 * —— 用户要的是"在哪句话里说过这个词"，给他一段转义后的 JSON 等于没给。
 *
 * 顺带把工具调用的入参与结果排除在外了：搜"结算"不该被一条 grep 命令的参数命中。
 */
function findSnippet(jsonl, keyword) {
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue
    // 先在原始行上粗筛：绝大多数行不含关键词，没必要为它们各做一次 JSON.parse
    if (!line.toLowerCase().includes(keyword)) continue
    const text = readableText(line)
    const at = text.toLowerCase().indexOf(keyword)
    if (at < 0) continue
    const from = Math.max(0, at - 30)
    const raw = text.slice(from, at + keyword.length + 60).replace(/\s+/g, ' ')
    return `${from > 0 ? '…' : ''}${raw}${at + keyword.length + 60 < text.length ? '…' : ''}`
  }
  return null
}

export function createFileStore({ config, logger = console }) {
  const dataDir = config.dataDir

  function sessionsDir(username) {
    return safeJoin(userRoot(dataDir, username), 'sessions')
  }

  function sessionDir(username, sessionKey) {
    return safeJoin(sessionsDir(username), assertSegment(sessionKey, 'sessionKey'))
  }

  /**
   * ⚠️ 路径校验必须在 try **外面**。
   *
   * 写在里面的话，`assertSegment` 抛出的"越界"会被下面那个 catch 一并吞掉，
   * 于是一次目录穿越尝试的表现变成"这个会话不存在" —— 与真的没有这条会话完全
   * 分不开。今天穿越本来也不会成功（safeJoin 先抛了），但把违规吞成 null 意味着
   * 哪天校验被放松，唯一的信号也一起消失了。catch 只该覆盖"文件读不出来"。
   */
  async function readMeta(username, sessionKey) {
    const file = path.join(sessionDir(username, sessionKey), META_FILE)
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return null
      // 元信息坏了不该让正文也读不出来：按"没有元信息"处理，正文照常能取
      logger.warn?.('会话元信息损坏，按空处理', { username, sessionKey })
      return null
    }
  }

  async function readJsonl(username, sessionKey) {
    const file = path.join(sessionDir(username, sessionKey), JSONL_FILE)
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return ''
      throw error
    }
  }

  async function writeMeta(username, sessionKey, meta) {
    await writeAtomic(path.join(sessionDir(username, sessionKey), META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'meta')
  }

  /** 列表行：**不带正文**。正文按需由 load 取 */
  function toRow(username, sessionKey, meta) {
    return {
      username,
      sessionKey,
      sessionId: meta?.sessionId || '',
      title: meta?.title || '',
      entryCount: meta?.entryCount || 0,
      projectId: meta?.projectId || '',
      pinned: Boolean(meta?.pinned),
      archived: Boolean(meta?.archived),
      updatedAt: meta?.updatedAt || 0,
      createdAt: meta?.createdAt || meta?.updatedAt || 0,
    }
  }

  async function listKeys(username) {
    try {
      const entries = await readdir(sessionsDir(username), { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch (error) {
      if (error.code === 'ENOENT') return [] // 新用户还没有目录
      throw error
    }
  }

  async function allRows(username) {
    const rows = []
    for (const sessionKey of await listKeys(username)) {
      const meta = await readMeta(username, sessionKey)
      if (!meta) continue
      rows.push(toRow(username, sessionKey, meta))
    }
    /**
     * 置顶的排前面，其余按最近更新。
     * 归档的**不在这里过滤** —— 过滤是调用方的事（界面要能翻出归档区）。
     */
    return rows.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt))
  }

  return {
    driver: 'file',
    root: dataDir,

    async load(query) {
      assertScoped(query, 'store.load')
      const meta = await readMeta(query.username, query.sessionKey)
      if (!meta) return null
      return { ...toRow(query.username, query.sessionKey, meta), jsonl: await readJsonl(query.username, query.sessionKey) }
    },

    async save(row) {
      assertScoped(row, 'store.save')
      const dir = sessionDir(row.username, row.sessionKey)
      await mkdir(dir, { recursive: true })

      // 只追加新增的行。pi 的会话是 append-only，历史行不会被改写，
      // 所以没必要每轮把整段重写一遍（一个长会话那是每轮几 MB 的无谓 IO）。
      const existing = await readJsonl(row.username, row.sessionKey)
      const already = countLines(existing)
      const lines = String(row.jsonl || '').split('\n').filter((line) => line.trim())
      if (lines.length > already) {
        const appended = lines.slice(already)
        await appendFile(path.join(dir, JSONL_FILE), `${appended.join('\n')}\n`)
        logger.debug?.('会话增量落盘', { username: row.username, appended: appended.length })
      }

      const prior = await readMeta(row.username, row.sessionKey)
      const now = Date.now()
      await writeMeta(row.username, row.sessionKey, {
        sessionId: row.sessionId || prior?.sessionId || '',
        // 已有标题永远优先：save 每轮都会带一个"从本轮提问推出来的"候选标题，
        // 若它能覆盖，用户改过的名字会在下一轮对话后被悄悄改回去（rename 才是改名的入口）。
        title: prior?.title || normalizeTitle(row.title),
        entryCount: row.entryCount ?? lines.length,
        // 项目归属由 setProject 维护，save 不该动它
        projectId: prior?.projectId || row.projectId || '',
        pinned: Boolean(prior?.pinned),
        archived: Boolean(prior?.archived),
        createdAt: prior?.createdAt || now,
        updatedAt: now,
      })
    },

    async list(query) {
      assertScoped(query, 'store.list')
      let rows = await allRows(query.username)
      if (query.projectId !== undefined) {
        rows = rows.filter((row) => (row.projectId || '') === (query.projectId || ''))
      }
      if (!query.includeArchived) rows = rows.filter((row) => !row.archived)
      return rows.slice(0, query.limit || LIST_LIMIT)
    },

    async rename(query) {
      assertScoped(query, 'store.rename')
      const meta = await readMeta(query.username, query.sessionKey)
      if (!meta) return false
      await writeMeta(query.username, query.sessionKey, { ...meta, title: normalizeTitle(query.title), updatedAt: Date.now() })
      return true
    },

    async remove(query) {
      assertScoped(query, 'store.remove')
      const dir = sessionDir(query.username, query.sessionKey)
      try {
        await stat(dir)
      } catch {
        return false
      }
      await rm(dir, { recursive: true, force: true })
      return true
    },

    /**
     * 置顶 / 归档 / 改项目归属。
     *
     * 合成一个方法而不是三个：它们改的是同一份 meta，分开写就是三次
     * read-modify-write，并发下互相覆盖。
     */
    async patch(query) {
      assertScoped(query, 'store.patch')
      const meta = await readMeta(query.username, query.sessionKey)
      if (!meta) return null
      const next = { ...meta }
      if (query.title !== undefined) next.title = normalizeTitle(query.title)
      if (query.pinned !== undefined) next.pinned = Boolean(query.pinned)
      if (query.archived !== undefined) next.archived = Boolean(query.archived)
      if (query.projectId !== undefined) next.projectId = String(query.projectId || '')
      /**
       * `updatedAt` 只在改了标题时才动。
       *
       * 置顶/归档不该把会话顶到列表最前面 —— 那是"最近聊过"的意思，
       * 而归档恰恰表达的是相反的意图。
       */
      if (query.title !== undefined) next.updatedAt = Date.now()
      await writeMeta(query.username, query.sessionKey, next)
      return toRow(query.username, query.sessionKey, next)
    },

    /**
     * 搜索。
     *
     * 标题命中直接算；标题没命中才去翻正文 —— 正文要读文件，能少读就少读。
     * 命中时回一小段上下文，界面上就能显示"在哪句话里命中的"，而不是只给个标题
     * 让人点进去自己找。
     */
    async search(query) {
      assertScoped(query, 'store.search')
      const keyword = String(query.q || '').trim().toLowerCase()
      if (!keyword) return []

      const rows = await allRows(query.username)
      const hits = []
      let scanned = 0
      for (const row of rows) {
        if ((row.title || '').toLowerCase().includes(keyword)) {
          hits.push({ ...row, matchedIn: 'title', snippet: '' })
          continue
        }
        if (scanned >= SEARCH_SCAN_LIMIT) continue
        scanned += 1
        const jsonl = await readJsonl(query.username, row.sessionKey)
        const snippet = findSnippet(jsonl, keyword)
        if (snippet === null) continue
        hits.push({ ...row, matchedIn: 'content', snippet })
      }
      return hits.slice(0, query.limit || 50)
    },
  }
}
