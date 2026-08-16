/**
 * 一轮对话在界面上的全过程：发出去、收帧、断了接回来、收尾。
 *
 * ── 这个文件里最要紧的一件事 ────────────────────────────────────────────
 *
 * **`driveRun` 是唯一一处处理帧的地方。** 有两条入口会用到它 ——
 * 新发起的一轮（POST /v1/chat/stream）和断线后接回来的一轮
 * （GET /v1/runs/:id/events）—— 它们只在"怎么把流拉起来"这一点上不同，
 * 收到帧之后要做的事一模一样。各写一份的话，两边迟早只改了其中一边，
 * 而差异只会在真的断过线的用户身上现形，是最难被发现的那一类。
 *
 * 与 sessions.js / artifacts.js 互相 import（一轮跑完要刷列表、要刷作品；
 * 那边"问问这块元素"要直接发一轮）。环为什么是安全的、以及那条
 * "不许在模块顶层跨模块调用"的纪律，见 sessions.js 开头。
 */
import { reactive } from 'vue'

import { api, streamChat, resumeRun, ApiError } from '../lib/api.js'
import { formatTurnStats } from '../lib/format.js'
import { toWire } from '../modules/chat/attachments.js'
import { composeElementPrompt } from '../modules/artifacts/artifact-view.js'
import { state } from './state.js'
import { hideBanner } from './ui.js'
import { clearDraft, openSession, refreshSessions } from './sessions.js'
import { refreshArtifacts } from './artifacts.js'
import { loadMemory } from './app.js'

/* ═══════════════ 发送与流式 ═══════════════ */

/**
 * 把一帧 text / thinking 落到块上。
 *
 * 服务端首帧发 `text`（全文，整体替换），之后发 `delta`（追加）—— 两个字段互斥。
 * 从前每帧都是全文，传输量是 O(n²)：1.6KB 的回复实测发了 491KB，
 * 现象就是"开头顺畅、越往后越卡、最后一大段一起蹦出来"。见 src/agent/events.js。
 *
 * 先判 `text`：它是权威值，服务端在内容不是纯追加时（模型重写、重试摘掉半条消息）
 * 会退回一次全文替换，那一帧必须覆盖而不是追加。
 */
function applyChunk(block, data) {
  if (typeof data.text === 'string') block.text = data.text
  else if (typeof data.delta === 'string') block.text += data.delta
}

/**
 * 往 live.blocks 里加一块，**并把数组里那个响应式代理还回来**。
 *
 * ── 不这么写会怎样 ────────────────────────────────────────────────────
 *
 * `const b = { type:'text', text:'' }; live.blocks.push(b)` 之后手里的 `b`
 * 仍然是**原始对象**：`reactive()` 是在读取时才包代理的，push 进去的东西
 * 原样存着。而响应式只在代理的 set 陷阱里触发 —— 直接改原始对象，
 * **一次重绘都不会发生**。（实测：3 次赋值，0 次重绘。）
 *
 * 这个 bug 的表现极具迷惑性，因为它不是"完全不更新"：
 *   - push 本身是数组变更，会触发一次重绘 → 第一帧看得见
 *   - 之后每一帧都是原始对象赋值 → **界面冻住**
 *   - 一轮结束时 `live.meta = …`、`state.turns.push(live)` 又触发 → **整段一起蹦出来**
 *
 * 于是用户看到的正是："输出了思考、输出了「你好」，卡住，然后突然全吐出来"。
 * 而工具卡片一直是好的 —— 那条路走的是 `live.blocks.find(…)`，
 * 数组的 get 陷阱会把元素包成代理，所以改的是代理。正因为工具是好的，
 * 这个问题很容易被误判成"网络/上游在憋"。
 */
function pushBlock(live, block) {
  live.blocks.push(block)
  return live.blocks[live.blocks.length - 1]
}

export async function send() {
  const typed = state.draft.trim()
  const attachments = state.attachments.slice()
  const context = state.composerContext
  if ((!typed && !attachments.length) || state.live) return

  /**
   * 引用上下文在**这一刻**才拼进正文。
   *
   * 发出去的是完整提示词（模型要那些标记才知道改哪儿），而界面上留下的是
   * "一句话 + 一枚 chip" —— 两者形状不同是有意的，折回来的规则见 parsePickedElement。
   */
  const prompt = context ? composeElementPrompt({ ...context, instruction: typed }) : typed

  state.draft = ''
  state.attachments = []
  state.composerContext = null
  state.composerError = ''
  clearDraft(state.activeKey) // 已经发出去了，草稿不该再留着
  hideBanner()

  state.turns.push({
    role: 'user',
    text: typed,
    images: 0,
    files: attachments,
    element: context ? { label: context.pick.label, info: '', html: context.pick.html } : null,
    timestamp: Date.now(),
  })

  await driveRun({
    start: (onFrame, signal) => streamChat(
      {
        prompt,
        sessionKey: state.activeKey,
        model: state.modelId || undefined,
        // 只在会话第一轮生效，服务端以存储里的归属为准
        projectId: state.projectId,
        attachments: attachments.map(toWire),
        signal,
      },
      onFrame,
    ),
  })
}

/**
 * 一轮对话在界面上的生命周期：建气泡 → 收帧 → 断了就接回去 → 收尾。
 *
 * **怎么把流拉起来由调用方注入**（`start`），因为有两条入口，而它们只在这一点上不同：
 *   send()             POST /v1/chat/stream —— 跑一轮新的
 *   resumeActiveRun()  GET  /v1/runs/:id/events —— 接回刷新页面之前就在跑的那一轮
 *
 * 除此之外两条路要做的事一模一样：同一套帧处理、同一套重连退避、同一套收尾。
 * 各写一份的话，它们迟早只改了其中一边 —— 而差异只会在真的断过线、
 * 或者真的刷新过页面的用户身上现形，是最难被发现的那一类。
 *
 * @param {(onFrame: Function, signal: AbortSignal) => Promise<void>} params.start
 * @param {string} [params.runId] 已知的 runId。重连那条路一开始就知道；
 *   新发起的那条要等服务端的 run_start 帧才知道，所以默认空。
 */
async function driveRun({ start, runId = '' }) {
  const controller = new AbortController()
  const live = reactive({
    role: 'assistant',
    blocks: [],
    error: '',
    warning: '',
    requestId: '',
    done: false,
    runId,
    /**
     * 收到的最后一帧序号（SSE 的 `id:`，也就是服务端 run 缓冲里的序号）。
     * 断线重连时把它当断点带回去，服务端只重放它之后的 —— 见
     * src/agent/run-registry.js。
     */
    lastSeq: 0,
    /** 正在重连时的 { attempt, max }，给气泡上那行"连接断开，正在重连…"用 */
    reconnecting: null,
    retry: null,
    retriedCount: 0,
    /**
     * 正在压缩上下文时的 `{ reason }`，压完清空。
     *
     * 与 `retry` 是同一类东西：一段**没有任何输出的等待**。压缩要另外调一次模型
     * 写摘要，几秒到十几秒，期间一个字都不出 —— 不说出来的话，用户看到的是
     * "卡住了"，多半会去点停止。
     */
    compacting: null,
    /** 这一轮压缩过几次。压完 `compacting` 就清了，但这件事值得留在气泡上 */
    compactedCount: 0,
    timestamp: Date.now(),
    controller,
  })
  state.live = live

  /** 当前敞着的那个文本/思考块；text_end 一到就封口，下一段另起一块 */
  let openText = null
  let openThinking = null

  /**
   * 收尾：停转圈、把这一轮挪进历史、放开输入框。
   *
   * **`final` 帧一到就调，不等流关闭。** 服务端在发完 final 之后还要抓记忆
   * （另一次模型调用），从前这里只在流关闭时收尾，于是正文早就停了、
   * final 也到了，界面还要再转好几秒 —— 实测 4.3 秒，而 final 距最后一个
   * 正文帧只有 14ms。信息一直在，是这里没用。
   *
   * 幂等，因为两条路都要走：正常收到 final 走这里；出错、中止、连接断了
   * 收不到 final，就由 finally 兜底。
   */
  let settled = false
  function settle() {
    if (settled) return
    settled = true
    live.done = true
    // 跑到一半断掉的工具，状态停在"执行中"会一直转圈，改成"未完成"
    for (const block of live.blocks) if (block.status === 'running') block.status = 'aborted'
    state.turns.push(live)
    state.live = null
  }

  /** 收到 resync 帧时置上：收尾之后整条会话重新加载一次 */
  let resyncRequested = false

  /**
   * 一帧到手要做的事。
   *
   * **提成具名函数是为了让重连能复用它** —— 断线之后接回来的那条流
   * （`/v1/runs/:id/events`）发的是同样的帧，处理逻辑必须是同一份。
   * 各写一份的话，两边迟早只改了其中一边，而"重连回来之后某种帧不认了"
   * 这种毛病只会在真的断过线的用户身上出现。
   */
  function handleFrame(type, data, seq) {
    // 断点要在处理这一帧**之前**记下：处理途中抛错的话，这一帧已经到手了，
    // 重连时不该再要一遍（要了就会重复渲染）
    if (seq > 0) live.lastSeq = seq
    {
        switch (type) {
          case 'run_start':
            live.runId = data.runId
            break
          case 'model':
            live.meta = data.id
            break
          case 'thinking':
            // 必须用 pushBlock 的返回值（数组里的响应式代理）—— 见它的说明，
            // 拿着 push 进去的那个原始对象改，界面从第二帧起就不动了
            if (!openThinking) openThinking = pushBlock(live, { type: 'thinking', text: '' })
            applyChunk(openThinking, data)
            break
          case 'text':
            if (!openText) openText = pushBlock(live, { type: 'text', text: '' })
            applyChunk(openText, data)
            break
          case 'text_end':
            openText = null
            openThinking = null
            // 模型/网关出错时 pi 不抛异常，只是结束一条 stopReason='error' 的消息。
            // 不在这里接住，界面上就是个空气泡。
            if (data.errorMessage) live.error = data.errorMessage
            // 截断（stopReason='length'）不是错误：这一轮有输出、还会继续调工具。
            // 但结果可能是残的，用户必须看见 —— 否则表现就是"模型突然变笨了"。
            if (data.warning) live.warning = data.warning
            break
          case 'retry':
            if (data.state === 'start') {
              live.retry = { attempt: data.attempt, maxAttempts: data.maxAttempts, delayMs: data.delayMs }
              // 记总次数：重试结束后 live.retry 会清掉，但"这轮重试过"值得留在气泡上 ——
              // 用户回头看耗时为什么是 20 秒时，这是唯一的解释。
              live.retriedCount += 1
            } else {
              live.retry = null
            }
            break
          /**
           * 上下文压缩。自动压缩默认开着，所以这一帧在长会话里是常态，不是异常。
           *
           * 失败且**还会重试**时不清 `compacting` —— 清了的话界面会闪一下
           * "压缩结束"，紧接着又是"正在压缩"，看起来像卡在循环里。
           */
          case 'compaction':
            if (data.state === 'start') {
              live.compacting = { reason: data.reason }
              live.compactedCount += 1
            } else if (!data.willRetry) {
              live.compacting = null
              /**
               * 压缩失败了要说出来，但**不算这一轮失败**：pi 压不动时照样把这一轮
               * 跑完（除非是 overflow 那种压缩本来就是在救场的）。所以走 warning
               * 而不是 error —— 用 error 的话，一条正常答完的回复会顶着一条红字。
               */
              if (data.errorMessage) live.warning = `上下文压缩失败：${data.errorMessage}`
            }
            break
          case 'tool_call':
            live.blocks.push({
              type: 'tool',
              toolCallId: data.toolCallId,
              toolName: data.toolName,
              args: data.args || {},
              status: 'running',
              preview: '',
              images: [],
            })
            break
          case 'tool_result': {
            const block = live.blocks.find(
              (item) => item.type === 'tool' && item.toolCallId === data.toolCallId,
            )
            if (!block) break
            block.status = data.isError ? 'error' : 'done'
            block.preview = data.preview || ''
            block.previewTruncated = Boolean(data.previewTruncated)
            block.resultLength = data.resultLength || 0
            block.images = data.images || []
            /**
             * 作品是刚刚才存下来的，清单得当场跟上 —— 等到这一轮结束再刷的话，
             * 模型一边写第二份、用户一边看着侧栏只有第一份，会以为没存上。
             */
            if (block.toolName === 'artifact' && !data.isError) refreshArtifacts()
            break
          }
          case 'final':
            // 与历史走同一个格式化函数、同一份服务端算出来的数 —— 刷新前后不会变样
            live.meta = formatTurnStats(data.turnStats)
            live.stats = data.turnStats
            // final 就是最后一帧，这一轮到此为止 —— 不要再等流关闭（见 settle）
            settle()
            break
          case 'error':
            live.error = data.message || '执行失败'
            break
          /**
           * 服务端说"接不上了"：缓冲撑爆过，中间少了帧。
           *
           * 这时**不能装作接上了继续往下渲染** —— 少掉的那几帧里可能有整段
           * 文本，补不上却继续画，用户看到的是一段中间缺了几句的回答，
           * 而没有任何迹象表明它缺过。整条会话重新加载一次是唯一诚实的处理。
           */
          case 'resync':
            live.reconnecting = null
            resyncRequested = true
            break
          default:
            break
        }
    }
  }

  /**
   * 断线之后把这一轮接回来。
   *
   * 这是这个功能的全部意义：从前流一断，服务端的 run 照样跑到结束、token
   * 照样烧完，而客户端**没有任何入口**回到那条流上；会话正文又要等这一轮
   * 结束才落库，所以连刷新页面都救不回来。用户看到的就是"我刚才那句话
   * 发出去之后就没了"。
   *
   * 退避着重试几次而不是只试一次：断线常常伴随着一小段网络不可用
   * （切 Wi-Fi、进电梯），第一次重连多半也连不上。
   */
  async function resumeAfterDrop() {
    if (!state.features.runResume || !live.runId) return

    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (settled || resyncRequested || controller.signal.aborted) return

      live.reconnecting = { attempt, max: maxAttempts }
      // 1s / 2s / 4s / 8s / 16s
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)))
      if (settled || resyncRequested || controller.signal.aborted) return

      try {
        await resumeRun({ runId: live.runId, from: live.lastSeq, signal: controller.signal }, handleFrame)
        live.reconnecting = null
        /**
         * 流正常读完了。**但这不等于这一轮结束了** —— 也可能是刚接上又断了。
         * 只有 settle 过（收到 final）才算完，否则继续下一次重试。
         */
        if (settled || resyncRequested) return
      } catch (error) {
        if (error.name === 'AbortError') return
        /**
         * 404 = run 已经不在了（跑完超过保留期，或者服务端重启过）。
         * 再试多少次都是这个结果，别拿五次注定失败的请求耗着用户。
         */
        if (error instanceof ApiError && error.status === 404) break
        // 其余（网络不通、502…）继续退避重试
      }
    }

    live.reconnecting = null
    if (!settled && !resyncRequested) live.error = live.error || '连接已断开，且没能接回这一轮'
  }

  try {
    await start(handleFrame, controller.signal)
  } catch (error) {
    /**
     * 已经收到 final 就不再记错误。
     *
     * 这一轮已经成功了，之后连接上再出什么岔子（收尾阶段断线之类）都与结果无关，
     * 记上去就是在一条好好的回复下面挂一条红字。往上抛也不行 —— send() 没人
     * 接，那就是一个未捕获的 rejection。丢掉是对的。
     */
    if (!settled) {
      if (error.name === 'AbortError') live.error = live.error || '已停止'
      else if (error instanceof ApiError && error.status) { live.error = error.message; live.requestId = error.requestId }
      else {
        /**
         * **没有 status 的 ApiError / TypeError = 连接本身断了**（不是服务端
         * 回了一个错误码）。这正是可以接回去的那一类，先别急着报错。
         */
        await resumeAfterDrop()
        if (!settled && !resyncRequested && !live.error) live.error = error.message || String(error)
      }
    }
  } finally {
    /**
     * 流"正常"读完却没收到 final，同样是断线的一种表现（服务端进程被回收、
     * 中间的反代掐了长连接）—— fetch 那边不会抛，它只是读到了流末尾。
     * 这一类从前完全没人管，表现是气泡停在半路然后被 settle 收掉。
     */
    if (!settled && !resyncRequested && !controller.signal.aborted && !live.error) {
      await resumeAfterDrop()
    }
    // 兜底：出错、中止、连接断了都收不到 final
    settle()
    /**
     * 接不上，整条会话重新加载一次 —— 权威记录在服务端，
     * 界面上这份残缺的不如直接换掉。
     */
    if (resyncRequested) await openSession(state.activeKey)
    await refreshSessions()
    /**
     * 这一轮可能刚往记忆里写了几条，侧栏那个数字要跟上。
     *
     * 助手自己调 memory 工具写的那些，在 final 之前就落库了，这里一定读得到。
     * 但**自动抓取**是排在 final 之后的（另一次模型调用），这时候多半还没跑完 ——
     * 那个数字会晚一轮。这是为了不让界面陪着它多转几秒而付的代价，
     * 而且用户真去开记忆面板时 togglePanel 会重新拉一次，看到的是准的。
     */
    if (state.features.memory && state.memoryScope === 'personal') loadMemory()
  }
}

/**
 * 刷新页面之后，把这条会话上**还在跑**的那一轮接回来。
 *
 * 为什么需要它：会话正文要等一轮**结束**才落库，所以刷新之后拉回来的历史里
 * 根本没有正在生成的这一轮。不问一句的话，用户看到的是"我刚发的那句话之后
 * 就没了"—— 而服务端其实一直在跑，token 也一直在烧。
 *
 * 只接**这条会话**的，且只接还没跑完的：刚跑完的那些正文已经落库，
 * 历史里就有，再接一遍会让同一段回答出现两次。
 *
 * 整段吞掉异常：接不回来是个可以接受的降级（历史还在，用户重发一次就是），
 * 而为它弹一条报错只会让人以为是自己刚才那句话出了问题。
 */
export async function resumeActiveRun(sessionKey) {
  if (!state.features.runResume || state.live) return false
  try {
    const { runs = [] } = await api.runs(sessionKey)
    const live = runs.find((run) => !run.done)
    if (!live) return false

    // 飞行途中用户又切走了：这一轮已经不属于当前会话
    if (state.activeKey !== sessionKey) return false

    await driveRun({
      runId: live.runId,
      // from=0：这一轮的帧我们一帧都没见过（页面是新的），要整段重放
      start: (onFrame, signal) => resumeRun({ runId: live.runId, from: 0, signal }, onFrame),
    })
    return true
  } catch {
    return false
  }
}

export async function stop() {
  const live = state.live
  if (!live) return
  try {
    // 先让服务端中止（沙盒里的进程要停），流会自己收尾
    if (live.runId) await api.abort(live.runId)
    else live.controller.abort()
  } catch {
    live.controller.abort()
  }
}
