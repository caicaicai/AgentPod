/**
 * 单轮执行核心：无状态、每次一个 AgentSession、跑完即销毁。
 *
 * ⚠️ 改这个文件前先读 docs/ISOLATION-CONTRACT.md。下面每一条都是多租户安全的硬要求：
 *
 *  1. 凭据只走 AuthStorage.inMemory()，**绝不进 process.env**（并发用户会互相覆盖）
 *  2. pi 内置本地执行工具全关（noTools:'builtin'），执行一律下沉沙盒
 *  3. 每 run 一套独立临时目录（cwd/agentDir/sessionDir），finally 删除
 *  4. 会话只从 store 按 username 水合、按 username 回写
 *  5. finally 必须 session.dispose()
 *  6. 移植进来的工具禁止模块级凭据缓存
 *  7. 沙盒/技能只拿 run 级短票据，拿不到长期凭据
 *
 * scripts/check-isolation-rules.js 会静态检查其中几条；test/isolation.test.js 做运行时回归。
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
import { buildPromptContent, describeAttachments } from './attachments.js'
import { buildTools } from './tools.js'
import { SANDBOX_WORKSPACE_ROOT } from './sandbox-files.js'
import { installRetryPolicy, compilePatterns } from '../models/retry.js'
import { toSandboxSkills, attachSkillMaterialization } from './skill-materializer.js'
import { createFrameEncoder, extractFinalText, extractUsage } from './events.js'
import { deriveTitle, parseTranscript } from '../sessions/transcript.js'

/**
 * 纠正系统提示里那行会把模型带沟里的 `Current working directory`。
 *
 * ── 这条是从一次真实会话里挖出来的 ──────────────────────────────────
 *
 * pi 的 buildSystemPrompt 在提示**末尾**（最显眼的位置）追加：
 *
 *     Current working directory: /var/folders/w9/.../ap-run-xxx/workspace
 *
 * 那是 agent 侧 mkdtemp 出来的临时目录，**沙盒里根本不存在**。模型照着它办事：
 * `write` 到该绝对路径（pi 原样回显，看着成功了），然后 `bash` 里 `cd` 过去 ——
 * `No such file or directory`。接着它 `pwd` 拿到 `/sandbox-root/work`，改用这个真路径，
 * 又被我们的 toWorkspaceRelative 拒掉。一来一回烧掉 5 次工具调用，
 * 而模型全程没做错任何事。
 *
 * 所以这里必须**点名否掉那一行**，光说"请用相对路径"不够：两条信息并存时，
 * 一个具体的绝对路径比一句泛泛的建议更像事实。
 */
function workspacePrompt() {
  return [
    '## 沙盒工作区',
    '',
    '命令和文件都落在**沙盒**里，不在本进程。',
    `提示末尾那行 \`Current working directory\` 是 agent 侧的路径，**沙盒里不存在** ——`,
    '不要 cd 过去，也不要拿它拼绝对路径。',
    '',
    `- 工作区根在沙盒里是 \`${SANDBOX_WORKSPACE_ROOT}\`，\`bash\` 一启动就在那儿`,
    '- `write` / `read` / `edit` 的 `path` 直接用**相对路径**（`fetch_users.py`、`out/data.json`）',
    '- 三个文件工具和 `bash` 看到的是同一个目录：`write` 写出来的文件，`bash` 里 `ls` 就能看见',
  ].join('\n')
}

/**
 * 告诉模型这一轮的沙盒**是不是上一轮那一个**。
 *
 * ── 为什么这段提示是必需的，而不是锦上添花 ──────────────────────────
 *
 * 沙盒默认是"一轮一个"，模型的先验就是这个。接管成功却不说，它会照着
 * "全新沙盒"的假设重新登录、重装依赖 —— 驻留付出的槽位代价全白花，用户看到的
 * 还是每轮从头再来。
 *
 * 反过来更糟：上一轮驻留过、这一轮没接上（超时/被抢占/节点重启），不说的话
 * 模型会去点一个已经不存在的页面，然后开始解释一个不存在的现象。
 * `markSignalKill` 那条注释记着同一类事故的代价：76 次工具调用、302 秒，
 * 只因为一个事实被我们藏起来了。
 */
function continuityPrompt({ attached, browser, lost, maxRemainingMs }) {
  if (attached) {
    const lines = [
      '## 沙盒延续',
      '',
      '**这一轮用的是上一轮那个沙盒**（不是新的）：工作区文件、已安装的依赖、',
      '后台进程都还在，不需要重装、重下、重建。',
    ]
    if (browser) {
      lines.push(
        '',
        '浏览器上下文也还开着，**登录态有效** —— 直接接着上一轮的页面继续操作，',
        '不要从登录页重来。要确认当前在哪个页面，先做一次 snapshot。',
      )
    }
    // 撞硬顶时沙盒会被强制回收。让模型自己权衡"现在还够不够开一个长任务"，
    // 比让它做到一半被打断强。
    const minutes = Math.floor((maxRemainingMs || 0) / 60000)
    if (minutes > 0) lines.push('', `这个沙盒最多还能保持 ${minutes} 分钟，之后会被回收并重建。`)
    return lines.join('\n')
  }

  if (lost) {
    return [
      '## 沙盒已重建',
      '',
      '上一轮的沙盒已被回收，**这一轮是全新的**：浏览器登录态、已安装的依赖、',
      '后台进程都没有了，需要用到就重新建立。工作区里的文件已经恢复。',
    ].join('\n')
  }
  return ''
}

/**
 * 从刚写完的会话里取最后一轮的「耗时 / 工具调用次数」。
 *
 * 走的就是历史那条路（parseTranscript → attachTurnStats），这样刚跑完显示的数字
 * 和刷新之后显示的数字**是同一个算法算出来的**，不会对不上。
 * 拿不到就返回 null —— 界面上不显示，好过显示一个 0。
 */
function lastTurnStats(jsonl) {
  try {
    const { messages } = parseTranscript(jsonl)
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].turnStats) return messages[i].turnStats
    }
  } catch {
    // 统计算不出来不该影响一轮已经成功的对话
  }
  return null
}

/**
 * @param {object} params
 * @param {string} params.runId
 * @param {string} params.username            服务端校验过的用户标识
 * @param {string} params.sessionKey
 * @param {string} params.prompt
 * @param {Array}  [params.attachments]  已经过 normalizeAttachments 校验的用户附件
 * @param {object} params.model          pi Model（由 model-factory 构造）
 * @param {string} params.apiKey         该用户的模型调用凭据，只在本 run 内存里
 * @param {object} params.store          SessionStore
 * @param {object} params.sandbox
 * @param {Array}  [params.skills]      已装载的技能（pi Skill[]），由 run-service 启动时读一次
 * @param {Array}  [params.extraTools]
 * @param {(type: string, data: object) => void} [params.onFrame]
 * @param {(handle: {abort: Function}) => void}  [params.onStart]
 * @param {number} [params.timeoutMs]
 * @param {object} [params.retry]       { enabled, maxRetries, baseDelayMs, extraPatterns }
 * @param {object} [params.logger]
 */
export async function runTurn({
  runId,
  username,
  sessionKey = 'main',
  prompt,
  /** 用户带上来的附件。已由 HTTP 层的 normalizeAttachments 校验过形状与大小 */
  attachments = [],
  model,
  apiKey = '',
  thinkingLevel = 'medium',
  store,
  sandbox,
  skillLibsDir = '',
  /**
   * 要注入沙盒的凭据类环境变量，由 run-service 算好（默认空对象）。
   *
   * 这里刻意收的是**算好的结果**而不是 credential 本身：runTurn 及其下游
   * 从来不该持有整串 Cookie。见 src/agent/sandbox-credentials.js。
   */
  sandboxCredentialEnv = {},
  skills = [],
  workspace = null,
  /**
   * 追加进系统提示的上下文段落（项目指令、长期记忆），由 run-service 算好。
   *
   * 收的是**已经渲染好的字符串数组**而不是 memory/project 对象：runTurn 的职责是
   * 跑一轮，不该知道"记忆是怎么组织的"。这样两者各自演进时互不牵扯，
   * 测试里也能直接塞一段假提示进来看它有没有生效。
   */
  contextPrompts = [],
  /**
   * 这一轮结束后要不要驻留沙盒（见 docs/SANDBOX-LIFECYCLE.md）。
   *
   *   auto   —— 只在这一轮真的用过浏览器时驻留
   *   always —— 占过槽位就驻留（单人调试用）
   *   off    —— 用完即释放（今天的行为）
   *
   * 由 run-service 算好传进来：cron 触发的 run 没有"下一轮"，那边会直接给 off。
   */
  parkPolicy = 'off',
  apTools = [],
  extraTools = [],
  /** 插件注册的 before/after_tool_call 钩子。对**全部**工具生效，见 src/tools/plugin-api.js */
  toolHooks = null,
  onFrame = () => {},
  onStart = () => {},
  // 默认值与 config.js 的 llm.retry 保持一致，这样测试里不传也是同一套行为
  retry = { enabled: true, maxRetries: 3, baseDelayMs: 2000, extraPatterns: [] },
  timeoutMs = 10 * 60 * 1000,
  logger = console,
}) {
  if (!username) throw Errors.internal('runTurn 缺少 username —— 隔离契约 #4')
  // 只带附件、一个字都不写是合理的一轮（"看看这份日志"），所以两者有其一即可
  if (!prompt && !attachments.length) throw Errors.badRequest('prompt 不能为空')
  if (!model) throw Errors.internal('runTurn 缺少 model')

  const startedAt = Date.now()
  // 编译一次，装到 session 上。写坏的正则在这里被跳过并告警，不影响其余特征。
  const retryPatterns = compilePatterns(retry.extraPatterns, logger)
  const workRoot = await mkdtemp(path.join(tmpdir(), `ap-run-${runId}-`))
  const cwd = path.join(workRoot, 'workspace')
  const agentDir = path.join(workRoot, 'agent')
  const sessionDir = path.join(workRoot, 'sessions')
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ])

  let session = null
  let timedOut = false
  const events = []

  // 一次 run 一个沙盒会话。租约是懒申请的（第一次真的执行命令时才占槽位），
  // 但只要申请过就必须在 finally 里收尾。
  // sessionKey 要传进去：驻留下来的沙盒是**按会话**认领的（同一个人的两个会话
  // 各有各的工作区，串了就是串号）。
  const sandboxSession = sandbox?.createSession
    ? sandbox.createSession({ runId, username, sessionKey })
    : sandbox // 兼容测试里直接传入的假沙盒

  try {
    // ---- 1. 会话水合：只读这个 username 自己的那一条 ----
    const saved = await store.load({ username, sessionKey })
    let sessionManager
    if (saved?.jsonl) {
      const sessionFile = path.join(sessionDir, `${saved.sessionId || 'session'}.jsonl`)
      await writeFile(sessionFile, saved.jsonl, 'utf8')
      sessionManager = SessionManager.open(sessionFile, sessionDir, cwd)
    } else {
      sessionManager = SessionManager.create(cwd, sessionDir)
    }

    // ---- 2. 凭据：只在内存，只属于这一个 run（隔离契约 #1）----
    const authStorage = AuthStorage.inMemory()
    authStorage.setRuntimeApiKey(model.provider, apiKey || 'unused')
    const modelRegistry = ModelRegistry.inMemory(authStorage)
    /**
     * 退避重试的次数与间隔。
     *
     * pi 自带这套（默认 3 次 / 2000ms 起步的指数退避），这里只是把它变成可配置的。
     * 重试**发生在 session 内部**：失败的那条助手消息会被摘掉再重发，
     * 已完成的工具调用不会重跑。见 src/models/retry.js 开头。
     */
    const settingsManager = SettingsManager.inMemory({
      retry: {
        enabled: retry.enabled,
        maxRetries: retry.maxRetries,
        baseDelayMs: retry.baseDelayMs,
      },
    })

    // ---- 3. 工具：内置本地执行工具全关，只给沙盒版 + 移植过来的 AP 工具（隔离契约 #2）----
    const runContext = {
      runId, username, skillLibsDir,
      credentialEnv: sandboxCredentialEnv || {},
    }

    /**
     * 没有沙盒就不宣告技能。
     *
     * 技能的正文全是"cd skills/x && bash scripts/run.sh"这类沙盒命令，没有执行端时
     * 一条都跑不了。宣告了只会让模型反复尝试再拿回失败 —— 与 tools/index.js 的
     * 能力闸门同一个道理：宁可它不知道有，也不要它以为有。
     */
    const hasSandbox = Boolean(sandboxSession) && sandboxSession.mode !== 'none'
    const usableSkills = hasSandbox ? skills : []

    /**
     * 接管上一轮驻留下来的沙盒。**必须在这里做**，早于工作区铺设与系统提示装配 ——
     * 那两件事都取决于这一步的结果（见下面两处）。没有可接管的就返回 null，
     * 一切照旧懒申请。
     */
    const resumed = hasSandbox && sandboxSession.resume
      ? await sandboxSession.resume().catch((error) => {
        // 接管失败从来不该让一轮对话失败：最坏也只是这一轮用个新沙盒。
        logger.warn?.('接管沙盒时出错，本轮改用新沙盒', { runId, username, sessionKey, err: error?.message })
        return null
      })
      : null

    /**
     * 技能文件与用户工作空间懒搬进沙盒：模型第一次 read/exec 工作区时才推，
     * 纯聊天的 run 不占槽位。
     *
     * **接管成功时不铺工作区。** 文件本来就还在沙盒里，重推一遍是白做的；
     * 更要紧的是共享盘上那份可能**更旧** —— 它是上一轮 syncBack 那一刻的快照，
     * 而驻留期间后台进程还在往工作区里写。拿旧的覆盖新的等于静默丢数据。
     * 接管成功时以沙盒里那份为准。
     */
    const stageFiles = workspace?.enabled && hasSandbox && !resumed?.attached
      ? () => workspace.stageFiles({ username, sessionKey })
      : null
    const toolSandbox = attachSkillMaterialization({
      session: sandboxSession,
      skills: usableSkills,
      stageFiles,
      logger,
    })
    const tools = buildTools({ cwd, sandbox: toolSandbox, runContext, apTools, extraTools, toolHooks, logger })

    /**
     * 技能清单进系统提示。
     *
     * `noSkills: true` 是要紧的一条：默认的 loader 会去扫本机磁盘找技能，
     * 多租户服务里那等于把宿主机上的东西端给模型。真正给它的是
     * `toSandboxSkills` 改写过路径的那份 —— 位置写成相对工作区根，
     * 这样模型 read 到的和 bash 里 cd 进去的是沙盒里的同一份。
     */
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noSkills: true,
      skillsOverride: () => ({ skills: toSandboxSkills(usableSkills), diagnostics: [] }),
      /**
       * 顺序是有讲究的：沙盒说明在前，项目/记忆在后。
       *
       * 沙盒那段是**纠错**（否掉提示末尾那行错误的 cwd），越靠近它要纠正的内容
       * 越有效；而项目指令与记忆是背景，放在末尾正好挨着用户这一轮的输入。
       */
      appendSystemPrompt: [
        ...(hasSandbox ? [workspacePrompt()] : []),
        // 紧挨着沙盒说明：讲的是同一件事的下一层——这个沙盒是新的还是上一轮那个
        ...(resumed ? [continuityPrompt(resumed)].filter(Boolean) : []),
        ...contextPrompts.filter(Boolean),
      ],
    })
    await resourceLoader.reload()

    const created = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel,
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager,
      resourceLoader,
      noTools: 'builtin', // ← 不要改。见隔离契约 #2
      customTools: tools,
    })
    session = created.session

    // 补上网关特有的可重试错误特征。pi 的正则只认 429/5xx 这类标准说法，
    // 而我们的网关把偶发故障回成 400 + 中文文案，一条都匹配不上。
    if (retry.enabled) {
      installRetryPolicy(session, { patterns: retryPatterns, logger })
    }

    // ---- 4. 事件订阅 ----
    // 编码器有状态（记着每条助手消息已经发到哪儿了），所以**一个 run 一个**，
    // 不能像从前那样每帧现造 —— 那正是"每帧都重发全文"的来源。
    const encodeFrames = createFrameEncoder()
    const unsubscribe = session.subscribe((event) => {
      events.push(event)
      try {
        encodeFrames(event, onFrame)
      } catch (error) {
        logger.warn?.('事件转发失败', { runId, err: error?.message })
      }
    })

    onStart({ abort: () => session?.abort().catch(() => {}) })

    const timer = setTimeout(() => {
      timedOut = true
      session?.abort().catch(() => {})
    }, timeoutMs)

    /**
     * 附件参与进来的唯一一处。
     *
     * 文本类已经被拼进 `text` 了；图片走 `PromptOptions.images` —— 那是 pi 收图的
     * 官方入口（`prompt(text, options)`），**不能**把 content part 数组塞给第一个参数，
     * 那个位置的类型就是 string，数组进去会被当字符串用掉。
     *
     * 没有附件时 text 就是原来的 prompt、images 为空，第二个参数整个不传 ——
     * 纯文字对话走的仍然是原来那条调用，加附件这件事没有把主干流量挪到新代码上。
     */
    const { text: promptText, images } = buildPromptContent(prompt, attachments, {
      imageCapable: (model.input || []).includes('image'),
    })
    const shape = describeAttachments(attachments)
    if (shape) logger.debug?.('本轮带了附件', { runId, ...shape, imagesSent: images.length })

    try {
      await session.prompt(promptText, images.length ? { images } : undefined)
    } finally {
      clearTimeout(timer)
      unsubscribe()
    }

    if (timedOut) throw Errors.timeout(`本轮执行超过 ${Math.round(timeoutMs / 1000)}s，已中止`)

    // ---- 5. 回写：会话只写回这个 username 自己的那一条 ----
    const sessionFile = sessionManager.getSessionFile()
    const jsonl = sessionFile ? await readFile(sessionFile, 'utf8') : ''
    const entries = sessionManager.getEntries()
    await store.save({
      username,
      sessionKey,
      sessionId: sessionManager.getSessionId(),
      jsonl,
      entryCount: entries.length,
      // 只是个候选标题：store 只在这条会话还没有标题时采纳它（用户改过名的不覆盖）。
      // 只发了附件、一个字没写时退回文件名 —— 总好过一条叫"未命名会话"的记录。
      title: deriveTitle(prompt || attachments.map((item) => item.name).join('、')),
    })

    return {
      runId,
      username,
      sessionKey,
      sessionId: sessionManager.getSessionId(),
      entryCount: entries.length,
      finalText: extractFinalText(events),
      usage: extractUsage(events),
      durationMs: Date.now() - startedAt,
      /**
       * 给用户看的「本轮耗时 / 工具调用次数」。
       *
       * **刻意不用上面那个 durationMs。** 那是整个 run 的服务端耗时，含拿沙盒租约、
       * 铺技能这些准备工作；而刷新之后历史是从消息时间戳算的，两者必然对不上，
       * 现象就是"刚发完 12.3 秒、一刷新 11.8 秒"。这里直接走**历史那条路的同一个函数**，
       * 同一份数据、同一个算法，两边才一定相等。
       *
       * 代价是把刚写完的 jsonl 再解析一遍（几毫秒，相对一次模型调用可以忽略）。
       */
      turnStats: lastTurnStats(jsonl),
    }
  } catch (error) {
    throw toAppError(error)
  } finally {
    // ---- 6. 清场：进程里不留这个用户的任何东西（隔离契约 #3/#5）----
    try {
      session?.dispose()
    } catch (error) {
      logger.warn?.('session.dispose 失败', { runId, err: error?.message })
    }
    /**
     * 工作区回写，**必须排在收尾之前** —— release 不是删文件，是整个 slot
     * 销毁重建（sandbox-worker/src/leases.js），排在它后面就什么都捞不到了。
     *
     * 只在真占过槽位时做：租约是懒申请的，纯聊天的 run 碰都没碰过沙盒，
     * 这里一调 listFiles 反而会现申请一个租约再释放。
     *
     * **驻留的那一轮也照做，不能省。** 驻留下来的 slot 随时可能被抢占、
     * 节点也随时可能重启，共享盘上那一份是唯一兜得住的东西。省掉它换来的
     * 那点延迟，代价是"一旦被抢占就丢一轮产出"。
     */
    if (workspace?.enabled && sandboxSession?.leased) {
      try {
        const synced = await workspace.syncBack({ username, sessionKey, session: sandboxSession, runId })
        if (synced.written || synced.deleted) {
          logger.info?.('工作区已同步回用户空间', { runId, ...synced })
        }
      } catch (error) {
        // 这条**不能**像 release 失败那样轻轻放过：没捞回来意味着用户这一轮的
        // 产出全丢了（slot 马上就要销毁重建）。必须留下明确记录。
        logger.error?.('工作区回写失败 —— 本轮在沙盒里产生的文件已丢失', {
          runId, username, sessionKey, err: error?.message,
        })
      }
    }

    /**
     * 沙盒收尾。两种结局，判据来自**这一轮真的发生过什么**：
     *
     *   驻留（park）—— 用过浏览器（或 always）。slot 不销毁，浏览器登录态、
     *     已装的依赖、后台进程留着，下一轮 `resume()` 接回来。
     *   释放（release）—— 其余一律如此，也就是今天的行为。
     *
     * 为什么不问模型要不要保留：它没有容量视角，也不知道下一轮还来不来，
     * 问了它会永远说要。见 docs/SANDBOX-LIFECYCLE.md §4。
     *
     * worker 可以拒绝驻留（超配额、快撞硬顶、老版本没这个路由），`finish` 会
     * 自己退回释放 —— **宁可丢连续性，不能泄漏槽位**。
     *
     * 收尾失败只会让 worker 侧多占一会儿槽位（有 idle 清扫兜底），但绝不能因此
     * 把本轮结果搞丢，所以吞掉异常只记日志。
     */
    const wantPark = parkPolicy === 'always'
      || (parkPolicy === 'auto' && Boolean(sandboxSession?.browserLive))
    if (sandboxSession?.finish) {
      await sandboxSession.finish({ park: wantPark }).catch((error) => {
        logger.warn?.('沙盒会话收尾失败', { runId, err: error?.message })
      })
    } else {
      // 测试里的假沙盒、以及 local/none 之外的旧实现只有 release
      await sandboxSession?.release?.().catch?.((error) => {
        logger.warn?.('沙盒会话释放失败', { runId, err: error?.message })
      })
    }
    await rm(workRoot, { recursive: true, force: true }).catch((error) => {
      logger.error?.('临时目录清理失败 —— 可能残留用户数据', { runId, workRoot, err: error?.message })
    })
  }
}
