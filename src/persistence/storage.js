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
 * ── 它提供四种能力，上层只认这四种 ──────────────────────────────────────
 *
 *   mapFor / globalMap   按 id 存一个小 JSON（项目、定时任务、作品元信息、
 *                        分享指针、账号）
 *   docs                 一整篇文档（长期记忆 MEMORY.md）
 *   blobs                作品每一版的文件正文
 *   usage                token 用量台账：只追加的明细行 + 按人/按天/按模型的汇总
 *
 * 这四种之外的东西不要往这儿加。尤其是**会话工作区与用户技能**：它们要被整目录
 * stage 进沙盒、大小没有上限，属于共享文件系统的活（见 src/workspace/store.js），
 * 与本模块无关。
 *
 * `usage` 是后来加的第四种，不是把前三种当橡皮筋抻开：它要的是"按时间窗跨用户
 * 分组求和"，那是 SQL 的活，用 mapFor 实现等于把整张表读进内存自己加一遍 ——
 * 而那正是它在生产上会先垮掉的地方。
 */
import { createMysqlMap, listOwners } from './mysql-map.js'
import { createPool, ensureSchema } from './mysql.js'
import { assertSegment } from './paths.js'

/**
 * 汇总行的收口。
 *
 * mysql2 把 `SUM()` 的结果当 DECIMAL 回成**字符串**（'12345'），`MAX(datetime)`
 * 回成 Date。不收口的话，两个数相加会变成字符串拼接（'12'+'34'='1234'），
 * 而这种错在小数字上看起来只是"这个人用得有点多"。JSON 出去的时间统一 ISO 串。
 */
function toBucket(row) {
  const out = { ...row }
  for (const key of ['runs', 'input', 'output', 'cacheRead', 'tokens']) {
    if (key in out) out[key] = Number(out[key]) || 0
  }
  if ('lastAt' in out) out.lastAt = out.lastAt ? new Date(out.lastAt).toISOString() : null
  return out
}

/**
 * 「累计 / 当日」这一对数字的形状，两个后端共用（替身从这里 import，见
 * test/helpers/memory-storage.js 文件头说的"防漂移"）。
 *
 * `tokens = input + output`，**不含缓存读入** —— 与管理台那张表、与
 * telemetry/usage-store.js 的 sumBuckets 是同一个口径。额度用另一个口径的话，
 * 管理员会看到"用量页写着 80 万，人却在 100 万的额度上被拦了"。
 *
 * mysql2 把 BIGINT 的 SUM 回成字符串（怕溢出 Number），所以每个数都要过一次
 * Number —— 不过的话，`'900000' >= 1000000` 是按字符串比的，比出来是 false。
 */
export function toTotals(row = {}) {
  const bucket = (input, output) => {
    const i = Number(input) || 0
    const o = Number(output) || 0
    return { input: i, output: o, tokens: i + o }
  }
  return { total: bucket(row.totalInput, row.totalOutput), today: bucket(row.dayInput, row.dayOutput) }
}

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

    /**
     * Token 用量台账。
     *
     * ⚠️ 汇总一律在 SQL 里做（SUM + GROUP BY），不把明细行捞回 Node 再加。
     * 一个跑了半年的部署有几十万行，捞回来加一遍的代价全落在管理员点开那一页的
     * 那几秒里 —— 而那几秒会随时间线性变长，上线时看不出来。
     *
     * `since` 是 Date 或 null（null = 不限时间）。所有时间按 UTC 进出
     * （连接上 timezone='Z'，见 mysql.js），所以"按天分组"分的是 UTC 的天。
     */
    usage: {
      /**
       * 记一行。**幂等**：同一个 runId 记第二次原样忽略（`INSERT IGNORE`），
       * 不是覆盖 —— 一次 run 的用量跑完就定了，第二次调用只可能是重放。
       */
      async record({
        username, runId, source = 'web', modelId = '',
        input = 0, output = 0, cacheRead = 0, durationMs = 0, createdAt = null,
      }) {
        assertSegment(username, 'username')
        await pool.query(
          'INSERT IGNORE INTO ap_usage'
          + ' (username, run_id, source, model_id, input_tokens, output_tokens, cache_read_tokens, duration_ms, created_at)'
          + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, UTC_TIMESTAMP()))',
          [
            username, String(runId), String(source).slice(0, 32), String(modelId || '').slice(0, 128),
            Math.max(0, Math.round(Number(input) || 0)),
            Math.max(0, Math.round(Number(output) || 0)),
            Math.max(0, Math.round(Number(cacheRead) || 0)),
            Math.max(0, Math.round(Number(durationMs) || 0)),
            /**
             * 正常写入不传 createdAt，落 UTC_TIMESTAMP()。允许传是为了**契约用例
             * 能测时间窗**（"上周的那几行不该算进最近 7 天"）—— 否则那条用例要
             * 等一天才跑得出来，于是就没人写它。
             */
            createdAt ? new Date(createdAt) : null,
          ],
        )
      },

      /**
       * **用户 × 模型**的交叉表，一次查完。
       *
       * 为什么是交叉表，而不是"按用户"和"按模型"两个各自 GROUP BY：
       *
       *   1. 上层要的两个视图（谁烧得最多 / 哪个模型烧得最多）**是同一份数据的两种
       *      转置**。分成两个查询就有了两份汇总语义，迟早只改一份 —— 而对不上的
       *      表现是"两页的总计差了一点"，谁也说不清哪页是对的。
       *   2. 模型单价差一个数量级。要算钱，"这个人在这个模型上花了多少"才是最小
       *      可计价单元；先按人加完再按模型加，中间那一步就把它丢了。
       *
       * 行数是**真的产生过用量的**组合数（不是账号数 × 模型数），
       * 按人/按模型的转置在 telemetry/usage-store.js 里做，都是纯加法。
       */
      async byUserAndModel({ since = null, usernames = null } = {}) {
        /**
         * `usernames` 是**给一页的行补明细**用的（"这 50 个人各自用了哪些模型"）。
         *
         * 不传就是整张交叉表 —— 那条路只剩契约用例和 `?days=0` 的小部署在走，
         * 管理台的正常路径一律带着一页的人名进来。传空数组回空，不是回全部：
         * "这一页没有人"和"要所有人"必须分得开，否则一次翻到底会突然变成全表扫。
         */
        if (usernames && !usernames.length) return []
        const where = ['(? IS NULL OR created_at >= ?)']
        const params = [since, since]
        if (usernames) {
          where.push(`username IN (${usernames.map(() => '?').join(',')})`)
          params.push(...usernames)
        }
        const [rows] = await pool.query(
          'SELECT username, model_id AS modelId, COUNT(*) AS runs, SUM(input_tokens) AS input,'
          + ' SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheRead, MAX(created_at) AS lastAt'
          + ` FROM ap_usage WHERE ${where.join(' AND ')} GROUP BY username, model_id`
          + ' ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC',
          params,
        )
        return rows.map(toBucket)
      },

      /**
       * 每个模型一行的汇总。**行数天然有界** —— 一个部署里的模型是十几条量级，
       * 而不是账号那种会跟着注册涨的东西。
       *
       * 所以它一次全取，并且同时承担三件事：按模型看的那一页、全局合计
       * （每一行用量都带 model_id，按模型加完就是全部）、以及计价所需的
       * 「每个模型各自多少 token」。三件事一个查询，也就不可能互相对不上。
       */
      async byModel({ since = null } = {}) {
        const [rows] = await pool.query(
          'SELECT model_id AS modelId, COUNT(*) AS runs, SUM(input_tokens) AS input,'
          + ' SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheRead, MAX(created_at) AS lastAt,'
          + ' SUM(input_tokens) + SUM(output_tokens) AS tokens'
          + ' FROM ap_usage WHERE (? IS NULL OR created_at >= ?) GROUP BY model_id'
          + ' ORDER BY tokens DESC, model_id ASC',
          [since, since],
        )
        return rows.map(toBucket)
      },

      /**
       * 这个窗口里**有几个人产生过用量**。
       *
       * 一个整数，但它必须来自数据库：管理台表头那句"N 人在用"从前是数
       * `users.filter(tokens > 0).length` —— 分页之后那会变成"当前加载了几行"，
       * 于是每点一次"加载更多"，表头上那个数就跟着涨一截。
       */
      async countActiveUsers({ since = null } = {}) {
        const [rows] = await pool.query(
          'SELECT COUNT(DISTINCT username) AS n FROM ap_usage WHERE (? IS NULL OR created_at >= ?)',
          [since, since],
        )
        return Number(rows[0]?.n) || 0
      },

      /**
       * 用户维的**一页**：按 token 降序、同数按用户名升序。
       *
       * ── 为什么这一维必须在 SQL 里翻页 ───────────────────────────────────
       *
       * 从前是 `byUserAndModel()` 整张交叉表捞回 Node，再在 JS 里 pivot、排序、
       * 与账号清单左连接。行数是"窗口里产生过用量的 (人 × 模型) 组合数" ——
       * 它跟着人数涨，而管理员点开用量页的那一刻要等的就是这个。
       *
       * ⚠️ 说清楚这一句挡住了什么、没挡住什么：分组求和仍然要扫过窗口内的全部
       * 台账行（`GROUP BY` + 聚合上的 `ORDER BY` 用不上索引，这是聚合分页固有的）。
       * 省掉的是**把结果搬进 Node**那一段 —— 回来的是一页 50 行，
       * 不是几十万行 JS 对象。真到聚合本身也慢的那天，该加的是一张按天预汇总的
       * 物化表，而不是把这里的口径改成"只看最近几天"。
       *
       * @param {{tokens: number, username: string}|null} cursor 上一页最后一行
       */
      async topUsers({ since = null, cursor = null, limit = 50 } = {}) {
        const at = cursor ? Number(cursor.tokens) || 0 : null
        const from = cursor ? String(cursor.username) : ''
        const [rows] = await pool.query(
          'SELECT username, COUNT(*) AS runs, SUM(input_tokens) AS input, SUM(output_tokens) AS output,'
          + ' SUM(cache_read_tokens) AS cacheRead, MAX(created_at) AS lastAt,'
          + ' SUM(input_tokens) + SUM(output_tokens) AS tokens'
          + ' FROM ap_usage WHERE (? IS NULL OR created_at >= ?) GROUP BY username'
          /**
           * 游标条件放 HAVING 不是 WHERE：它比的是聚合结果（这个人一共多少 token），
           * 而 WHERE 在分组之前跑，那时候还没有"一共多少"这个数。
           *
           * 展开成 `tokens < ? OR (tokens = ? AND username > ?)`，与 sessions/cursor.js
           * 里那段同一个道理：单靠 token 数不唯一，同数的两个人会在页边界上
           * 要么漏、要么重，所以补一个用户名当决胜键。
           */
          + ' HAVING (? IS NULL OR tokens < ? OR (tokens = ? AND username > ?))'
          + ' ORDER BY tokens DESC, username ASC LIMIT ?',
          [since, since, at, at, at, from, limit + 1],
        )
        return rows.map(toBucket)
      },

      /**
       * 这几个模型各自**用得最多的前 N 个人**。
       *
       * ── 为什么不能用 byUserAndModel 顶替 ────────────────────────────────
       *
       * 按模型看那一页，每一行下面挂的是"用了这个模型的人"。行数有界（模型就那么
       * 几个），但**每行的 children 没有上限** —— 一个所有人都在用的模型，
       * 它那一行自己就能把整张用户表拖回来。把行分页并不能收住它。
       *
       * `ROW_NUMBER() OVER (PARTITION BY …)` 让"每组取前 N"在一个查询里完成
       * （MySQL 8 的窗口函数，本项目的最低版本就是 8.0）。换成在 Node 里取回全部
       * 再各自截断，省下的只有网络那一段之外的东西 —— 而那一段正是问题所在。
       */
      async topUsersPerModel({ since = null, modelIds = [], limit = 20 } = {}) {
        if (!modelIds.length) return []
        const [rows] = await pool.query(
          'SELECT modelId, username, runs, input, output, cacheRead, lastAt, tokens FROM ('
          + '  SELECT model_id AS modelId, username, COUNT(*) AS runs, SUM(input_tokens) AS input,'
          + '   SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheRead, MAX(created_at) AS lastAt,'
          + '   SUM(input_tokens) + SUM(output_tokens) AS tokens,'
          + '   ROW_NUMBER() OVER ('
          + '     PARTITION BY model_id ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC, username ASC'
          + '   ) AS rn'
          + `   FROM ap_usage WHERE (? IS NULL OR created_at >= ?) AND model_id IN (${modelIds.map(() => '?').join(',')})`
          + '   GROUP BY model_id, username'
          + ' ) ranked WHERE rn <= ? ORDER BY modelId ASC, tokens DESC, username ASC',
          [since, since, ...modelIds, limit],
        )
        return rows.map(toBucket)
      },

      /**
       * 一个用户的按天明细，旧到新 —— 画趋势要的是这个顺序。
       *
       * 带 modelId 就只看这个人在这个模型上的趋势（"换了模型之后用量变了吗"），
       * 不带就是他全部模型加起来。
       */
      async dailyForUser({ username, modelId = '', since = null }) {
        assertSegment(username, 'username')
        const [rows] = await pool.query(
          'SELECT DATE_FORMAT(created_at, \'%Y-%m-%d\') AS day, COUNT(*) AS runs,'
          + ' SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheRead'
          + ' FROM ap_usage WHERE username = ? AND (? = \'\' OR model_id = ?) AND (? IS NULL OR created_at >= ?)'
          + ' GROUP BY day ORDER BY day ASC',
          [username, String(modelId || ''), String(modelId || ''), since, since],
        )
        return rows.map(toBucket)
      },

      /**
       * 一个人的**累计**与**当日**用量，一次查完。给额度闸门用（telemetry/quota.js）。
       *
       * 为什么是一个查询而不是两个：这条路排在**每一次对话开始之前**，两个查询
       * 就是两次往返，而它们扫的是同一段索引区间（`idx_username_created` 上这个人
       * 的那一段）。条件 SUM 让第二个数几乎不要钱。
       *
       * `dayStart` 是一个**瞬间**（Date），不是"日期"——"今天从哪一刻开始"由上层
       * 按时区算好（见 quota.js）。放在这里算的话，这一层就得知道部署在哪个时区，
       * 而它连自己那几张表都是按 UTC 存的。
       *
       * ⚠️ 累计那一半**没有时间下界**，扫的是这个人的全部历史行。跑了一年的重度
       * 用户是几千行的 SUM —— 走索引、不到毫秒，但它会随时间线性变长。真慢到
       * 看得见的那一天，该加的是一张按人的累计快照表，而不是把口径改成"最近 N 天"
       * （那会让"总额度"这个词变成另一个意思）。
       */
      async totalsForUser({ username, dayStart = null }) {
        assertSegment(username, 'username')
        const from = dayStart ? new Date(dayStart) : null
        const [rows] = await pool.query(
          'SELECT COALESCE(SUM(input_tokens), 0) AS totalInput, COALESCE(SUM(output_tokens), 0) AS totalOutput,'
          + ' COALESCE(SUM(CASE WHEN ? IS NULL OR created_at >= ? THEN input_tokens ELSE 0 END), 0) AS dayInput,'
          + ' COALESCE(SUM(CASE WHEN ? IS NULL OR created_at >= ? THEN output_tokens ELSE 0 END), 0) AS dayOutput'
          + ' FROM ap_usage WHERE username = ?',
          [from, from, from, from, username],
        )
        return toTotals(rows[0])
      },

      /**
       * 一个用户的按天明细，**再按模型拆一层**。
       *
       * ── 为什么不能拿 dailyForUser 顶替 ──────────────────────────────────
       *
       * 上面那个不带 modelId 时是 `GROUP BY day` —— 一天一行，模型这一维在 SQL 里
       * 就加没了。折算成本要的最小单元是「一天 × 一个模型」（各模型单价差一个数量级，
       * 见 byUserAndModel 的注释），从一天的合计 token 里再也拆不回来。
       *
       * 于是"这个人每天花多少钱"这条曲线只有两种画法：要么在这里多带一维，
       * 要么按人一天一个价去猜。后者不是精度问题，是**编数字**。
       *
       * 单独一个方法而不是给 dailyForUser 加参数：那个方法有明确的返回形状
       * （一天一行），带模型维的行多一个字段，两种形状挤在一个返回值里，
       * 调用方就得先判断"这次是哪种"——而判断错的表现是把同一天加了好几遍。
       */
      async dailyForUserByModel({ username, since = null }) {
        assertSegment(username, 'username')
        const [rows] = await pool.query(
          'SELECT DATE_FORMAT(created_at, \'%Y-%m-%d\') AS day, model_id AS modelId, COUNT(*) AS runs,'
          + ' SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheRead'
          + ' FROM ap_usage WHERE username = ? AND (? IS NULL OR created_at >= ?)'
          + ' GROUP BY day, model_id ORDER BY day ASC',
          [username, since, since],
        )
        return rows.map(toBucket)
      },

      /** 一个模型的按天明细（全体用户合起来）。看的是"这个模型的量在往哪走" */
      async dailyForModel({ modelId, since = null }) {
        const [rows] = await pool.query(
          'SELECT DATE_FORMAT(created_at, \'%Y-%m-%d\') AS day, COUNT(*) AS runs,'
          + ' SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cacheRead'
          + ' FROM ap_usage WHERE model_id = ? AND (? IS NULL OR created_at >= ?)'
          + ' GROUP BY day ORDER BY day ASC',
          [String(modelId || ''), since, since],
        )
        return rows.map(toBucket)
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
