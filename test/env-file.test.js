/**
 * 用文件配置环境变量（容器里挂配置的那条路）。
 *
 * 这些行为的共同点是**配错了不报错、只是值不对**，所以每条都得钉住。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'

/** 每个用例一个干净目录，互不影响 */
function withDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ap-envfile-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 最小的**可用**配置。
 *
 * 这组用例测的是"文件里的值有没有被读进来"，所以夹具本身必须先过 validate() ——
 * 过不去的话，每条用例都会在读到那个值之前就抛，而报错说的是
 * "CONSOLE_USERS 没配"，跟被测的东西一点关系都没有。
 *
 * 于是这里必须显式给出 AUTH_MODE / LLM_MODE：两者的**默认值**分别是
 * password 和 platform，各自还要求 CONSOLE_USERS 和 SPEED_API_BASE。
 * dev + faux 是最省事的一对，而且与这组用例要测的东西完全无关。
 */
const BASE = { SANDBOX_MODE: 'none', AUTH_MODE: 'dev', LLM_MODE: 'faux', MYSQL_HOST: 'db.example', MYSQL_USER: 'ap', MYSQL_DATABASE: 'ap' }

describe('从文件读配置', () => {
  test('默认读 <cwd>/.env', () => {
    withDir((dir) => {
      writeFileSync(path.join(dir, '.env'), 'MAX_CONCURRENT_RUNS=33\nLOG_LEVEL=debug\n')
      const config = loadConfig({ cwd: dir, env: { ...BASE } })
      assert.equal(config.limits.maxConcurrentRuns, 33)
      assert.equal(config.logLevel, 'debug')
      assert.equal(config.envFile.path, path.join(dir, '.env'))
      assert.equal(config.envFile.keys, 2)
    })
  })

  test('ENV_FILE 指到别处 —— 容器里挂配置靠的就是它', () => {
    // 容器中把配置挂到应用目录之外（如 /etc/ap/agent.env），避免耦合。
    withDir((dir) => {
      const file = path.join(dir, 'agent.env')
      writeFileSync(file, 'MAX_CONCURRENT_RUNS=7\n')
      const config = loadConfig({ cwd: '/nonexistent', env: { ...BASE, ENV_FILE: file } })
      assert.equal(config.limits.maxConcurrentRuns, 7)
      assert.equal(config.envFile.path, file)
    })
  })

  test('ENV_FILE 指到一个不存在的文件 → 直接拒绝启动', () => {
    // 静默跳过的话现象是"所有配置都退回默认值"，而默认值在生产上会被死线拦下，
    // 报出来的是一堆看不出根因的校验错误 —— 真正的原因（路径写错/忘了挂）一个字都没提。
    assert.throws(
      () => loadConfig({ cwd: os.tmpdir(), env: { ...BASE, ENV_FILE: '/nope/agent.env' } }),
      (error) => {
        assert.equal(error.code, 'CONFIG_INVALID')
        assert.match(error.message, /ENV_FILE/)
        return true
      },
    )
  })

  test('没有 .env 是正常情况，不报错', () => {
    withDir((dir) => {
      const config = loadConfig({ cwd: dir, env: { ...BASE } })
      assert.equal(config.envFile.path, '')
      assert.equal(config.envFile.keys, 0)
    })
  })

  test('**真实环境变量优先于文件**', () => {
    // 反过来的话，"我在平台控制台改了却不生效"会是一个极难查的问题。
    withDir((dir) => {
      writeFileSync(path.join(dir, '.env'), 'LOG_LEVEL=debug\nMAX_CONCURRENT_RUNS=33\n')
      const config = loadConfig({ cwd: dir, env: { ...BASE, LOG_LEVEL: 'warn' } })
      assert.equal(config.logLevel, 'warn', '环境变量被文件覆盖了')
      assert.equal(config.limits.maxConcurrentRuns, 33, '环境变量里没有的那项应该还是从文件读')
    })
  })

  test('值两侧的引号要去掉，单双引号都算', () => {
    // `SPEED_API_BASE="http://x"` 不去引号的话会拼出 `"http://x"/v1/...` 这种地址，
    // 而写引号是从 shell 带过来的肌肉记忆，报错完全指不到引号上。
    //
    // （原来用的是 SSO_RETURN_BASE。SSO 那套登录已经不在了 —— 现在只有
    // password|dev，见 src/identity/index.js。换个还在的键，测的东西不变。）
    withDir((dir) => {
      writeFileSync(path.join(dir, '.env'), 'SPEED_API_BASE="http://speed.example/api"\nPLATFORM_REFERER=\'http://portal.example/\'\n')
      const config = loadConfig({ cwd: dir, env: { ...BASE } })
      assert.equal(config.platform.speedApiBase, 'http://speed.example/api')
      assert.equal(config.platform.referer, 'http://portal.example/')
    })
  })

  test('认 `export FOO=bar`', () => {
    // 从 shell 片段复制过来常常带着 export。不认的话会解析出一个名叫
    // `export LOG_LEVEL` 的变量，静默地什么都不生效。
    withDir((dir) => {
      writeFileSync(path.join(dir, '.env'), 'export LOG_LEVEL=debug\n')
      assert.equal(loadConfig({ cwd: dir, env: { ...BASE } }).logLevel, 'debug')
    })
  })

  test('注释和空行跳过，逗号分隔的值切开，值里的 = 保留', () => {
    // 载体从 BRIDGE_ALLOW_HOSTS 换成了 ARTIFACT_ALLOWED_ORIGINS：Cloud Bridge
    // 已经不在这个服务里了（见 src/tools/http.js 开头），而这条用例真正要钉的是
    // 解析器的三个行为，跟具体哪个键无关。
    withDir((dir) => {
      writeFileSync(
        path.join(dir, '.env'),
        '# 注释\n\nARTIFACT_ALLOWED_ORIGINS=https://cdn.example.com,https://esm.example.com\nMYSQL_PASSWORD=a=b=c\n',
      )
      const config = loadConfig({ cwd: dir, env: { ...BASE, SESSION_STORE: 'mysql', MYSQL_HOST: 'h', MYSQL_USER: 'u', MYSQL_DATABASE: 'd' } })
      assert.deepEqual(config.artifacts.allowedOrigins, ['https://cdn.example.com', 'https://esm.example.com'])
      assert.equal(config.mysql.password, 'a=b=c', '值里的等号被截断了')
    })
  })

  test('启动日志用的那份摘要**不含任何值**', () => {
    // 这个文件里躺着 SANDBOX_MANAGER_CODE / MYSQL_PASSWORD
    withDir((dir) => {
      writeFileSync(path.join(dir, '.env'), 'MYSQL_PASSWORD=super-secret-value\n')
      const config = loadConfig({ cwd: dir, env: { ...BASE } })
      assert.equal(JSON.stringify(config.envFile).includes('super-secret-value'), false)
      assert.equal(config.envFile.keys, 1)
    })
  })
})
