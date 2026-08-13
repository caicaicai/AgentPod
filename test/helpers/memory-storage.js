/**
 * 存储后端的**测试替身**：全在内存里的 Map。
 *
 * ── 它不是第二个驱动 ────────────────────────────────────────────────────
 *
 * 生产代码只有 MySQL 一种后端（见 src/persistence/storage.js 文件头）。
 * 这个文件住在 test/ 下、不从 src/ 导出、没有任何环境变量能把它接进服务里。
 * 它存在的唯一理由是：**刚 clone 下来的仓库跑 `npm test` 应该全绿**，
 * 而不是要求每个人先起一个数据库才能验证一行业务逻辑。
 *
 * ── 怎么防止它和真后端漂移 ──────────────────────────────────────────────
 *
 * 替身最大的风险是"它自己对了，但跟真的不一样"，于是用例全绿而生产出问题。
 * 所以 test/storage-drivers.test.js 里那套**契约用例对它和真 MySQL 各跑一遍**：
 *
 *   替身   总是跑
 *   MySQL  设了 AP_TEST_MYSQL_URL 时跑
 *
 * 只要 CI 上挂着一个 MySQL，任何一处漂移都会在那边当场变红。
 * 加方法时**两边一起加**，否则契约用例会先告诉你少了什么。
 */

import { assertSegment } from '../../src/persistence/paths.js'

/**
 * 拼键的分隔符。写成转义而不是字面 NUL —— 后者会让 ripgrep 把整个文件判成
 * 二进制并整个跳过（src/sandbox/sticky.js 上真踩过这个坑）。
 * 用它而不是空格：作品的文件路径里是允许有空格的。
 */
const SEP = '\u0000'

/** 深拷贝一次再交出去：调用方改了返回值不该影响存着的那份（真后端天然如此） */
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

/** 与 mysql-map 的 applyPatch 同语义：undefined 删字段，与"值为 null"分得开 */
function applyPatch(value, patch) {
  const next = { ...value }
  for (const [key, item] of Object.entries(patch)) {
    if (item === undefined) delete next[key]
    else next[key] = item
  }
  return next
}

function createMap(store, collection, owner) {
  const prefix = `${collection}${SEP}${owner}${SEP}`
  const keyOf = (id) => `${prefix}${id}`

  /** 这个集合+owner 下的全部条目，按 id 升序 —— 与 SQL 的 ORDER BY id 对齐 */
  function ownEntries() {
    return [...store.kv.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  }

  return {
    dir: `memory:${collection}/${owner || '*'}`,

    async all() {
      return ownEntries().map(([, value]) => clone(value))
    },
    async entries() {
      return ownEntries().map(([id, value]) => [id, clone(value)])
    },
    async get(id) {
      return clone(store.kv.get(keyOf(id))) ?? null
    },
    async put(id, value) {
      store.kv.set(keyOf(id), clone(value))
    },
    async putIfAbsent(id, value) {
      const existing = store.kv.get(keyOf(id))
      if (existing) return clone(existing)
      store.kv.set(keyOf(id), clone(value))
      return value
    },
    async merge(id, patch) {
      const current = store.kv.get(keyOf(id))
      if (!current) return null
      const next = applyPatch(current, patch)
      store.kv.set(keyOf(id), clone(next))
      return clone(next)
    },
    async update(id, fn) {
      const current = store.kv.get(keyOf(id))
      if (!current) return null
      const next = fn(clone(current))
      store.kv.set(keyOf(id), clone(next))
      return clone(next)
    },
    async delete(id) {
      store.kv.delete(keyOf(id))
    },
    async take(id) {
      const current = store.kv.get(keyOf(id))
      if (!current) return null
      store.kv.delete(keyOf(id))
      return clone(current)
    },
  }
}

/**
 * @returns 与 createStorage() 同形状的后端。`driver` 报 `memory`，
 *   于是万一它被误接进生产路径，`/healthz` 上会**立刻看得出来**。
 */
export function createMemoryStorage() {
  const store = {
    kv: new Map(), // `${collection}\0${owner}\0${id}` -> 记录
    docs: new Map(), // `${username}\0${kind}\0${scope}` -> 正文
    blobs: new Map(), // `${username}\0${id}\0${version}\0${path}` -> 正文
  }

  /**
   * ⚠️ 这里的 assertSegment 与真后端**必须一致**：少了它，"username 拼不出越界"
   * 这类用例在替身上会一路绿灯，而真库那边才拦。校验本身是共用的那一个函数。
   */
  const docKey = ({ username, scope = '', kind = 'memory' }) => {
    assertSegment(username, 'username')
    if (scope) assertSegment(scope, 'scope')
    return `${username}${SEP}${kind}${SEP}${scope}`
  }
  const blobPrefix = (username, id, version) => `${username}${SEP}${id}${SEP}${version}${SEP}`

  return {
    driver: 'memory',
    pool: null,

    mapFor: (collection, username) => createMap(store, collection, assertSegment(username, 'username')),
    globalMap: (collection) => createMap(store, collection, ''),

    async usernames(collection) {
      const prefix = `${collection}${SEP}`
      const out = new Set()
      for (const key of store.kv.keys()) {
        if (!key.startsWith(prefix)) continue
        const owner = key.slice(prefix.length).split(SEP)[0]
        if (owner) out.add(owner)
      }
      return [...out]
    },

    docs: {
      async read(scope) {
        return store.docs.get(docKey(scope)) ?? ''
      },
      async write(scope, content) {
        store.docs.set(docKey(scope), String(content))
      },
      async remove(scope) {
        store.docs.delete(docKey(scope))
      },
      /** 与真后端一致：不挑 kind，这个作用域下所有文档一起清 */
      async dropScope({ username, scope }) {
        if (!scope) return
        assertSegment(username, 'username')
        assertSegment(scope, 'scope')
        for (const key of [...store.docs.keys()]) {
          const [owner, , docScope] = key.split(SEP)
          if (owner === username && docScope === scope) store.docs.delete(key)
        }
      },
    },

    blobs: {
      async writeVersion({ username, id, version, files }) {
        for (const file of files) {
          store.blobs.set(`${blobPrefix(username, id, version)}${file.path}`, String(file.content))
        }
      },
      async readVersion({ username, id, version, paths }) {
        const out = new Map()
        for (const relPath of paths) {
          const content = store.blobs.get(`${blobPrefix(username, id, version)}${relPath}`)
          // 报错文案与真后端逐字一致：用例会去匹配它
          if (content === undefined) throw new Error(`第 ${version} 版的 ${relPath} 不存在（可能被手工删除）`)
          out.set(relPath, content)
        }
        return out
      },
      async removeVersion({ username, id, version }) {
        const prefix = blobPrefix(username, id, version)
        for (const key of [...store.blobs.keys()]) if (key.startsWith(prefix)) store.blobs.delete(key)
      },
      async removeArtifact({ username, id }) {
        const prefix = `${username}${SEP}${id}${SEP}`
        for (const key of [...store.blobs.keys()]) if (key.startsWith(prefix)) store.blobs.delete(key)
      },
      async listVersion({ username, id, version }) {
        const prefix = blobPrefix(username, id, version)
        return [...store.blobs.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length))
          .sort()
      },
    },

    async close() {},

    /** 契约用例每条之前清一次，与 mysql 那边 DELETE 各表对应 */
    reset() {
      store.kv.clear()
      store.docs.clear()
      store.blobs.clear()
    },
  }
}
