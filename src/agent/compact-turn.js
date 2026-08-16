/**
 * 手动压缩一条会话的上下文。
 *
 * ── 为什么它不是 runTurn 的一个分支 ─────────────────────────────────────
 *
 * runTurn 那五百行里，绝大部分是在为"模型要动手做事"做准备：沙盒租约、技能
 * 物化、工作区铺设与回写、工具装配、驻留策略。压缩**一件都不需要** ——
 * 它只是拿会话正文去调一次模型、换回一段摘要。塞进 runTurn 就得让每一段
 * 都长出一个 `if (compactOnly)`，而那些分支平时一次都不会走到（也就没人测过）。
 *
 * 所以这里重走一遍会话水合与回写，但**刻意不碰沙盒**：
 *   - 不申请租约（压缩不执行任何命令）
 *   - 不铺工作区、不回写（一个字都没改）
 *   - 不装配任何工具（`noTools: 'builtin'` + 不给 customTools）
 *
 * 隔离契约里与它相关的那几条照旧：凭据只进内存（#1）、会话只按 username
 * 水合与回写（#4）、finally 必须 dispose（#5）、临时目录一 run 一套并删掉（#3）。
 *
 * ── 一件必须说在前面的事：这会花钱 ──────────────────────────────────────
 *
 * 压缩要**另外调一次模型**写摘要，token 和一次正常对话同量级（它要把整段会话读一遍）。
 * 而 pi 那次调用走的是 `completeSimple`，用量不经过 session 的事件流 ——
 * 也就是说**这笔消耗记不进 `ap_usage`**（自动压缩同理，见 telemetry/pricing.js
 * 文件头第 3 条）。额度闸门仍然照常先问一次：记不下来不等于可以不管，
 * 一个额度已经烧光的账号不该还能靠压缩接着花钱。
 */
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  SessionManager,
  DefaultResourceLoader,
  createAgentSession,
} from '@mariozechner/pi-coding-agent'

import { Errors, toAppError } from '../errors.js'

/**
 * pi 抛出来的两句话要翻译，而且要翻译成**能指导下一步动作**的话。
 *
 * 原文是 "Already compacted" 和 "Nothing to compact (session too small)"，
 * 直接抛给用户的话，界面上是一句英文报错，看起来像是坏了 —— 而这两种情况
 * 都不是错误，是"没什么可做的"。
 */
const PI_MESSAGES = [
  [/already compacted/i, '这条会话刚压缩过，还没有新的对话可以再压。'],
  [/nothing to compact|too small/i, '这条会话还不够长，没有可以折叠的内容 —— 压缩要留下最近的对话，再往前才有得压。'],
]

function translate(message) {
  const text = String(message || '')
  for (const [pattern, chinese] of PI_MESSAGES) {
    if (pattern.test(text)) return chinese
  }
  return ''
}

/**
 * @param {object} params
 * @param {string} params.username        服务端校验过的用户标识
 * @param {string} params.sessionKey
 * @param {object} params.model           pi Model（由 model-factory 构造）
 * @param {string} params.apiKey          该用户的模型调用凭据，只在本次内存里
 * @param {object} params.store           SessionStore
 * @param {string} [params.instructions]  给摘要的额外侧重（"重点保留接口约定"）
 * @param {object} [params.compaction]    { reserveTokens, keepRecentTokens }
 * @returns {Promise<{tokensBefore: number, entryCount: number, sessionId: string}>}
 */
export async function compactSession({
  username,
  sessionKey = 'main',
  model,
  apiKey = '',
  thinkingLevel = 'medium',
  store,
  instructions = '',
  compaction = {},
  logger = console,
}) {
  if (!username) throw Errors.internal('compactSession 缺少 username —— 隔离契约 #4')
  if (!model) throw Errors.internal('compactSession 缺少 model')

  const saved = await store.load({ username, sessionKey })
  /**
   * 空会话直接挡在这里，不必为它铺一整套临时目录再让 pi 抛一句英文。
   * 它也是最常见的一次误触（新开一条会话就点了压缩）。
   */
  if (!saved?.jsonl) throw Errors.badRequest('这条会话还没有内容可以压缩。')

  const workRoot = await mkdtemp(path.join(tmpdir(), `ap-compact-${Date.now().toString(36)}-`))
  const cwd = path.join(workRoot, 'workspace')
  const agentDir = path.join(workRoot, 'agent')
  const sessionDir = path.join(workRoot, 'sessions')
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ])

  let session = null
  try {
    const sessionFile = path.join(sessionDir, `${saved.sessionId || 'session'}.jsonl`)
    await writeFile(sessionFile, saved.jsonl, 'utf8')
    const sessionManager = SessionManager.open(sessionFile, sessionDir, cwd)

    // 凭据只在内存，只属于这一次（隔离契约 #1）
    const authStorage = AuthStorage.inMemory()
    authStorage.setRuntimeApiKey(model.provider, apiKey || 'unused')
    const settingsManager = SettingsManager.inMemory({
      /**
       * 只给两个尺寸，**不给 `enabled`**。
       *
       * 那个开关管的是"要不要自动压"，而这里是用户自己点的 —— 手动压缩不该
       * 因为部署把自动压缩关了就跟着失效。两件事共用一个开关的话，
       * "关掉自动压缩"会顺手把用户唯一的补救手段也关掉。
       */
      compaction: {
        ...(compaction.reserveTokens ? { reserveTokens: compaction.reserveTokens } : {}),
        ...(compaction.keepRecentTokens ? { keepRecentTokens: compaction.keepRecentTokens } : {}),
      },
    })

    /**
     * `noSkills: true` 与 runTurn 那边同一个理由：默认 loader 会去扫本机磁盘找技能，
     * 多租户服务里那等于把宿主机上的东西端给模型。压缩用不到技能，但这个默认值
     * 危险到不该依赖"反正也用不上"。
     */
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true })
    await resourceLoader.reload()

    const created = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      settingsManager,
      sessionManager,
      resourceLoader,
      noTools: 'builtin', // ← 不要改。见隔离契约 #2
    })
    session = created.session

    let result
    try {
      result = await session.compact(instructions || undefined)
    } catch (error) {
      const chinese = translate(error?.message)
      if (chinese) throw Errors.badRequest(chinese)
      throw error
    }

    // 回写：只写回这个 username 自己的那一条（隔离契约 #4）
    const jsonl = await readFile(sessionManager.getSessionFile(), 'utf8')
    const entries = sessionManager.getEntries()
    await store.save({
      username,
      sessionKey,
      sessionId: sessionManager.getSessionId(),
      jsonl,
      entryCount: entries.length,
    })

    logger.info?.('会话上下文已压缩', {
      username, sessionKey, tokensBefore: result?.tokensBefore || 0, entryCount: entries.length,
    })
    return {
      tokensBefore: Number(result?.tokensBefore) || 0,
      entryCount: entries.length,
      sessionId: sessionManager.getSessionId(),
    }
  } catch (error) {
    throw toAppError(error)
  } finally {
    try {
      session?.dispose()
    } catch (error) {
      logger.warn?.('compact session.dispose 失败', { username, sessionKey, err: error?.message })
    }
    await rm(workRoot, { recursive: true, force: true }).catch((error) => {
      logger.error?.('压缩临时目录清理失败 —— 可能残留用户数据', { workRoot, err: error?.message })
    })
  }
}
