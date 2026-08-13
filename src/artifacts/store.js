/**
 * 作品（artifact）：助手产出的、**独立于对话正文存在**的那一份东西。
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────────
 *
 * 助手写一个 200 行的 HTML 报表，只能整段贴进对话气泡里。三个后果：
 *   1. 一屏全是代码，对话本身读不下去；
 *   2. 想改一行，模型得把 200 行**再贴一遍**（token 翻倍，还容易在重贴时改坏别处）；
 *   3. 用户拿不到成品 —— 复制粘贴到编辑器、存成文件、在浏览器里打开，全靠手工。
 *
 * ── 一份作品是一组文件，不是一段文本 ────────────────────────────────────
 *
 * 第一版只存一段正文。那等于要求模型把样式、脚本、组件全塞进一个文件里 ——
 * 稍微复杂一点的东西就没法拆模块，而"能拆"恰恰是它值得存下来的原因。
 * 所以作品是一棵小文件树：
 *
 *   <dataDir>/users/<username>/artifacts/
 *     <id>.json          元信息（标题、类型、入口、每一版的文件清单）
 *     <id>/v1/index.html 第 1 版的全部文件，**原样的文件名和后缀**
 *     <id>/v1/app.js
 *     <id>/v1/style.css
 *     <id>/v2/…          第 2 版（自包含，不是相对上一版的差量）
 *
 * 后缀保持原样（`.html` 就是 `.html`）：作品是给人拿去用的东西，
 * 运维直接把 `v2/` 拷出来就能打开。**代价必须写明白**：里面躺的是模型生成的
 * HTML/JS，所以 `DATA_DIR` 绝不能被任何静态服务直接暴露出去 —— 那等于把一批
 * 由模型（也就可能由一封诱导邮件）决定内容的页面挂到你自己的域名上。
 * 本服务自己从不这么干：`/v1/artifacts/:id/raw` 一律 `text/plain` 下发。
 *
 * ── 每一版都是完整快照，不是差量 ────────────────────────────────────────
 *
 * 模型改动时只传改了的文件（省 token），但落盘时把未变的文件一起复制进新版本目录。
 * 这样"删掉太老的版本"就只是 `rm -rf v1/` —— 如果版本之间互相依赖，清理就得先
 * 算引用，而算错的后果是某一版永远打不开。用一点磁盘换一个不会算错的规则。
 */
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { createFileMap } from '../persistence/file-map.js'
import { assertSegment, safeJoin, userRoot, writeAtomic } from '../persistence/paths.js'

/**
 * 作品类型。**这个清单等于"界面渲染得出来的东西"**，不是"模型想得到的东西" ——
 * 加一种之前先想清楚 web/src/lib/artifact-view.js 里拿什么画它。
 * 加了却画不出来的类型，表现是用户点开一片空白，比不支持更糟。
 *
 *   web       多文件网页（html + css + js），入口 index.html
 *   vue       Vue 单文件组件项目，入口 App.vue，预览时在浏览器里编译
 *   markdown  文档，支持 ```mermaid 代码块
 *   mermaid   单张图（.mmd）
 *   svg       矢量图
 *   code      代码 / 配置，只看源码不预览
 */
export const ARTIFACT_KINDS = ['web', 'vue', 'markdown', 'mermaid', 'svg', 'code']

/** 各类型的默认入口。模型没指定 entry 时按这个找，找不到就用第一个文件 */
const DEFAULT_ENTRY = {
  web: 'index.html',
  vue: 'App.vue',
  markdown: 'README.md',
  mermaid: 'diagram.mmd',
  svg: 'image.svg',
  code: '',
}

const TITLE_MAX = 80
const LANGUAGE_MAX = 24
const PATH_MAX = 120
const PATH_DEPTH_MAX = 6

/**
 * 文件名里不能出现的东西。
 *
 * ── 为什么是黑名单而不是白名单 ──────────────────────────────────────────
 *
 * 第一版用的是 `^[A-Za-z0-9][A-Za-z0-9._-]*$`，结果 `方案.md` 直接被拒 ——
 * 而中文文件名恰恰是这个功能最常见的用法（一份给人看的报告，标题就是中文）。
 * 用户拿到的是一句"路径片段不合法"，而他并没有做错任何事。
 *
 * 所以反过来：**只挡真正会出事的那几类**，其余放行。
 *   - `.` / `..` 与分隔符 → 目录穿越（真正的防线仍是解析后的 safeJoin，这里是让
 *     模型当场看懂自己错在哪，而不是拿到一句莫名其妙的"路径越界"）
 *   - 控制字符 → 能把日志和终端搅乱
 *   - `<>:"|?*` → Windows 上不是合法文件名，跨平台部署时会变成"只在某些机器上失败"
 *   - 结尾的点或空格 → Windows 会悄悄吃掉，于是 `a.` 和 `a` 成了同一个文件
 */
const PATH_BAD_CHARS = /[\u0000-\u001f<>:"|?*\\]/

export function assertRelPath(input) {
  const text = String(input || '').trim().replace(/\\/g, '/')
  if (!text) throw new Error('文件路径不能为空')
  if (text.length > PATH_MAX) throw new Error(`文件路径超过 ${PATH_MAX} 字符：${text.slice(0, 40)}…`)
  if (text.startsWith('/')) throw new Error(`文件路径必须是相对路径（不要以 / 开头）：${text}`)
  const parts = text.split('/').filter((part) => part !== '')
  if (!parts.length) throw new Error('文件路径不能为空')
  if (parts.length > PATH_DEPTH_MAX) throw new Error(`目录层级超过 ${PATH_DEPTH_MAX} 层：${text}`)
  for (const part of parts) {
    if (part === '.' || part === '..') throw new Error(`路径里不能出现 "${part}"：不允许跳出作品自己的目录`)
    if (PATH_BAD_CHARS.test(part)) {
      throw new Error(`文件名 "${part}" 里有不能用的字符（控制字符或 <>:"|?* 之一）`)
    }
    // Windows 会悄悄把结尾的点和空格吃掉，于是 `a.` 和 `a` 会变成同一个文件
    if (/[. ]$/.test(part)) throw new Error(`文件名 "${part}" 不能以点或空格结尾`)
    if (part.length > 60) throw new Error(`文件名 "${part.slice(0, 20)}…" 超过 60 字符`)
  }
  return parts.join('/')
}

function newArtifactId() {
  // 短一点：它会出现在路径、URL 和模型的下一次调用里
  return `a_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function cleanTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
}

/** 正文一律 LF：CRLF 混进来之后，模型的定点替换会因为看不见的 \r 而永远匹配不上 */
function normalizeContent(content) {
  return String(content ?? '').replace(/\r\n/g, '\n')
}

/** 规范化模型传来的文件数组 */
function normalizeFiles(input, what = 'files') {
  if (!Array.isArray(input) || !input.length) throw new Error(`${what} 必须是非空数组，形如 [{ path, content }]`)
  const seen = new Set()
  const files = []
  for (const item of input) {
    const relPath = assertRelPath(item?.path)
    if (seen.has(relPath)) throw new Error(`同一次调用里出现了两个 ${relPath}`)
    seen.add(relPath)
    files.push({ path: relPath, content: normalizeContent(item?.content) })
  }
  return files
}

/**
 * 挑入口文件。
 *
 * 入口是"预览从哪个文件开始"，选错了表现是打开一片空白。所以三层兜底：
 * 模型指定的 → 该类型的惯例名 → 第一个文件。最后一层保证**永远有入口**。
 */
function pickEntry({ kind, entry, paths }) {
  if (entry) {
    const wanted = assertRelPath(entry)
    if (!paths.includes(wanted)) throw new Error(`entry 指向的 ${wanted} 不在文件列表里`)
    return wanted
  }
  const conventional = DEFAULT_ENTRY[kind]
  if (conventional && paths.includes(conventional)) return conventional
  // markdown / vue 常常不叫惯例名，按后缀找第一个像入口的
  const byExt = { markdown: '.md', vue: '.vue', mermaid: '.mmd', svg: '.svg', web: '.html' }[kind]
  if (byExt) {
    const hit = paths.find((item) => item.toLowerCase().endsWith(byExt))
    if (hit) return hit
  }
  return paths[0]
}

/**
 * 对外形状。**不含文件正文** —— 清单接口一次可能回几十条，
 * 每条都带上正文的话，"打开作品面板"就成了一次几 MB 的传输。
 */
function toPublic(record) {
  if (!record) return null
  return {
    id: record.id,
    sessionKey: record.sessionKey || '',
    projectId: record.projectId || '',
    kind: record.kind,
    language: record.language || '',
    title: record.title || '',
    entry: record.entry || '',
    version: record.version || 1,
    versions: (record.versions || []).map((item) => ({
      n: item.n,
      createdAt: item.createdAt || 0,
      bytes: item.bytes || 0,
      files: (item.files || []).map((file) => ({ path: file.path, bytes: file.bytes || 0 })),
      note: item.note || '',
      pruned: Boolean(item.pruned),
    })),
    /**
     * 分享状态：`{ token, market, marketAt, summary, createdAt }`，没分享过是 null。
     *
     * 它是「这份作品还分不分享」的**权威**（指针表只是索引），细节见 shares.js 文件头。
     * 只出现在作者自己看到的这一份形状里 —— 给访客的那份由 shares.js 单独拼，
     * 刻意不复用这个函数。
     */
    share: record.share || null,
    createdAt: record.createdAt || 0,
    updatedAt: record.updatedAt || 0,
  }
}

export function createArtifactStore({ config, logger = console }) {
  const dataDir = config.dataDir
  const settings = config.artifacts || {}
  const enabled = settings.enabled !== false
  const limits = {
    /** 单个版本**所有文件加起来**的上限 */
    maxBytes: settings.maxBytes ?? 512 * 1024,
    maxVersions: settings.maxVersions ?? 20,
    maxFiles: settings.maxFiles ?? 40,
  }

  function mapFor(username) {
    assertSegment(username, 'username')
    return createFileMap({ dir: safeJoin(userRoot(dataDir, username), 'artifacts'), logger })
  }

  /** 作品自己那棵目录（各版本各一个子目录） */
  function dirFor(username, id) {
    return safeJoin(userRoot(dataDir, username), 'artifacts', assertSegment(id, '作品 id'))
  }

  function versionDir(username, id, n) {
    return safeJoin(dirFor(username, id), `v${Number(n)}`)
  }

  function fileIn(username, id, n, relPath) {
    // 再走一次 safeJoin：assertRelPath 拦的是字符集，越界要以**解析后**的结果为准
    return safeJoin(versionDir(username, id, n), ...assertRelPath(relPath).split('/'))
  }

  function assertBudget(files) {
    if (files.length > limits.maxFiles) {
      throw new Error(`文件数 ${files.length} 超过上限 ${limits.maxFiles}`)
    }
    const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0)
    if (bytes > limits.maxBytes) {
      throw new Error(`全部文件共 ${bytes} 字节，超过单版上限 ${limits.maxBytes} 字节`)
    }
    return bytes
  }

  /**
   * 落一个新版本（完整快照），并把超出保留窗口的旧版本目录删掉。
   *
   * 删旧版之前先把元信息写回去：反过来的话，进程在两步之间挂掉会留下
   * "元信息说这一版还在、文件其实已经没了"的记录，而那种不一致只有用户
   * 点开旧版本时才会暴露出来。
   */
  async function commitVersion({ username, record, files, note }) {
    const totalBytes = assertBudget(files)
    const n = (record.version || 0) + 1

    for (const file of files) {
      await writeAtomic(fileIn(username, record.id, n, file.path), file.content, 'artifact')
    }

    const entry = record.entry
    const versions = [...(record.versions || []), {
      n,
      createdAt: Date.now(),
      bytes: totalBytes,
      files: files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content, 'utf8') })),
      note: note || '',
    }]

    const keepFrom = Math.max(0, versions.length - limits.maxVersions)
    const pruned = []
    for (let i = 0; i < keepFrom; i += 1) {
      if (versions[i].pruned) continue
      versions[i] = { ...versions[i], pruned: true }
      pruned.push(versions[i].n)
    }

    const next = { ...record, entry, version: n, versions, updatedAt: Date.now() }
    await mapFor(username).put(record.id, next)

    for (const old of pruned) {
      await rm(versionDir(username, record.id, old), { recursive: true, force: true }).catch((error) => {
        logger.warn?.('旧版本目录清理失败', { username, id: record.id, version: old, err: error?.message })
      })
    }
    return next
  }

  /**
   * 早期版本只存一段正文（`<id>/v1.txt`，元信息里是 `type` 不是 `kind`）。
   *
   * 在读的时候就地适配，而不是写一个迁移脚本：这类记录只可能出现在功能刚上线
   * 那几天的部署里，为它引入一次性迁移的运维步骤不划算。**新写入一律是新格式**，
   * 所以这段代码的作用范围只增不减地缩小，将来可以直接删掉。
   */
  function adaptLegacy(record) {
    if (!record || record.entry) return record
    const kind = record.type === 'html' ? 'web' : (record.type || 'code')
    const ext = { web: 'index.html', markdown: 'README.md', svg: 'image.svg' }[kind] || 'main.txt'
    return {
      ...record,
      kind,
      entry: ext,
      legacy: true,
      versions: (record.versions || []).map((item) => ({ ...item, files: [{ path: ext, bytes: item.bytes || 0 }] })),
    }
  }

  /** 读某一版的全部文件 */
  async function readVersion({ username, id, version = 0 }) {
    const raw = await mapFor(username).get(assertSegment(id, '作品 id'))
    if (!raw) return null
    const record = adaptLegacy(raw)
    const n = Number(version) || record.version
    const entry = (record.versions || []).find((item) => item.n === n)
    if (!entry) throw new Error(`作品 ${id} 没有第 ${n} 版`)
    if (entry.pruned) {
      throw new Error(`第 ${n} 版的文件已被清理（只保留最近 ${limits.maxVersions} 版），当前是第 ${record.version} 版`)
    }

    const files = []
    for (const item of entry.files || []) {
      // 老格式的正文在 `<id>/v1.txt`，新格式在 `<id>/v1/<path>`
      const file = record.legacy
        ? safeJoin(dirFor(username, id), `v${n}.txt`)
        : fileIn(username, id, n, item.path)
      let content
      try {
        content = await readFile(file, 'utf8')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        // 元信息说有、文件却不在：只可能是有人手动删过盘上的东西。
        // 报得具体一点，别让它表现成一句笼统的"读取失败"。
        throw new Error(`第 ${n} 版的 ${item.path} 不存在（可能被手工删除）`)
      }
      files.push({ path: item.path, content, bytes: Buffer.byteLength(content, 'utf8') })
    }
    return { meta: toPublic(record), version: n, files }
  }

  async function removeOne({ username, id }) {
    const key = assertSegment(id, '作品 id')
    const existing = await mapFor(username).get(key)
    if (!existing) return false
    await mapFor(username).delete(key)
    // 文件目录跟着走：留着就是一份谁也访问不到、却还占着盘的孤儿
    await rm(dirFor(username, key), { recursive: true, force: true }).catch((error) => {
      logger.warn?.('作品文件目录清理失败', { username, id: key, err: error?.message })
    })
    return true
  }

  return {
    enabled,
    limits,
    dirFor,

    async create({
      username, sessionKey = '', projectId = '', kind, title, files, entry = '', language = '', note = '',
    }) {
      if (!ARTIFACT_KINDS.includes(kind)) {
        throw new Error(`kind 只能是 ${ARTIFACT_KINDS.join(' / ')}，当前 ${kind}`)
      }
      const clean = cleanTitle(title)
      if (!clean) throw new Error('标题不能为空')
      const normalized = normalizeFiles(files)
      if (!normalized.some((file) => file.content.trim())) throw new Error('所有文件都是空的')

      const now = Date.now()
      const record = {
        id: newArtifactId(),
        username,
        sessionKey: String(sessionKey || ''),
        projectId: String(projectId || ''),
        kind,
        language: String(language || '').trim().slice(0, LANGUAGE_MAX),
        title: clean,
        entry: pickEntry({ kind, entry, paths: normalized.map((file) => file.path) }),
        version: 0,
        versions: [],
        createdAt: now,
        updatedAt: now,
      }
      return toPublic(await commitVersion({ username, record, files: normalized, note: note || '创建' }))
    },

    /** @returns {Promise<{meta, version, files: Array<{path, content, bytes}>} | null>} */
    read: readVersion,

    /**
     * 增删改文件，产出新版本。
     *
     * 语义是**合并**：传进来的文件覆盖同名的、新增没有的，`remove` 里的删掉，
     * 其余原样带到新版本。模型因此只需要发改动的那几个文件 —— 这正是多文件
     * 作品比"整段重贴"省的地方。
     */
    async write({ username, id, files = [], remove = [], entry, title, note = '' }) {
      const current = await readVersion({ username, id })
      if (!current) return null

      const incoming = files.length ? normalizeFiles(files) : []
      const dropped = new Set((remove || []).map((item) => assertRelPath(item)))

      const merged = new Map(current.files.map((file) => [file.path, file.content]))
      for (const item of dropped) {
        if (!merged.has(item)) throw new Error(`要删的 ${item} 不在当前版本里`)
        merged.delete(item)
      }
      for (const file of incoming) merged.set(file.path, file.content)

      const next = [...merged].map(([filePath, content]) => ({ path: filePath, content }))
      if (!next.length) throw new Error('不能把作品的文件全删光（要删整份请用界面上的删除）')

      const record = await mapFor(username).get(id)
      const clean = title === undefined ? record.title : cleanTitle(title)
      if (!clean) throw new Error('标题不能为空')

      return toPublic(await commitVersion({
        username,
        record: {
          ...record,
          title: clean,
          entry: pickEntry({
            kind: record.kind,
            // 没显式改 entry 就沿用旧的；但旧入口要是被这次操作删掉了，就重新挑一个
            entry: entry || (merged.has(record.entry) ? record.entry : ''),
            paths: next.map((file) => file.path),
          }),
        },
        files: next,
        note: note || (incoming.length || dropped.size ? '修改文件' : '更新'),
      }))
    },

    /**
     * 定点替换某个文件里的一段，产出新版本。
     *
     * **要求 oldStr 在该文件里只出现一次**，与各家编辑工具的契约一致。
     * 出现多次时不做"替换第一处"这种猜测：模型看不到替换结果，猜错了它不会知道，
     * 而用户看到的是"改了一处、坏了另一处"。宁可让它带更多上下文重试。
     */
    async replace({ username, id, path: relPath, oldStr, newStr, note = '' }) {
      const current = await readVersion({ username, id })
      if (!current) return null

      const wanted = assertRelPath(relPath)
      const file = current.files.find((item) => item.path === wanted)
      if (!file) {
        throw new Error(`当前版本没有 ${wanted}（现有：${current.files.map((item) => item.path).join('、')}）`)
      }

      const target = normalizeContent(oldStr)
      if (!target) throw new Error('old_str 不能为空（要整份替换这个文件请用 write）')
      const occurrences = file.content.split(target).length - 1
      if (occurrences === 0) throw new Error(`old_str 在 ${wanted} 里找不到（注意缩进和换行要一模一样）`)
      if (occurrences > 1) {
        throw new Error(`old_str 在 ${wanted} 里出现了 ${occurrences} 次，无法确定改哪一处：请带上更多上下文让它唯一`)
      }

      const record = await mapFor(username).get(id)
      return toPublic(await commitVersion({
        username,
        record,
        files: current.files.map((item) => ({
          path: item.path,
          content: item.path === wanted ? item.content.replace(target, normalizeContent(newStr)) : item.content,
        })),
        note: note || `修改 ${wanted}`,
      }))
    },

    /**
     * 清单。
     *
     * `sessionKey` 传了就只回这一条会话的 —— 界面上的作品面板是跟着当前对话走的，
     * 把别的会话的混进来，用户只会以为串号了。
     */
    async list({ username, sessionKey = '' } = {}) {
      const all = await mapFor(username).all()
      return all
        .map(adaptLegacy)
        .filter((record) => !sessionKey || record.sessionKey === sessionKey)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map(toPublic)
    },

    async get({ username, id }) {
      if (!id) return null
      return toPublic(adaptLegacy(await mapFor(username).get(assertSegment(id, '作品 id'))))
    },

    /**
     * 写分享状态。传 null 表示撤销（字段整个删掉，而不是留一个 `{}`）。
     *
     * **不产生新版本**：分享是"这份东西给谁看"，不是内容的改动。
     * 走 merge 而不是 read-modify-write，是为了搭上 file-map 的按 key 串行队列 ——
     * 作者点"发布到市场"的同一时刻模型可能正在出新版本，两者写的是同一个 JSON。
     */
    async setShare({ username, id, share }) {
      const key = assertSegment(id, '作品 id')
      const record = await mapFor(username).merge(key, { share: share || undefined })
      return record ? toPublic(adaptLegacy(record)) : null
    },

    remove: removeOne,

    /** 会话删了，它的作品跟着删 —— 与 workspace.removeSession 同一个道理 */
    async removeSession({ username, sessionKey }) {
      if (!enabled || !sessionKey) return 0
      const all = await mapFor(username).all()
      let removed = 0
      for (const record of all) {
        if (record.sessionKey !== sessionKey) continue
        if (await removeOne({ username, id: record.id })) removed += 1
      }
      return removed
    },

    /** 某一版在盘上的目录，给"整份导出"这类外部工具用 */
    async versionPath({ username, id, version }) {
      const dir = versionDir(username, id, version)
      await stat(dir)
      return dir
    },

    /** 盘上真实的文件列表，用于自检（元信息与实际是否对得上） */
    async listOnDisk({ username, id, version }) {
      const dir = versionDir(username, id, version)
      const out = []
      async function walk(current, prefix) {
        for (const item of await readdir(current, { withFileTypes: true })) {
          const next = path.join(current, item.name)
          const rel = prefix ? `${prefix}/${item.name}` : item.name
          if (item.isDirectory()) await walk(next, rel)
          else if (item.isFile()) out.push(rel)
        }
      }
      await walk(dir, '')
      return out.sort()
    },
  }
}

/**
 * 下载单个文件时的文件名。
 *
 * 多文件之后不再需要"按类型猜后缀"—— 文件本来就有名字，直接用最后一段。
 * 仍然要过一遍：路径分隔符不能进文件名，否则浏览器那边行为各不相同。
 */
export function artifactFileName({ title, entry } = {}) {
  const name = String(entry || '').split('/').pop()
  if (name) return name
  const base = String(title || 'artifact').replace(/[\\/:*?"<>|]/g, '-').trim() || 'artifact'
  return `${base}.txt`
}

/**
 * `Content-Disposition` 的值。
 *
 * ── 为什么不能直接把文件名塞进去 ────────────────────────────────────────
 *
 * 标题多半是中文。Node 的 `writeHead` 对非 latin1 的头值**直接抛
 * `ERR_INVALID_CHAR`** —— 于是一次正常的下载会变成一条 500，而报错信息里
 * 只字不提"文件名"。（这不是假想：第一版就是这么写的，被
 * test/workspace-api.test.js 里那条 raw 用例当场抓出来。）
 *
 * RFC 6266 的解法是两个都给：`filename=` 放退化到 ASCII 的那份（老客户端认），
 * `filename*=` 放 UTF-8 百分号编码的那份（现代浏览器优先用它）。
 */
export function artifactDisposition({ fileName, download = false }) {
  const name = String(fileName || 'artifact.txt')
  // 引号和反斜杠会把 quoted-string 提前闭合，非 ASCII 会让 Node 抛错，一起换掉
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}
