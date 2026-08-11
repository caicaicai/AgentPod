/**
 * 「复制调试信息」：把当前这次对话出了什么问题，攒成一段可以直接贴给人看的 Markdown。
 *
 * ── 为什么要有这个 ────────────────────────────────────────────────────
 *
 * 助手交互出问题时，最贵的一步是**把现场说清楚**：用了哪个模型、沙盒是不是接上了、
 * 工具到底调没调、返回了什么、哪一条请求失败了。靠人复述必然丢信息，而这些东西
 * 浏览器里全都有。一键攒好，贴过去就能分析。
 *
 * ── 里面有什么、没有什么 ──────────────────────────────────────────────
 *
 * **有**：环境与模式、模型、会话内容（含思考、工具入参与结果预览）、最近的失败请求
 * （带 requestId / traceId，可以拿去 grep 服务端日志）、每轮耗时与工具次数。
 *
 * **没有**：任何凭据。不读 `document.cookie`（SSO 票就在里面），也没有 llmToken ——
 * 那个东西从来不下发到浏览器。这不是"顺手做的过滤"，是这份文件里**根本不去取**
 * 那些值。会话正文属于用户自己的数据，是他自己决定要分享的，所以照原样带上，
 * 但头部会写一句提醒。
 */

/** 整份调试信息的上限。超了就从最老的一轮开始丢 —— 出问题的现场总是在最后 */
const MAX_BUNDLE_CHARS = 60000
/** 单个工具结果在调试信息里最多留多少字（服务端已经截到 4000，这里再收一道） */
const MAX_TOOL_PREVIEW = 1500

const pad = (n) => String(n).padStart(2, '0')

function stamp(ms = Date.now()) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function clip(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n…（已截断，原长 ${value.length} 字符）`
}

/** 代码块里可能出现 ``` —— 用更长的围栏包住，免得整段 Markdown 结构塌掉 */
function fence(text, lang = '') {
  const body = String(text ?? '')
  let ticks = '```'
  while (body.includes(ticks)) ticks += '`'
  return `${ticks}${lang}\n${body}\n${ticks}`
}

function describeDuration(stats) {
  if (!stats) return ''
  const bits = []
  if (typeof stats.durationMs === 'number' && stats.durationMs >= 0) bits.push(`耗时 ${(stats.durationMs / 1000).toFixed(1)}s`)
  bits.push(`工具 ${stats.toolCalls || 0} 次`)
  return bits.join(' · ')
}

/* ═══════════════ 自动挑疑点 ═══════════════ */

/**
 * 把"一眼能看出不对"的东西先列出来。
 *
 * 不是要替代分析，是省掉每次都要从头翻一遍的那几件事 —— 尤其是
 * "模式根本不是真实环境"（faux 模型 / dev 身份 / 沙盒 none）这类，
 * 不先排掉的话后面所有推理都建立在错的前提上。
 */
function collectSuspicions({ health, turns, events, skills, skillsUsable }) {
  const notes = []

  if (health?.llmMode === 'faux') notes.push('LLM_MODE=faux —— 现在用的是假模型，回复内容不代表真实模型行为')
  if (health?.llmMode === 'direct') notes.push('LLM_MODE=direct —— 直连外部端点，用的是共用 key，不是每人自己的 llmToken')
  if (health?.authMode === 'dev') notes.push('AUTH_MODE=dev —— 身份是客户端自称的，不是 SSO 认定的')
  if (health?.sandbox === 'none') notes.push('SANDBOX_MODE=none —— **没有执行端**，模型调不了任何命令类工具')
  if (health?.sandbox === 'local') notes.push('SANDBOX_MODE=local —— 命令跑在 agent 进程里，不是沙盒')
  if (skills && skills.length === 0) notes.push('技能清单是空的 —— SKILL_DIRS 没配或没读到（模型不知道有任何技能）')
  if (skillsUsable === false) notes.push('技能不可用（usable=false）—— 清单里有，但没有执行端')

  let aborted = 0
  let toolErrors = 0
  let turnErrors = 0
  let truncated = 0
  for (const turn of turns) {
    if (turn.role !== 'assistant') continue
    if (turn.error) turnErrors += 1
    if (turn.warning) truncated += 1
    for (const block of turn.blocks || []) {
      if (block.type !== 'tool') continue
      if (block.status === 'aborted' || block.status === 'running') aborted += 1
      if (block.status === 'error') toolErrors += 1
    }
  }
  // 排在工具失败前面：截断往往**就是**那些工具失败的成因（参数断在一半），
  // 先看到它能省掉一整轮"为什么模型突然不会调工具了"的排查。
  if (truncated) {
    notes.push(`有 ${truncated} 轮模型输出被截断 —— 后面的工具参数残缺、脚本少半截多半是它造成的，不是模型变笨`)
  }
  if (aborted) notes.push(`有 ${aborted} 个工具调用停在"未完成" —— 那一轮跑到一半断了（超时/关页面/被中止）`)
  if (toolErrors) notes.push(`有 ${toolErrors} 个工具调用失败 —— 看下面对应的结果预览`)
  if (turnErrors) notes.push(`有 ${turnErrors} 轮带错误信息`)

  const http401 = events.filter((e) => e.status === 401).length
  const http5xx = events.filter((e) => e.status >= 500).length
  if (http401) notes.push(`有 ${http401} 次 401 —— 登录态问题`)
  if (http5xx) notes.push(`有 ${http5xx} 次 5xx —— 服务端或上游故障，拿 requestId 去查日志`)

  return notes
}

/* ═══════════════ 流式节奏 ═══════════════ */

/** 超过这个空档就单独列出来 —— 低于它的间隔人是感觉不到的 */
const NOTABLE_GAP_MS = 400

/**
 * 把「每帧什么时候到的」渲染成一段能直接下判断的文字。
 *
 * 要回答的就一个问题：**"卡住"的那几秒里，帧到底有没有在来？**
 *
 * ── 这份记录能证明什么、不能证明什么 ──────────────────────────────────
 *
 * **没有空档 → 可以断定问题在渲染。** 帧一直在按时到，界面却不动，
 * 那就只剩"画不出来"这一种解释了。这是它最有价值的一条结论。
 *
 * **有空档 → 只能说"这段时间没帧到"，不能直接判给上游。** 读流的循环
 * 就在主线程上，渲染一旦阻塞几秒，`reader.read()` 的 resolve 同样会被推迟，
 * 记下来的也是一段空档 —— 上游和渲染在这里长得一模一样。
 * （这条最早写成了"有空档 = 上游在憋"，直接把一次排查带偏了：
 * 报告指着上游，真正的 bug 在渲染端。）要分开还得再看一眼：
 * 空档期间界面有没有在动、以及服务端日志里那一段有没有在收 token。
 */
function renderStreamTrace(trace) {
  const lines = ['## 流式节奏（最近一次对话）', '']
  if (!trace || !trace.frames?.length) {
    lines.push('（这个会话还没有发过消息，或者页面刷新过 —— 记录只在内存里）', '')
    return lines
  }

  const { frames, bytes = 0, dropped = 0, endedAt = 0 } = trace
  const first = frames[0]
  const firstText = frames.find((f) => f.type === 'text' || f.type === 'thinking')
  const total = endedAt || frames[frames.length - 1].at

  /**
   * 空档**只从第一个正文/思考帧开始算**。
   *
   * 从 0 算起的话，"模型出第一个 token 之前的等待"（TTFT，思维链模型两三秒很正常）
   * 会被当成一处上游空档报出来 —— 那是这份记录第一版犯的错，直接把排查带偏了：
   * 报告说"上游在憋"，实际上那两秒是正常的首字延迟，真正的问题在渲染。
   * 首字延迟另有一行专门写，不该在这里重复计一次。
   */
  const gaps = []
  let prev = firstText ? firstText.at : first.at
  for (const f of frames) {
    if (f.at <= prev) continue
    gaps.push({ at: f.at, type: f.type, gap: f.at - prev })
    prev = f.at
  }
  const notable = gaps.filter((g) => g.gap >= NOTABLE_GAP_MS).sort((a, b) => b.gap - a.gap).slice(0, 10)

  lines.push(
    `| 项 | 值 |`,
    `|---|---|`,
    `| 首帧 | ${first.at}ms（\`${first.type}\`）|`,
    // 思维链模型两三秒是正常的，**不是**卡顿 —— 下面的空档统计已经把它排除在外
    `| 首字延迟（TTFT） | ${firstText ? `${(firstText.at / 1000).toFixed(2)}s（\`${firstText.type}\`，思维链模型 2~3s 正常）` : '没有正文帧'} |`,
    `| 总时长 | ${(total / 1000).toFixed(2)}s |`,
    `| 帧数 | ${frames.length}${dropped ? `（另有 ${dropped} 帧超出记录上限）` : ''} |`,
    `| 传输量 | ${(bytes / 1024).toFixed(1)}KB |`,
    // 出字之后的平均间隔。把 TTFT 摊进来的话数字会虚高一大截
    // （2.4s 首字延迟摊进 190 帧就是每帧凭空多出 13ms），那不是"节奏"
    `| 出字后平均间隔 | ${gaps.length ? Math.round(gaps.reduce((sum, g) => sum + g.gap, 0) / gaps.length) : 0}ms |`,
    '',
  )

  if (!notable.length) {
    lines.push(
      `**帧是连续到达的**（没有超过 ${NOTABLE_GAP_MS}ms 的空档）。`,
      '既然帧一直在按时到、界面却不动，那就只剩"画不出来"这一种解释 —— 问题在渲染。',
      '',
    )
    return lines
  }

  lines.push(
    `**有 ${notable.length} 处明显空档**（≥${NOTABLE_GAP_MS}ms）—— 这几段时间里一帧都没到。`,
    '注意这**还不能判给上游**：读流的循环在主线程上，渲染阻塞几秒也会记成一样的空档。',
    '要分开，再看空档期间界面有没有在动、服务端日志那一段有没有在收 token。',
    '',
  )
  lines.push('| 空档 | 结束于 | 之后到的帧 |', '|---|---|---|')
  for (const g of notable) lines.push(`| ${(g.gap / 1000).toFixed(2)}s | ${(g.at / 1000).toFixed(2)}s | \`${g.type}\` |`)
  lines.push('')
  return lines
}

/* ═══════════════ 组装 ═══════════════ */

/**
 * 附件在调试信息里**只写文件名、类型和大小，不写内容**。
 *
 * 一张截图的 base64 有几百 KB，几个附件就能把整份调试信息撑爆，而排查时真正
 * 需要知道的是"带了什么进去"——名字和类型足够回答它。想看内容的话，正文里
 * 那些文本附件本来就已经被拼进 prompt 了。
 */
function describeFiles(files = []) {
  if (!files.length) return ''
  const rows = files.map((file) => {
    const size = typeof file.size === 'number' ? `${Math.max(1, Math.round(file.size / 1024))}KB` : '?'
    return `  - \`${file.name || '(未命名)'}\`（${file.mimeType || '未知类型'}，${size}）`
  })
  return `\n附件 ${files.length} 个：\n${rows.join('\n')}\n`
}

function renderTurn(turn, index) {
  if (turn.role === 'user') {
    // images 是历史里数出来的张数，files 是本次发送时带上的附件清单，两者不冲突：
    // 刷新之后只剩前者（服务端存的是 pi 的 content part，不留原始文件名）
    const images = turn.images ? `（另含 ${turn.images} 张图片）` : ''
    return `### ${index}. 用户\n\n${fence(clip(turn.text, 4000))}${describeFiles(turn.files)}${images ? `\n${images}\n` : '\n'}`
  }

  const head = describeDuration(turn.stats)
  const lines = [`### ${index}. 助手${head ? ` — ${head}` : ''}${turn.done === false ? '（未完成）' : ''}\n`]

  for (const block of turn.blocks || []) {
    if (block.type === 'thinking') {
      lines.push(`<details><summary>思考过程</summary>\n\n${fence(clip(block.text, 2000))}\n</details>\n`)
      continue
    }
    if (block.type === 'text') {
      lines.push(`${clip(block.text, 6000)}\n`)
      continue
    }
    if (block.type !== 'tool') continue

    const status = { done: '成功', error: '失败', running: '仍在执行', aborted: '未完成' }[block.status] || block.status
    let args
    try { args = JSON.stringify(block.args ?? {}, null, 2) } catch { args = String(block.args) }
    lines.push(`**工具 \`${block.toolName}\` — ${status}**\n`)
    lines.push(`入参：\n${fence(clip(args, 1200), 'json')}\n`)
    if (block.status !== 'running') {
      lines.push(`结果：\n${fence(clip(block.preview || '（无输出）', MAX_TOOL_PREVIEW))}\n`)
    }
  }

  // 截断这类"有结果但结果是残的"必须单独写出来。上一版没有它，
  // 一次 max_tokens 截断在调试信息里长得和正常回答一模一样，只能靠反推才找得到。
  if (turn.warning) lines.push(`> ⚠️ 本轮告警：${turn.warning}\n`)
  if (turn.error) lines.push(`> ⚠️ 本轮错误：${turn.error}${turn.requestId ? `（requestId ${turn.requestId}）` : ''}\n`)
  return lines.join('\n')
}

/**
 * @param {object} input
 * @param {object|null} input.health   /healthz 的快照
 * @param {Array}  input.turns         已完成的轮次（形状同 app.js 的 state.turns）
 * @param {object|null} input.live     正在跑的那一轮
 * @param {Array}  input.events        最近的请求记录（api.js 的环形缓冲）
 * @param {string} input.sessionKey
 * @param {string} input.modelId
 * @param {Array}  input.skills
 * @param {boolean} input.skillsUsable
 * @param {object|null} input.streamTrace 最近一次流式对话的每帧到达时刻（api.js 的 getStreamTrace）
 */
export function buildDebugBundle(input) {
  const {
    health, turns = [], live = null, events = [], sessionKey = '', modelId = '',
    skills = [], skillsUsable, streamTrace = null,
  } = input
  const allTurns = live ? [...turns, live] : turns

  const header = [
    '# 云端助手 · 调试信息',
    '',
    `- 生成时间：${stamp()}`,
    `- 页面：${location.href}`,
    `- 浏览器：${navigator.userAgent}`,
    `- 会话 key：\`${sessionKey}\``,
    `- 当前模型：\`${modelId || '(未选)'}\``,
    '',
    '> 这段信息里有本次会话的原文与工具输出（属于你自己的数据），**贴给别人前请先确认可以分享**。',
    '> 里面不含任何凭据：没有 cookie / SSO 票 / llmToken —— 这份文件根本不去取它们。',
    '',
  ]

  const env = health
    ? [
      '## 运行环境',
      '',
      `| 项 | 值 |`,
      `|---|---|`,
      `| 身份模式 | \`${health.authMode}\` |`,
      `| 模型模式 | \`${health.llmMode}\` |`,
      `| 沙盒 | \`${health.sandbox}\` |`,
      `| 并发 | ${health.activeRuns}/${health.budget}（每人上限 ${health.perUserLimit}）|`,
      `| 调试端点（DEV_CONSOLE） | ${health.devConsole ? '开' : '关'} |`,
      `| 技能 | ${skills.length} 个${skillsUsable === false ? '（不可用：没有执行端）' : ''} |`,
      '',
    ]
    : ['## 运行环境', '', '（拿不到 /healthz —— 服务端可能连不上）', '']

  const suspicions = collectSuspicions({ health, turns: allTurns, events, skills, skillsUsable })
  const suspicionSection = suspicions.length
    ? ['## 自动挑出来的疑点', '', ...suspicions.map((note) => `- ${note}`), '']
    : ['## 自动挑出来的疑点', '', '- （没发现明显异常）', '']

  const eventSection = ['## 最近的请求问题', '']
  if (!events.length) eventSection.push('（没有记录到失败请求）', '')
  else {
    eventSection.push('| 时间 | 请求 | 状态 | 说明 | requestId | traceId |', '|---|---|---|---|---|---|')
    for (const e of events) {
      eventSection.push(
        `| ${stamp(e.at)} | ${e.method} ${e.path} | ${e.status || '-'} ${e.code || ''} | ${String(e.message || '').slice(0, 80).replace(/\|/g, '\\|')} | \`${e.requestId || '-'}\` | \`${e.traceId || '-'}\` |`,
      )
    }
    eventSection.push('')
  }

  const traceSection = renderStreamTrace(streamTrace)

  // 对话从最后一轮往前放进来，超上限就停 —— 出问题的现场总在最后
  const rendered = []
  let used = [...header, ...env, ...suspicionSection, ...traceSection, ...eventSection].join('\n').length
  let dropped = 0
  for (let i = allTurns.length - 1; i >= 0; i -= 1) {
    const text = renderTurn(allTurns[i], i + 1)
    if (used + text.length > MAX_BUNDLE_CHARS && rendered.length) { dropped = i + 1; break }
    used += text.length
    rendered.unshift(text)
  }

  const conversation = [
    `## 对话（共 ${allTurns.length} 条消息${dropped ? `，因长度只保留最后 ${allTurns.length - dropped} 条` : ''}）`,
    '',
    ...(rendered.length ? rendered : ['（这个会话还没有内容）']),
  ]

  return [...header, ...env, ...suspicionSection, ...traceSection, ...eventSection, ...conversation].join('\n')
}

/**
 * 复制到剪贴板。
 *
 * **不能只用 `navigator.clipboard`**：它只在安全上下文（https 或 localhost）里存在，
 * 而本项目线上跑的是 `http://内网域名` —— 那里 `navigator.clipboard` 是 undefined，
 * 按钮会直接哑掉。所以要有 execCommand 那条老路兜底；两条都不行时由调用方
 * 把文本显示出来让用户手动复制。
 *
 * @returns {Promise<boolean>} 复制成功与否
 */
export async function copyToClipboard(text) {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到下面那条老路
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    // 不能用 display:none —— 那样选不中，execCommand 会静默失败
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;'
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}
