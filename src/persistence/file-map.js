/**
 * 文件版的「可持久化 Map」—— 无数据库时所有结构化状态的落地处。
 *
 * ── 为什么是这个形状 ────────────────────────────────────────────────────
 *
 * 定时任务、项目、会话元信息这几样东西的读写模式是一样的：按 id 存一个小 JSON、
 * 偶尔全量列一遍、改的时候是 read-modify-write。与其每样各写一遍 fs 调用，不如
 * 定一个接口，将来换 MySQL / Redis 时上层一行不用动。
 *
 * 接口刻意与 qm 的 DurableMap 对齐（all/get/put/putIfAbsent/merge/update/delete），
 * 那边的 cron-store / project-store 就是照着这个接口写的，移植过来时不用改调用方。
 *
 * ── 一条必须说清的边界 ──────────────────────────────────────────────────
 *
 * **本实现只在「单副本」或「所有副本挂同一份共享存储且不并发改同一条」时成立。**
 *
 * 进程内的 read-modify-write 由下面的串行队列保证不丢更新；跨进程没有锁 ——
 * 两个副本同时 merge 同一条记录，后写的会盖掉先写的。本项目的定位是无状态多副本
 * （见 docs/ARCHITECTURE.md），所以：
 *
 *   - 会话/项目/memory 这类**按用户分区**的数据，实践中同一用户的并发 run 上限是
 *     MAX_RUNS_PER_USER=2，且写的是不同 sessionKey，冲突面很小；
 *   - 定时任务的**触发**必须只有一个副本在跑（CRON_ENABLED 默认只在单实例开），
 *     否则同一个任务会被多个副本同时点火。这条写进了 config.js 的校验提示。
 *
 * 真要多副本并发写，换的是这一个文件的实现（上层接口不动），不是散落各处的 fs 调用。
 */
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'

import { assertSegment, safeJoin, writeAtomic } from './paths.js'

/**
 * 按 key 串行化。
 *
 * read-modify-write 在 async 里天然是撕裂的：两个 merge 同时读到同一份旧值，
 * 后写的那个会把前一个的改动整段抹掉。表现是"我明明改了，一刷新又变回去了"，
 * 而且只在并发时出现，测不出来。
 */
function createKeyedQueue() {
  const tails = new Map()
  return function run(key, fn) {
    const prior = tails.get(key) || Promise.resolve()
    // 前一个任务失败不该阻塞后面的，所以先把异常吞掉再接
    const next = prior.then(fn, fn)
    tails.set(
      key,
      next.then(
        () => { if (tails.get(key) === next) tails.delete(key) },
        () => { if (tails.get(key) === next) tails.delete(key) },
      ),
    )
    return next
  }
}

function applyPatch(value, patch) {
  const next = { ...value }
  for (const [key, item] of Object.entries(patch)) {
    // undefined 表示"删掉这个字段"，与 JSON 里"值为 null"区分开
    if (item === undefined) delete next[key]
    else next[key] = item
  }
  return next
}

/**
 * @param {object} params
 * @param {string} params.dir   目录，一条记录一个 `<id>.json`
 * @param {object} [params.logger]
 */
export function createFileMap({ dir, logger = console }) {
  const queue = createKeyedQueue()

  function fileFor(id) {
    return safeJoin(dir, `${assertSegment(id, '记录 id')}.json`)
  }

  async function readOne(id) {
    let raw
    try {
      raw = await readFile(fileFor(id), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    try {
      return JSON.parse(raw)
    } catch {
      /**
       * 单条坏掉不该让整个清单打不开。
       *
       * 坏文件的来源基本只有一个：写到一半被 kill —— 而 writeAtomic 正是为了
       * 让这件事不可能发生。真出现了说明有人绕过它直接写，值得吵一声。
       */
      logger.warn?.('存储记录不是合法 JSON，已跳过', { dir, id })
      return null
    }
  }

  async function ids() {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return [] // 新用户没有目录是正常情况
      throw error
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .sort()
  }

  async function write(id, value) {
    await writeAtomic(fileFor(id), `${JSON.stringify(value, null, 2)}\n`, 'map')
  }

  return {
    dir,

    async all() {
      const out = []
      for (const id of await ids()) {
        const value = await readOne(id)
        if (value) out.push(value)
      }
      return out
    },

    async entries() {
      const out = []
      for (const id of await ids()) {
        const value = await readOne(id)
        if (value) out.push([id, value])
      }
      return out
    },

    get: (id) => readOne(id),

    put: (id, value) => queue(id, async () => { await write(id, value) }),

    /** 已存在就原样返回已有的那条 —— 用来做"创建一次"的幂等 */
    putIfAbsent: (id, value) => queue(id, async () => {
      const existing = await readOne(id)
      if (existing) return existing
      await write(id, value)
      return value
    }),

    /** 局部更新。记录不存在返回 null（而不是凭空造一条） */
    merge: (id, patch) => queue(id, async () => {
      const current = await readOne(id)
      if (!current) return null
      const next = applyPatch(current, patch)
      await write(id, next)
      return next
    }),

    /** 需要读旧值才能算出新值时用它（如"把这次触发追进 fireLog"） */
    update: (id, fn) => queue(id, async () => {
      const current = await readOne(id)
      if (!current) return null
      const next = fn(current)
      await write(id, next)
      return next
    }),

    delete: (id) => queue(id, async () => {
      await rm(fileFor(id), { force: true })
    }),

    take: (id) => queue(id, async () => {
      const current = await readOne(id)
      if (current) await rm(fileFor(id), { force: true })
      return current
    }),
  }
}

/**
 * 按 username 分区的 map 工厂。
 *
 * 隔离契约 #4 的落法：调用方拿不到"全局的 cron 表"，只能拿"某个 username 的 cron 表"，
 * 于是**不存在**一个能读到所有人数据的入口。这比在每个方法里检查 username 更牢靠 ——
 * 后者总有人会漏写一个。
 */
export function createScopedMaps({ dataDir, collection, logger = console }) {
  return {
    for(username) {
      assertSegment(username, 'username')
      return createFileMap({ dir: safeJoin(dataDir, 'users', username, collection), logger })
    },
    /** 有哪些用户建过这个集合。只给定时任务扫描用（它必须跨用户找到到期的任务） */
    async usernames() {
      let entries
      try {
        entries = await readdir(path.join(dataDir, 'users'), { withFileTypes: true })
      } catch (error) {
        if (error.code === 'ENOENT') return []
        throw error
      }
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    },
  }
}
