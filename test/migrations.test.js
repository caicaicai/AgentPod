/**
 * 表结构迁移。
 *
 * ── 这一组要守住的是什么 ────────────────────────────────────────────────
 *
 * 这套东西真正的价值不在"能把 ALTER 跑起来"，而在**两种写漏都不会安静过去**：
 *
 *   漏了 migration    老库缺列，而新库一切正常 —— 所以本地测不出来，
 *                     要等上线后有人点到那个功能才炸
 *   漏了 schema.sql   新库照样是对的（migration 会替它补上），坏的是
 *                     schema.sql 从此不再可信，而它是所有人查表结构时看的那份
 *
 * 第一种由启动时的核对兜住（`verifyColumns`，缺列就拒绝启动）；
 * 第二种由本文件最后那条一致性检查兜住 —— 它是纯静态的，不需要数据库。
 *
 * 另外还有一条不能松的：**迁移必须能重跑**。记账在整个文件跑完之后才落，
 * 中途抛了下次启动会从头再来一遍。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { splitStatements, parseDeclaredColumns, loadMigrations, ensureSchema } from '../src/persistence/mysql.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = path.join(ROOT, 'src', 'persistence', 'migrations')
const SCHEMA_FILES = [
  path.join(ROOT, 'src', 'persistence', 'schema.sql'),
  path.join(ROOT, 'src', 'sessions', 'schema.sql'),
]

/**
 * 假连接池。记下每一条被执行的语句，并按脚本让指定的语句报指定的错。
 *
 * 用假的而不是起一个真 MySQL：这里要断言的是**顺序与决策**（先建表还是先迁移、
 * 撞了 1060 算不算成功、失败之后落不落账），那些与真数据库无关。
 */
function fakePool({ done = [], fail = null } = {}) {
  const queries = []
  const conn = {
    async query(sql, params) {
      queries.push({ sql, params })
      if (fail && fail.match.test(sql)) {
        const error = new Error(fail.message || 'boom')
        error.errno = fail.errno
        throw error
      }
      if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]]
      if (/SELECT DATABASE/.test(sql)) return [[{ db: 'agentpod' }]]
      if (/FROM `ap_schema_migration`/.test(sql)) return [done.map((version) => ({ version }))]
      if (/information_schema/.test(sql)) return [conn.columns || []]
      return [[]]
    },
    release() {},
    columns: null,
  }
  return {
    queries,
    conn,
    async getConnection() { return conn },
    query: (...args) => conn.query(...args),
    /** 让 information_schema 那一问回答"库里有这些列" */
    setColumns(rows) { conn.columns = rows },
  }
}

/** 把 schema 文件里声明的列，摆成 information_schema 会返回的形状 */
async function declaredAsRows() {
  const rows = []
  for (const file of SCHEMA_FILES) {
    for (const [table, columns] of parseDeclaredColumns(await readFile(file, 'utf8'))) {
      for (const column of columns) rows.push({ TABLE_NAME: table, COLUMN_NAME: column })
    }
  }
  return rows
}

describe('迁移文件', () => {
  test('文件名是零填充编号 —— 执行顺序就是字典序，不补零的话 10 会排在 2 前面', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql'))
    for (const name of files) {
      assert.match(name, /^\d{4}-[a-z0-9-]+\.sql$/, `${name} 不符合 NNNN-描述.sql`)
    }
  })

  test('编号不重复 —— 撞号的两个文件谁先跑取决于剩下那半截文件名，等于没有顺序', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql'))
    const numbers = files.map((name) => name.slice(0, 4))
    assert.equal(new Set(numbers).size, numbers.length, `编号重复：${numbers.join()}`)
  })

  test('按顺序读出来，version 不带扩展名', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR)
    assert.ok(migrations.length >= 1)
    const versions = migrations.map((migration) => migration.version)
    assert.deepEqual(versions, [...versions].sort())
    assert.equal(versions[0], '0001-session-project-pin-archive')
  })

  test('目录不存在不算错 —— 一个还没有任何迁移的仓库是正常状态', async () => {
    assert.deepEqual(await loadMigrations(path.join(ROOT, '不存在的目录')), [])
  })

  /**
   * 老表里已经有行了。`NOT NULL` 而没有 `DEFAULT` 的新列会让 ALTER 直接失败，
   * 而失败的时机是**部署时**，不是写这个文件的时候。
   */
  test('新增的 NOT NULL 列都带默认值', async () => {
    for (const migration of await loadMigrations(MIGRATIONS_DIR)) {
      for (const statement of migration.statements) {
        if (!/ADD COLUMN/i.test(statement) || !/NOT NULL/i.test(statement)) continue
        assert.match(statement, /DEFAULT/i, `${migration.version}：NOT NULL 新列没有 DEFAULT —— ${statement}`)
      }
    }
  })

  /**
   * 部署失败会自动回滚代码，但**不会回滚已经执行的迁移**。
   * 回滚到的上一版代码得能在新表结构上继续跑，所以不允许删列/改名。
   */
  test('不删列、不改名 —— 代码能回滚，迁移不能', async () => {
    for (const migration of await loadMigrations(MIGRATIONS_DIR)) {
      for (const statement of migration.statements) {
        assert.doesNotMatch(statement, /DROP COLUMN/i, `${migration.version} 删了列`)
        assert.doesNotMatch(statement, /RENAME COLUMN|CHANGE COLUMN/i, `${migration.version} 改了列名`)
        assert.doesNotMatch(statement, /DROP TABLE/i, `${migration.version} 删了表`)
      }
    }
  })
})

describe('执行', () => {
  test('先建表再迁移 —— 反过来的话，新库上迁移会去改一张还不存在的表', async () => {
    const pool = fakePool()
    pool.setColumns(await declaredAsRows())
    await ensureSchema(pool, {})
    const sqls = pool.queries.map((query) => query.sql)
    const firstCreate = sqls.findIndex((sql) => /CREATE TABLE/.test(sql))
    const firstAlter = sqls.findIndex((sql) => /ALTER TABLE/.test(sql))
    assert.ok(firstCreate >= 0 && firstAlter > firstCreate)
  })

  test('跑过的不再跑', async () => {
    const pool = fakePool({ done: ['0001-session-project-pin-archive'] })
    pool.setColumns(await declaredAsRows())
    await ensureSchema(pool, {})
    assert.equal(pool.queries.some((query) => /ALTER TABLE/.test(query.sql)), false)
  })

  test('跑完落一条账', async () => {
    const pool = fakePool()
    pool.setColumns(await declaredAsRows())
    await ensureSchema(pool, {})
    const ledger = pool.queries.filter((query) => /INSERT INTO `ap_schema_migration`/.test(query.sql))
    assert.equal(ledger.length, 1)
    assert.equal(ledger[0].params[0], '0001-session-project-pin-archive')
  })

  /** 新库必然撞这个：schema.sql 已经把列建好了，迁移再加一次 */
  test('列已存在（1060）当成功 —— 新库上每个迁移都会撞它', async () => {
    const pool = fakePool({ fail: { match: /ADD COLUMN/, errno: 1060, message: 'Duplicate column name' } })
    pool.setColumns(await declaredAsRows())
    await ensureSchema(pool, {})
    assert.equal(pool.queries.some((query) => /INSERT INTO `ap_schema_migration`/.test(query.sql)), true)
  })

  /**
   * 权限不足必须让部署当场失败。把它一起吞掉的话，服务会正常起来，
   * 然后在第一次写业务数据时报错 —— 那条报错出现在用户面前，不在部署日志里。
   */
  test('权限不足（1142）照抛，不当成"已经是目标状态"', async () => {
    const pool = fakePool({ fail: { match: /ALTER TABLE/, errno: 1142, message: 'ALTER command denied' } })
    await assert.rejects(() => ensureSchema(pool, {}), /1142|ALTER command denied/)
  })

  test('迁移中途失败不落账 —— 下次启动会从头再跑一遍这一个', async () => {
    const pool = fakePool({ fail: { match: /ADD KEY/, errno: 1142, message: 'denied' } })
    await assert.rejects(() => ensureSchema(pool, {}))
    assert.equal(pool.queries.some((query) => /INSERT INTO `ap_schema_migration`/.test(query.sql)), false)
  })

  test('拿不到锁就别硬上 —— 两个副本同时 ALTER 同一张表', async () => {
    const pool = fakePool()
    pool.conn.query = async (sql) => {
      if (/GET_LOCK/.test(sql)) return [[{ ok: 0 }]]
      return [[]]
    }
    await assert.rejects(() => ensureSchema(pool, {}), /表结构锁/)
  })

  test('缺列就拒绝启动，并且报错里点名缺的是哪一列', async () => {
    const pool = fakePool()
    const rows = await declaredAsRows()
    pool.setColumns(rows.filter((row) => !(row.TABLE_NAME === 'ap_cloud_session' && row.COLUMN_NAME === 'pinned')))
    await assert.rejects(() => ensureSchema(pool, {}), /ap_cloud_session\.pinned/)
  })

  /** 库里多出来的列不管：可能是还没清理的旧列，不构成这次部署跑不起来的理由 */
  test('库里多出来的列不管', async () => {
    const pool = fakePool()
    pool.setColumns([...(await declaredAsRows()), { TABLE_NAME: 'ap_kv', COLUMN_NAME: '祖传字段' }])
    await ensureSchema(pool, {})
  })
})

describe('列声明的解析', () => {
  test('读出列名，不把 KEY / PRIMARY KEY 那几行当成列', () => {
    const tables = parseDeclaredColumns(`
CREATE TABLE IF NOT EXISTS \`t\` (
  \`a\` VARCHAR(8) NOT NULL,
  \`b\` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (\`a\`),
  KEY \`idx\` (\`b\`),
  UNIQUE KEY \`uk\` (\`a\`, \`b\`)
) ENGINE=InnoDB;`)
    assert.deepEqual([...tables.get('t')], ['a', 'b'])
  })

  test('两张表分开算', () => {
    const tables = parseDeclaredColumns(`
CREATE TABLE \`x\` (
  \`p\` INT NOT NULL
);
CREATE TABLE \`y\` (
  \`q\` INT NOT NULL
);`)
    assert.deepEqual([...tables.keys()], ['x', 'y'])
  })
})

describe('schema.sql 与迁移不许脱节', () => {
  /**
   * 这条守的是第二种写漏：**只写了迁移、没改 schema.sql**。
   *
   * 那样新库仍然是对的（迁移会替它补上列），所以任何运行时检查都发现不了 ——
   * 坏掉的是 schema.sql 的可信度，而它是所有人查"这张表有哪些列"时看的那一份。
   * 只能静态查。
   */
  test('迁移里加的每一列，schema.sql 里都得有', async () => {
    const declared = new Map()
    for (const file of SCHEMA_FILES) {
      for (const [table, columns] of parseDeclaredColumns(await readFile(file, 'utf8'))) {
        declared.set(table, columns)
      }
    }

    const missing = []
    for (const migration of await loadMigrations(MIGRATIONS_DIR)) {
      for (const statement of migration.statements) {
        const match = statement.match(/ALTER TABLE\s+`([^`]+)`\s+ADD COLUMN\s+`([^`]+)`/i)
        if (!match) continue
        const [, table, column] = match
        if (!declared.get(table)?.has(column)) missing.push(`${migration.version}: ${table}.${column}`)
      }
    }
    assert.deepEqual(missing, [], `迁移加了列但 schema.sql 里没有 —— 新库建出来会缺这些列：\n${missing.join('\n')}`)
  })

  test('迁移文件里没有被注释掉的 ALTER —— 建表时注释行会被整行滤掉', async () => {
    for (const name of (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql'))) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8')
      for (const line of sql.split('\n')) {
        assert.doesNotMatch(line.trim(), /^--\s*ALTER TABLE/i,
          `${name} 里有一条被注释掉的 ALTER —— 它永远不会执行，只是看起来像迁移`)
      }
    }
  })

  test('schema 文件里也没有 —— 从前那三条补列就是这么躺了很久没人执行', async () => {
    for (const file of SCHEMA_FILES) {
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        assert.doesNotMatch(line.trim(), /^--\s*ALTER TABLE/i,
          `${path.basename(file)} 里有被注释掉的 ALTER —— 改表要放 migrations/`)
      }
    }
  })

  test('splitStatements 确实会滤掉注释行（上面两条检查的前提）', () => {
    const statements = splitStatements('-- ALTER TABLE `t` ADD COLUMN `c` INT;\nSELECT 1;')
    assert.deepEqual(statements, ['SELECT 1'])
  })
})
