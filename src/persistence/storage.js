/**
 * 结构化存储：MySQL。**只有这一种。**
 *
 * ── 为什么不留文件模式 ──────────────────────────────────────────────────
 *
 * 曾经有过一个 `file` 驱动（落 DATA_DIR）和一个 `STORAGE_DRIVER` 开关。
 * 去掉它不是因为它不好用，而是因为**同时支持两种模式的成本落在了每一处**：
 *
 *   - 每加一个存储动作，都要在两边各实现一遍，还要写一条契约用例钉住它们一致；
 *   - 两边的语义差异只在生产上现形（大家开发时都跑 file），
 *     而现象是某个功能"偶尔"不对；
 *   - 文件驱动的读改写只在进程内串行，跨副本没有锁 —— 于是它永远只能是
 *     "单副本时能用"，而任何一份认真的部署最后都会换到数据库上。
 *
 * 所以现在只有一条路。代价必须写明白：**跑起这个服务需要一个 MySQL**，
 * 本地开发也一样（`docker compose --profile dev up -d mysql` 或任意一个 MySQL 8）。
 *
 * ── 它提供三种能力，上层只认这三种 ──────────────────────────────────────
 *
 *   mapFor / globalMap   按 id 存一个小 JSON（项目、定时任务、作品元信息、
 *                        分享指针、账号）
 *   docs                 一整篇文档（长期记忆 MEMORY.md）
 *   blobs                作品每一版的文件正文
 *
 * 这三种之外的东西不要往这儿加。尤其是**会话工作区与用户技能**：它们要被整目录
 * stage 进沙盒、大小没有上限，属于共享文件系统的活（见 src/workspace/store.js），
 * 与本模块无关。
 */
import { createMysqlMap, listOwners } from './mysql-map.js'
import { createPool, ensureSchema } from './mysql.js'
import { assertSegment } from './paths.js'

/**
 * 建后端：连库 + 建表。
 *
 * 连不上就当场抛，服务起不来。那是有意的 —— 起来了但第一次写数据才报错，
 * 用户看到的是一条业务失败，而运维在部署日志里什么都看不到。
 *
 * @param {object} [params.pool] 已经建好的池（测试里复用连接用）。正常启动不传。
 * @returns {Promise<{driver, pool, mapFor, globalMap, usernames, docs, blobs, close}>}
 */
export async function createStorage({ config, logger = console, pool: sharedPool = null }) {
  const pool = sharedPool || await createPool({ config, logger })
  if (!sharedPool) await ensureSchema(pool, logger)

  return {
    driver: 'mysql',
    pool,

    /**
     * owner 关在闭包里：调用方拿不到一个能读到所有人数据的 map（隔离契约 #4）。
     * 这不是靠每个方法里检查 username，而是**根本没有那个入口**。
     */
    mapFor: (collection, username) => createMysqlMap({
      pool, collection, owner: assertSegment(username, 'username'), logger,
    }),

    /**
     * 不按人分的集合。目前只有两处，都有明确理由：
     *   shares    访客手里只有 token，服务端必须能不带 username 查到它属于谁
     *   accounts  账号按定义就不属于某一个用户
     */
    globalMap: (collection) => createMysqlMap({ pool, collection, owner: '', logger }),

    /** 有哪些人在这个集合下存过东西。只给定时任务的跨用户扫描用 */
    usernames: (collection) => listOwners({ pool, collection }),

    /**
     * 整篇文档。
     *
     * ⚠️ `username` 与 `scope` 在这里**必须过一遍 assertSegment**，与 mapFor 一样。
     * 参数化查询挡得住注入，但挡不住"传进来的根本不是一个合法主体"——
     * 文件驱动时代那道检查是 userRoot() 顺带做的，换成数据库之后它就没有了，
     * 而少了它，一个拼错的 username 会安静地写出一条谁也读不到的记录。
     */
    docs: {
      async read({ username, scope = '', kind = 'memory' }) {
        assertSegment(username, 'username')
        if (scope) assertSegment(scope, 'scope')
        const [rows] = await pool.query(
          'SELECT content FROM ap_doc WHERE username = ? AND kind = ? AND scope = ? LIMIT 1',
          [username, kind, scope],
        )
        return rows[0]?.content ?? ''
      },
      async write({ username, scope = '', kind = 'memory' }, content) {
        assertSegment(username, 'username')
        if (scope) assertSegment(scope, 'scope')
        await pool.query(
          'INSERT INTO ap_doc (username, kind, scope, content) VALUES (?, ?, ?, ?)'
          + ' ON DUPLICATE KEY UPDATE content = VALUES(content), updated_at = CURRENT_TIMESTAMP',
          [username, kind, scope, content],
        )
      },
      async remove({ username, scope = '', kind = 'memory' }) {
        assertSegment(username, 'username')
        if (scope) assertSegment(scope, 'scope')
        await pool.query('DELETE FROM ap_doc WHERE username = ? AND kind = ? AND scope = ?', [username, kind, scope])
      },
      /**
       * 这个作用域**整块**没了（项目被删）。与 remove 分开是因为语义不同：
       * remove 是"记忆清空了，别留一条空记录"，dropScope 是"这个作用域不存在了"，
       * 所以它不挑 kind，一并清掉。
       */
      async dropScope({ username, scope }) {
        if (!scope) return
        assertSegment(username, 'username')
        assertSegment(scope, 'scope')
        await pool.query('DELETE FROM ap_doc WHERE username = ? AND scope = ?', [username, scope])
      },
    },

    blobs: {
      /**
       * 一整版一个事务：要么这一版的文件全在，要么一个都没有。
       *
       * 中途失败留下"半个版本"的话，元信息会说这版有 5 个文件而库里只有 3 个，
       * 而这种不一致要等用户点开那一版才暴露出来。
       */
      async writeVersion({ username, id, version, files }) {
        const conn = await pool.getConnection()
        try {
          await conn.beginTransaction()
          for (const file of files) {
            await conn.query(
              'INSERT INTO ap_artifact_file (username, artifact_id, version, path, content) VALUES (?, ?, ?, ?, ?)'
              + ' ON DUPLICATE KEY UPDATE content = VALUES(content)',
              [username, id, Number(version), file.path, file.content],
            )
          }
          await conn.commit()
        } catch (error) {
          await conn.rollback().catch(() => {})
          throw error
        } finally {
          conn.release()
        }
      },

      async readVersion({ username, id, version, paths }) {
        const [rows] = await pool.query(
          'SELECT path, content FROM ap_artifact_file WHERE username = ? AND artifact_id = ? AND version = ?',
          [username, id, Number(version)],
        )
        const found = new Map(rows.map((row) => [row.path, row.content]))
        const out = new Map()
        for (const relPath of paths) {
          // 元信息说有、库里却没有：只可能是有人手工改过表。
          // 报得具体一点，别让它表现成一句笼统的"读取失败"
          if (!found.has(relPath)) throw new Error(`第 ${version} 版的 ${relPath} 不存在（可能被手工删除）`)
          out.set(relPath, found.get(relPath))
        }
        return out
      },

      async removeVersion({ username, id, version }) {
        await pool.query(
          'DELETE FROM ap_artifact_file WHERE username = ? AND artifact_id = ? AND version = ?',
          [username, id, Number(version)],
        )
      },

      async removeArtifact({ username, id }) {
        await pool.query('DELETE FROM ap_artifact_file WHERE username = ? AND artifact_id = ?', [username, id])
      },

      /** 库里真实存着的文件列表，用于自检（元信息与实际是否对得上） */
      async listVersion({ username, id, version }) {
        const [rows] = await pool.query(
          'SELECT path FROM ap_artifact_file WHERE username = ? AND artifact_id = ? AND version = ? ORDER BY path ASC',
          [username, id, Number(version)],
        )
        return rows.map((row) => row.path)
      },
    },

    async close() {
      // 借来的池不关：借出去的一方还在用它
      if (!sharedPool) await pool.end()
    },
  }
}

/**
 * 各 store 的统一入口检查。
 *
 * 从前 storage 不传就默默退回文件后端，于是"忘了接线"表现为数据写去了另一个地方 ——
 * 而那要等到换台机器、或者查"我的项目怎么没了"时才发现。现在缺了就当场抛。
 */
export function requireStorage(storage, who) {
  if (!storage?.mapFor) {
    throw new Error(`${who} 需要 storage（见 src/persistence/storage.js）：本服务只支持 MySQL 存储`)
  }
  return storage
}
