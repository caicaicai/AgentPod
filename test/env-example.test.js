/**
 * `.env.example` 是**唯一一份配置清单**，这一组用例负责让它保持是唯一的那一份。
 *
 * ── 为什么需要这个 ──────────────────────────────────────────────────────
 *
 * 从前还有一个 `.env.dev.template`：一份给部署、一份给本地开发，各列一半。
 * 两份清单没有任何东西互相提醒，于是它们漂了 —— `SANDBOX_PARK`、
 * `REQUEST_BODY_LIMIT_CHAT_BYTES`、`LLM_DIRECT_CONTEXT_WINDOW`、
 * `LLM_DIRECT_MAX_TOKENS` 四个开关**只存在于 dev 那一份里**，而 `.env.example`
 * 开头明明写着"全量配置项"。只看它的人不会知道有这些开关，
 * 而且没有任何征兆：服务照常启动，只是那几个开关他一辈子都不会用到。
 *
 * 两份清单已经合成一份了。留下的风险变成另一个方向：**加了配置项却忘了写进
 * .env.example**。它同样不会有任何征兆，所以在这里挡住。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────
 *
 * config.js 里每一个 `env.XXX` 的读取点，都要在 .env.example 里出现过 ——
 * 生效的一行也好、注释掉的示例也好、正文里提一句也好，只要搜得到就算数。
 * 这里要的不是"格式正确"，是"这个开关在文档里存在"。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configSource = readFileSync(path.join(ROOT, 'src/config.js'), 'utf8')
const envExample = readFileSync(path.join(ROOT, '.env.example'), 'utf8')

/**
 * config.js 读到的环境变量名。
 *
 * 只认 `env.XXX` 这一种写法（全大写 + 下划线）——那正是这个文件里读配置的唯一形式。
 * 顺带把 loadDotEnv 自己用的那两个排除掉：它们是**读配置的机制本身**，
 * 不是"这个服务有哪些开关"。
 */
const MECHANISM_KEYS = new Set(['ENV_FILE'])

function readKeys(source) {
  const found = new Set()
  for (const match of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) {
    if (!MECHANISM_KEYS.has(match[1])) found.add(match[1])
  }
  return [...found].sort()
}

describe('.env.example 是唯一且完整的配置清单', () => {
  test('config.js 读的每一个环境变量都写进了 .env.example', () => {
    const missing = readKeys(configSource).filter((key) => !envExample.includes(key))
    assert.deepEqual(
      missing,
      [],
      `这些配置项 config.js 会读，但 .env.example 里一个字都没提 —— `
      + `加开关时请一并补上说明（默认值是什么、配错会怎样）：\n  ${missing.join('\n  ')}`,
    )
  })

  /**
   * ENV_FILE 是那条"从别处读配置"的机制，它自己也得写在文档里 ——
   * 上面那个集合把它排除在自动扫描之外，所以单独断言一次，
   * 免得哪天有人顺手把它从文档里删掉。
   */
  test('读配置的机制本身也在文档里', () => {
    assert.ok(envExample.includes('ENV_FILE'), '.env.example 里应当说明 ENV_FILE 怎么用')
  })

  /**
   * 合并之后不该再冒出第二份清单。**这一条是防回归的** ——
   * 上面那个用例只保证 .env.example 是完整的，管不住有人再加一份
   * `.env.<something>.template` 然后两边又开始漂。
   */
  test('仓库里不该再有第二份 env 模板', async () => {
    const { readdir } = await import('node:fs/promises')
    const strays = (await readdir(ROOT)).filter(
      (name) => /^\.env\..*(template|example)$/.test(name) && name !== '.env.example',
    )
    assert.deepEqual(strays, [], `多出来的 env 模板会与 .env.example 漂移：${strays.join(', ')}`)
  })
})
