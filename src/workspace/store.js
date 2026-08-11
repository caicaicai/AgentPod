/**
 * 用户工作空间：跨 run 存活的那一份数据。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 *
 * 今天云端**没有任何东西能活过一个 run**：
 *   - `runTurn` 每轮建临时目录，`finally` 里 rm -rf；
 *   - 沙盒租约释放不是删文件，是**整个 slot 销毁重建**（leases.js:192，
 *     "零残留的保证来源，不是 rm -rf 能替代的"）。
 *
 * 于是"帮我做个技能"这件事在云端根本不成立：模型在沙盒里把 SKILL.md 和
 * scripts/ 写出来，run 一结束连同 slot 一起蒸发，没有任何机制能把它捞出来。
 *
 * ── 边界怎么划 ──────────────────────────────────────────────────────
 *
 * 底层是挂在**所有 agent 节点**上的同一份共享存储（平台能力）。**worker 上
 * 一个字节都不挂** —— 沙盒保持纯粹，隔离仍然靠"别人的东西根本不在那儿"，
 * 而不是靠文件权限位。（slot 的 uid 是槽位序号不是人，用 POSIX 属主做租户
 * 隔离在这个模型下是不成立的。）
 *
 *   <root>/users/<username>/
 *     skills/created/<name>/      我自己的技能 —— stage 进沙盒，**只读，不回写**
 *     skills/installed/<name>/    从库里装的   —— 同上
 *     sessions/<key>/workspace/   会话工作区   —— stage 进沙盒 **且回写**
 *
 * 读写语义**跟目录对齐**，不去 diff、不猜哪些变了：规则一句话说得清 ——
 * 只有 `workspace/` 会回来。否则一个跑歪的脚本就能改掉你装好的技能。
 *
 * 工作区**按会话分**而不是按用户分：同一个人可能有两个 run 并发（
 * MAX_RUNS_PER_USER=2），还可能落在不同副本上，共用一个目录就是互相覆盖；
 * 而按会话分之后，"下次接着干"的语义也正好对上。
 */
import path from 'node:path'
import { mkdir, readdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises'

/**
 * username 会成为一段路径。它来自服务端认证（客户端说了不算），但"来源可信"
 * 和"内容适合当路径"是两回事 —— 收口成一个明确字符集，再叠一道解析后的边界
 * 检查。两道独立防线，任一条单独成立都够用。
 */
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/

/** 沙盒工作区里被同步回来的那个子目录。名字要和 stage 进去的一致 */
export const WORKSPACE_DIR = 'workspace'

/** 个人技能的两个桶，与桌面端 `userData/custom-skills/{created,installed}` 同名同义 */
export const SKILL_SCOPES = ['created', 'installed']

function assertSegment(value, what) {
  const text = String(value || '')
  if (text === '.' || text === '..' || !SEGMENT_RE.test(text)) {
    throw new Error(`${what} 不能作为目录名：只允许字母、数字、点、下划线、连字符，且不超过 64 字符`)
  }
  return text
}

/**
 * 解析之后再校验边界。
 *
 * 在原始字符串里找 `..` 是不行的 —— 编码、多重分隔符、平台差异都能绕过去。
 * `path.resolve` 把这些都摊平了，检查结果落在哪儿才是可靠的。
 */
function safeJoin(root, ...parts) {
  const resolved = path.resolve(root, ...parts)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`路径越界：${parts.join('/')} 解析后跑出了 ${root}`)
  }
  return resolved
}

/** 不进工作空间的东西。同 skill-materializer 的口径 */
const SKIP_ENTRIES = new Set(['node_modules', '__pycache__', '.git', '.venv', '.DS_Store'])

/**
 * 遍历本地目录，返回 `[{ relPath, size }]`。
 *
 * **软链接一律跳过。** 沙盒里跑的是用户/模型写的代码，它能造出指向任意位置的
 * 软链接；跟着走就等于让它决定我们读写共享盘上的哪一块。方向和
 * `skill-materializer.collectSkillFiles` 那条相反，风险是同一类。
 */
async function walkLocal(root, { maxFiles, maxBytes }) {
  const files = []
  let bytes = 0

  async function walk(dir, prefix) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (SKIP_ENTRIES.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name

      const info = await lstat(full)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        await walk(full, relPath)
        continue
      }
      if (!info.isFile()) continue

      if (files.length >= maxFiles) throw new Error(`工作空间文件数超过上限 ${maxFiles}`)
      bytes += info.size
      if (bytes > maxBytes) throw new Error(`工作空间体积超过上限 ${maxBytes} 字节`)
      files.push({ relPath, size: info.size })
    }
  }

  await walk(root, '')
  return { files, bytes }
}

/** 原子落地：先写临时文件再 rename。共享盘上多副本并发时，读到的永远是完整内容 */
async function writeAtomic(target, content, tag) {
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${tag}`
  await writeFile(tmp, content)
  await rename(tmp, target)
}

export function createWorkspaceStore({ config, logger = console }) {
  const root = config.userWorkspace?.root || ''
  const limits = {
    maxFiles: config.userWorkspace?.maxFiles ?? 2000,
    maxBytes: config.userWorkspace?.quotaBytes ?? 200 * 1024 * 1024,
    maxSyncFiles: config.userWorkspace?.maxSyncFiles ?? 500,
  }

  /** 没配 root 就是这个能力整体关闭 —— 行为与今天完全一致，便于灰度 */
  const enabled = Boolean(root)

  /** 无上限地量一棵树。配额判断要的是真实占用，不能用一本会漂的账 */
  async function measure(dir) {
    const { files, bytes } = await walkLocal(dir, {
      maxFiles: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
    })
    return { bytes, files: files.length }
  }

  function userRoot(username) {
    assertSegment(username, 'username')
    return safeJoin(root, 'users', username)
  }

  function sessionWorkspaceDir(username, sessionKey) {
    assertSegment(sessionKey, 'sessionKey')
    return safeJoin(userRoot(username), 'sessions', sessionKey, WORKSPACE_DIR)
  }

  function skillScopeDir(username, scope) {
    if (!SKILL_SCOPES.includes(scope)) throw new Error(`未知技能桶 ${scope}`)
    return safeJoin(userRoot(username), 'skills', scope)
  }

  return {
    enabled,
    root,
    limits,
    userRoot,
    sessionWorkspaceDir,
    skillScopeDir,

    /** 个人技能目录，交给 loadSkillsFromDir 扫。目录不存在不是错误（新用户） */
    skillDirs(username) {
      if (!enabled) return []
      return SKILL_SCOPES.map((scope) => skillScopeDir(username, scope))
    },

    /** 当前占用。配额是 agent 自己算的 —— 共享盘一般不给 per-user quota，
     *  而没有配额就意味着"一个人写满，所有人一起挂"。 */
    async usage(username) {
      if (!enabled) return { bytes: 0, files: 0, quotaBytes: limits.maxBytes }
      return { ...(await measure(userRoot(username))), quotaBytes: limits.maxBytes }
    },

    /**
     * 会话工作区 → 沙盒。返回的是 skill-materializer 那套 `[{path, content}]`，
     * 由同一条懒推送路径送进去，不另起机制。
     */
    async stageFiles({ username, sessionKey }) {
      if (!enabled) return []
      const dir = sessionWorkspaceDir(username, sessionKey)
      const { files } = await walkLocal(dir, limits)
      if (!files.length) return []

      const staged = []
      for (const file of files) {
        staged.push({
          path: `${WORKSPACE_DIR}/${file.relPath}`,
          content: await readFile(safeJoin(dir, file.relPath)),
        })
      }
      return staged
    },

    /**
     * 沙盒 → 会话工作区。
     *
     * **必须在 `session.release()` 之前调用** —— release 是整个 slot 销毁重建，
     * 排在它后面就什么都捞不到了。
     *
     * 镜像语义（沙盒里删了上游也删）只在能确信"看全了"时才执行：列目录被截断、
     * 或沙盒回了空列表而上游有东西，都退化成只增不删。丢数据比留下陈旧文件糟得多。
     */
    async syncBack({ username, sessionKey, session, runId = 'run' }) {
      if (!enabled || !session) return { written: 0, deleted: 0, skipped: true }

      let listing
      try {
        listing = await session.listFiles({ path: WORKSPACE_DIR, recursive: true, includeHidden: true })
      } catch (error) {
        // 沙盒里压根没建过 workspace/ 是正常情况（这一轮没用到），不当错误
        if (error?.code === 'NOT_FOUND' || /没有目录/.test(error?.message || '')) {
          return { written: 0, deleted: 0, empty: true }
        }
        throw error
      }

      const dir = sessionWorkspaceDir(username, sessionKey)
      const wanted = []
      for (const item of listing.items || []) {
        // 只要普通文件。symlink 不跟：沙盒里能 `ln -s` 到任意位置
        if (item.kind !== 'file') continue
        // 沙盒报的路径是相对工作区根的 `workspace/xxx`，剥掉前缀再校验
        const rel = item.path.startsWith(`${WORKSPACE_DIR}/`) ? item.path.slice(WORKSPACE_DIR.length + 1) : null
        if (!rel) continue
        if (SKIP_ENTRIES.has(rel.split('/')[0])) continue
        safeJoin(dir, rel) // 越界直接抛，别写到别人目录去
        wanted.push({ rel, sandboxPath: item.path, size: item.size || 0 })
      }

      if (wanted.length > limits.maxSyncFiles) {
        throw new Error(`本轮工作区有 ${wanted.length} 个文件，超过单次同步上限 ${limits.maxSyncFiles}`)
      }

      /**
       * 配额。这一轮同步会把该会话的工作区**整体换成**沙盒里那一份，所以
       * 判断依据是「换完之后总共占多少」，而不是简单地把新旧相加 ——
       * 后者会把反复编辑同一个大文件误判成一直在涨。
       */
      const totalBefore = await measure(userRoot(username))
      const sessionBefore = await measure(dir)
      const incoming = wanted.reduce((sum, file) => sum + file.size, 0)
      const projected = totalBefore.bytes - sessionBefore.bytes + incoming
      if (projected > limits.maxBytes) {
        throw new Error(
          `工作空间配额不足：同步完将占用 ${projected} 字节，上限 ${limits.maxBytes} 字节。` +
            '请先清理不再需要的文件。',
        )
      }

      let written = 0
      const BATCH = 20
      for (let i = 0; i < wanted.length; i += BATCH) {
        const slice = wanted.slice(i, i + BATCH)
        const results = await session.getFiles(slice.map((file) => file.sandboxPath))
        for (const [index, result] of results.entries()) {
          if (!result.ok) {
            logger.warn?.('工作区文件读取失败，跳过', { runId, path: slice[index].rel, err: result.error })
            continue
          }
          await writeAtomic(safeJoin(dir, slice[index].rel), result.content, runId)
          written += 1
        }
      }

      /**
       * ── 镜像删除 ──
       *
       * 沙盒里删掉的文件，上游也该没 —— 否则"我明明删了它怎么还在"。
       * 但只在能确信**看全了**的时候才做：
       *
       *   - 列目录被截断 → 没看全，删了就是删掉没看见的那些；
       *   - 沙盒回空列表而上游有东西 → 也可能是这一轮压根没碰工作区、
       *     或者列目录出了岔子。这时候删就是**静默清空用户的数据**。
       *
       * 两种情况都退化成只增不删。留下陈旧文件远比丢数据轻。
       */
      let deleted = 0
      const emptyButUpstreamHas = wanted.length === 0 && sessionBefore.files > 0
      if (listing.truncated || emptyButUpstreamHas) {
        logger.warn?.('本轮工作区同步只增不删', {
          runId,
          username,
          reason: listing.truncated ? '沙盒目录列表被截断' : '沙盒里没有文件而上游有',
        })
      } else {
        const keep = new Set(wanted.map((file) => file.rel))
        const { files: existing } = await walkLocal(dir, limits)
        for (const file of existing) {
          if (keep.has(file.relPath)) continue
          await rm(safeJoin(dir, file.relPath), { force: true })
          deleted += 1
        }
      }

      return { written, deleted, truncated: Boolean(listing.truncated) }
    },

    /** 会话删了，它的工作区跟着删 —— 不然孤儿目录会一直堆着占配额 */
    async removeSession({ username, sessionKey }) {
      if (!enabled) return false
      const dir = safeJoin(userRoot(username), 'sessions', assertSegment(sessionKey, 'sessionKey'))
      await rm(dir, { recursive: true, force: true })
      return true
    },

    /** 内部工具，给 skill_save 保存技能用 */
    async writeSkillFiles({ username, scope, name, files, tag = 'publish' }) {
      const target = safeJoin(skillScopeDir(username, scope), assertSegment(name, '技能名'))
      // 覆盖式保存：先清干净，避免上一版残留的脚本还留在里面被模型读到
      await rm(target, { recursive: true, force: true })
      for (const file of files) {
        await writeAtomic(safeJoin(target, file.relPath), file.content, tag)
      }
      return target
    },

    async removeSkill({ username, scope, name }) {
      const target = safeJoin(skillScopeDir(username, scope), assertSegment(name, '技能名'))
      await rm(target, { recursive: true, force: true })
      return true
    },
  }
}
