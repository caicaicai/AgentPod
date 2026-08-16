/**
 * MySQL 连接、建表与升级。
 *
 * ── 一个进程一个池 ──────────────────────────────────────────────────────
 *
 * 会话、项目、记忆、作品、分享、账号全走同一个连接池。各建各的池会让
 * `connectionLimit` 变成一个没人算得清的数字：配 10，实际是 6 个池各 10 条，
 * 而 MySQL 那边 `max_connections` 是按连接算的，多副本一乘就把数据库打满。
 *
 * ── 表结构在启动时对齐 ──────────────────────────────────────────────────
 *
 * 一条 `docker compose up` 就该能用，不必先手工导表 —— "忘了导表"的表现是一堆
 * ER_NO_SUCH_TABLE，报错指向某一次业务操作，跟"少跑了一步部署命令"看不出关系。
 *
 * 启动时按顺序做三件事：
 *
 *   1. **建表**（schema.sql，全是 CREATE TABLE IF NOT EXISTS）。新库到这一步
 *      就已经是最终形状了。
 *   2. **升级**（migrations/*.sql，按文件名顺序，跑过的记在 ap_schema_migration
 *      里不再跑）。老库靠这一步补上新列、新索引。
 *   3. **核对**（拿 schema.sql 声明的列去比 information_schema）。
 *
 * ── 为什么 schema.sql 和 migrations/ 两处都要写 ─────────────────────────
 *
 * 它们回答的不是同一个问题：
 *
 *   schema.sql    这张表**应该长什么样** —— 新库照它建，也是人要读的那一份
 *   migrations/   从旧形状**怎么走到**新形状 —— 老库照它改
 *
 * `CREATE TABLE IF NOT EXISTS` 对已经存在的表是彻底的空操作，所以光改 schema.sql
 * 对老库一点作用都没有。反过来，光写 migration 而不改 schema.sql，新库也是对的
 * （migration 会替它补上），只是 schema.sql 从此不再可信 —— 而它是所有人查
 * "这张表有哪些列"时会去看的那一份。
 *
 * 两种写漏各有一层网兜着，都在启动时炸、不留到用户面前：
 *
 *   漏了 migration    → 第 3 步核对时发现库里缺列，**拒绝启动**并告诉你缺哪一列
 *   漏了 schema.sql   → test/migrations.test.js 里那条一致性检查不过
 *
 * ⚠️ 迁移必须**向后兼容**（只加列、加索引，不删不改名）。部署失败会自动回滚
 * 代码（scripts/deploy.sh），但**不会回滚已经执行的迁移** —— 上一版代码得能在
 * 新表结构上继续跑。要删列，等新代码稳定几个版本之后再单开一个迁移删。
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 会话表的 DDL 早于本模块存在，一并建，免得两处各管一半 */
const SCHEMA_FILES = [
  path.join(__dirname, 'schema.sql'),
  path.join(__dirname, '..', 'sessions', 'schema.sql'),
]

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

/** 迁移台账。它自己不能靠迁移来建，所以 DDL 写在这里 */
const MIGRATION_LEDGER = `
CREATE TABLE IF NOT EXISTS \`ap_schema_migration\` (
  \`version\`    VARCHAR(128) NOT NULL COMMENT '迁移文件名（不含 .sql）',
  \`applied_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`duration_ms\` INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (\`version\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='已执行的表结构迁移'`

/**
 * 建表/改表时可以忽略的错误。
 *
 * 它们的共同点是"目标状态已经达到了"：列已在、键已在、要删的东西本来就不存在。
 * 新库上跑迁移必然撞 1060 —— schema.sql 已经把列建好了，迁移再加一次。
 * **别往这个表里加别的错误号**，尤其别加 1142（权限不足）：那必须让部署当场
 * 失败，而不是等第一次写业务数据时才炸。
 */
const ALREADY_DONE = new Set([
  1050, // 表已存在
  1060, // 列已存在
  1061, // 索引已存在
  1091, // 要 DROP 的列/索引不存在
])

/**
 * 把 .sql 切成一条条语句。
 *
 * 只按分号切并丢掉注释行 —— 我们自己的 schema 里没有存储过程、没有 DELIMITER，
 * 不需要一个真正的 SQL 分词器。**但注释必须先去掉**：schema.sql 里有
 * `-- ALTER TABLE ...;` 这样被注释掉的迁移语句，不去掉就会被当成真语句执行。
 */
export function splitStatements(sql) {
  return String(sql)
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
}

/**
 * 从 CREATE TABLE 语句里读出每张表声明了哪些列。
 *
 * 只认"以反引号列名开头的行"，`PRIMARY KEY` / `KEY` / `UNIQUE KEY` 那几行天然
 * 不匹配。这不是一个 SQL 解析器，也不需要是 —— 它读的只有我们自己那两个
 * schema 文件，格式是一行一列。解析不出列的表会被整张跳过（宁可漏报也不误报：
 * 这个结果拿去决定"要不要拒绝启动"）。
 *
 * @returns {Map<string, Set<string>>} 表名 → 列名集合
 */
export function parseDeclaredColumns(sql) {
  const tables = new Map()
  const createRe = /CREATE TABLE (?:IF NOT EXISTS )?`([^`]+)`\s*\(([\s\S]*?)\n\)/gi
  for (const [, table, body] of String(sql).matchAll(createRe)) {
    const columns = new Set()
    for (const line of body.split('\n')) {
      const match = line.trim().match(/^`([^`]+)`\s+[A-Za-z]/)
      if (match) columns.add(match[1])
    }
    if (columns.size) tables.set(table, columns)
  }
  return tables
}

/**
 * 读 migrations/ 目录，按文件名排序。
 *
 * 顺序就是文件名的字典序，所以文件名必须**零填充编号**（0001-、0002-…）。
 * 目录不存在时返回空数组：一个还没有任何迁移的仓库是正常状态，不是错误。
 */
export async function loadMigrations(dir = MIGRATIONS_DIR) {
  let entries
  try {
    entries = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const files = entries.filter((name) => name.endsWith('.sql')).sort()
  return Promise.all(files.map(async (name) => ({
    version: name.replace(/\.sql$/, ''),
    statements: splitStatements(await readFile(path.join(dir, name), 'utf8')),
  })))
}

/** 执行一条 DDL，"已经是目标状态"的那几个错当成功 */
async function runStatement(conn, statement, what) {
  try {
    await conn.query(statement)
    return true
  } catch (error) {
    if (ALREADY_DONE.has(error?.errno)) return false
    const head = statement.slice(0, 80).replace(/\s+/g, ' ')
    throw new Error(`${what}失败（${error.code || error.errno}）：${head}… —— ${error.message}`)
  }
}

/**
 * 核对库里的列有没有把 schema.sql 声明的都覆盖住。
 *
 * 这一条网兜的是"加了列却忘了写迁移"：新库正常（CREATE TABLE 带上了新列），
 * 老库上那一列压根不存在，而代码已经在读它了。没有这个检查，表现是服务正常
 * 启动、某个功能一点就 ER_BAD_FIELD_ERROR —— 报错落在用户面前，不在部署日志里。
 *
 * 只查"少了什么"。库里多出来的列不管：那可能是还没清理的旧列，或者别人加的，
 * 都不构成本次部署跑不起来的理由。
 */
async function verifyColumns(conn, declared, database, logger) {
  const tables = [...declared.keys()]
  if (!tables.length) return
  const [rows] = await conn.query(
    'SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?)',
    [database, tables],
  )
  const actual = new Map()
  for (const row of rows) {
    const table = row.TABLE_NAME || row.table_name
    if (!actual.has(table)) actual.set(table, new Set())
    actual.get(table).add(row.COLUMN_NAME || row.column_name)
  }

  const missing = []
  for (const [table, columns] of declared) {
    const have = actual.get(table)
    // 表根本不在库里 = 上面建表那步没轮到它（比如权限只给了部分表）。
    // 这不是"缺列"，交给真正去读它的那条语句报错，信息更准
    if (!have) continue
    for (const column of columns) if (!have.has(column)) missing.push(`${table}.${column}`)
  }
  if (missing.length) {
    throw new Error(
      `表结构落后于代码，缺少这些列：${missing.join('、')}。` +
      'schema.sql 里声明了但库里没有 —— 说明这次改动漏写了迁移。' +
      '在 src/persistence/migrations/ 下补一个 ALTER TABLE … ADD COLUMN 文件再部署。',
    )
  }
  logger.debug?.('表结构核对通过', { tables: tables.length })
}

/**
 * 建表 + 跑迁移 + 核对。可反复执行。
 *
 * 全程占着**同一条连接**：GET_LOCK 是按连接算的，从池里随手取连接会让锁加在
 * 一条连接上、DDL 跑在另一条上，锁等于没加。多副本同时启动时那意味着两个进程
 * 同时 ALTER 同一张表。
 */
export async function ensureSchema(pool, logger = console) {
  const conn = pool.getConnection ? await pool.getConnection() : pool
  const locked = conn !== pool
  try {
    if (locked) {
      // 60 秒等不到就别等了：与其让所有副本堆在这里，不如让这一个起不来，
      // 报错里直接说清楚是在等谁
      const [[lock]] = await conn.query("SELECT GET_LOCK('agentpod_schema', 60) AS ok")
      if (!lock?.ok) throw new Error('等不到表结构锁（另一个实例正在升级表结构，60 秒未完成）')
    }
    return await applySchema(conn, logger)
  } finally {
    if (locked) {
      await conn.query("SELECT RELEASE_LOCK('agentpod_schema')").catch(() => {})
      conn.release?.()
    }
  }
}

/** ensureSchema 的正文，拆出来是为了让持锁/放锁那一层保持一眼能看完 */
async function applySchema(conn, logger) {
  let executed = 0
  const declared = new Map()

  // 1. 建表
  for (const file of SCHEMA_FILES) {
    const sql = await readFile(file, 'utf8')
    for (const [table, columns] of parseDeclaredColumns(sql)) declared.set(table, columns)
    for (const statement of splitStatements(sql)) {
      if (await runStatement(conn, statement, '建表')) executed += 1
    }
  }

  // 2. 跑没跑过的迁移
  await conn.query(MIGRATION_LEDGER)
  const [doneRows] = await conn.query('SELECT `version` FROM `ap_schema_migration`')
  const done = new Set(doneRows.map((row) => row.version))
  const migrations = await loadMigrations()
  const applied = []

  for (const migration of migrations) {
    if (done.has(migration.version)) continue
    const startedAt = Date.now()
    for (const statement of migration.statements) {
      await runStatement(conn, statement, `迁移 ${migration.version}`)
    }
    // 记账放在最后：中途抛了就不落账，下次启动会从头再跑这一个。
    // 所以迁移里的每一条都得能重跑 —— ALREADY_DONE 覆盖了 DDL，
    // 数据订正要自己写成幂等的（WHERE 上加条件，别裸 UPDATE）
    await conn.query(
      'INSERT INTO `ap_schema_migration` (`version`, `duration_ms`) VALUES (?, ?)',
      [migration.version, Date.now() - startedAt],
    )
    applied.push(migration.version)
    logger.info?.('已执行表结构迁移', { version: migration.version, ms: Date.now() - startedAt })
  }

  // 3. 核对
  const [[dbRow]] = await conn.query('SELECT DATABASE() AS db')
  if (dbRow?.db) await verifyColumns(conn, declared, dbRow.db, logger)

  logger.info?.('MySQL 表结构已就绪', {
    statements: executed,
    migrations: `${done.size + applied.length}/${migrations.length}`,
    ...(applied.length ? { applied } : {}),
  })
  return executed
}

/**
 * 建连接池。
 *
 * `mysql2` 是**可选依赖**：文件驱动的部署不该被迫装它，也不该因为它装不上而
 * 起不来。所以在这里按需 import，并把失败翻译成一句能直接照做的话。
 */
export async function createPool({ config, logger = console }) {
  let mysql
  try {
    mysql = await import('mysql2/promise')
  } catch {
    throw new Error('STORAGE_DRIVER=mysql 需要可选依赖 mysql2：npm i mysql2')
  }

  const settings = config.mysql
  const pool = mysql.createPool({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    connectionLimit: settings.connectionLimit,
    charset: 'utf8mb4',
    // 统一 UTC 进出。不设的话，写入按服务器时区、读出按 UTC 解释，
    // 相对时间会显示成"3 小时后"这种未来时刻
    timezone: 'Z',
    // 连接断了自动重连由池负责；这里只保证拿到的连接是活的
    enableKeepAlive: true,
  })

  // 立刻探一次。不探的话，配错密码的表现是"启动成功，第一次对话时报错"，
  // 而那条报错出现在用户面前，不是在部署日志里
  try {
    const conn = await pool.getConnection()
    conn.release()
  } catch (error) {
    await pool.end().catch(() => {})
    throw new Error(
      `连不上 MySQL（${settings.user}@${settings.host}:${settings.port}/${settings.database}）：${error.message}`,
    )
  }
  logger.info?.('MySQL 连接池已建立', {
    host: settings.host, port: settings.port, database: settings.database, connectionLimit: settings.connectionLimit,
  })
  return pool
}
