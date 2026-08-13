/**
 * MySQL 连接与建表。
 *
 * ── 一个进程一个池 ──────────────────────────────────────────────────────
 *
 * 会话、项目、记忆、作品、分享、账号全走同一个连接池。各建各的池会让
 * `connectionLimit` 变成一个没人算得清的数字：配 10，实际是 6 个池各 10 条，
 * 而 MySQL 那边 `max_connections` 是按连接算的，多副本一乘就把数据库打满。
 *
 * ── 建表在启动时做 ──────────────────────────────────────────────────────
 *
 * 全部 `CREATE TABLE IF NOT EXISTS`，可以反复跑。这样 `docker compose up` 一条
 * 命令就能起来，不必先手工导表 —— 而"忘了导表"的表现是一堆 ER_NO_SUCH_TABLE，
 * 报错指向某一次业务操作，跟"少跑了一步部署命令"看不出关系。
 *
 * schema.sql 仍然是**唯一的真相**：这里只是把它读出来执行，不在 JS 里另写一份
 * DDL。两份 DDL 迟早只改一份，而那种不一致要等到新环境建表时才暴露。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 会话表的 DDL 早于本模块存在，一并建，免得两处各管一半 */
const SCHEMA_FILES = [
  path.join(__dirname, 'schema.sql'),
  path.join(__dirname, '..', 'sessions', 'schema.sql'),
]

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
 * 建表。可反复执行。
 *
 * 1060（Duplicate column）与 1061（Duplicate key）一律忽略：老实例上补列的
 * ALTER 会撞这两个错，而那正是"已经补过了"的意思。别的错误照抛 —— 尤其是
 * 权限不足（1142），那必须让部署当场失败，而不是等第一次写业务数据时才炸。
 */
export async function ensureSchema(pool, logger = console) {
  let created = 0
  for (const file of SCHEMA_FILES) {
    const sql = await readFile(file, 'utf8')
    for (const statement of splitStatements(sql)) {
      try {
        await pool.query(statement)
        created += 1
      } catch (error) {
        if (error?.errno === 1060 || error?.errno === 1061) continue
        const head = statement.slice(0, 80).replace(/\s+/g, ' ')
        throw new Error(`建表失败（${error.code || error.errno}）：${head}… —— ${error.message}`)
      }
    }
  }
  logger.info?.('MySQL 表结构已就绪', { statements: created })
  return created
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
