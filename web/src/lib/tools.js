/**
 * 工具卡片与任务清单的展示规则。
 *
 * 单独一份而不是散在组件里：这些规则（同一份 plan 只画最后一张、摘要行取哪个参数）
 * 决定的是"一屏里出现几张卡片"，改动会直接改变对话的可读性，值得放在一处看得见。
 */

export const TOOL_LABELS = {
  bash: '执行命令',
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  task_plan: '任务清单',
  workstation_browser: '浏览器',
  // 没有这一条时卡片显示的是原始工具名，用户看到 `skill_save` 只能自己猜
  skill_save: '保存技能',
  artifact: '作品',
}

export const TOOL_STATUS_TEXT = { running: '执行中', done: '完成', error: '失败', aborted: '未完成' }

/** 工具名 → 图标。认不出来的给个通用终端图标，别留空位 */
export const TOOL_ICONS = {
  bash: 'terminal',
  read: 'file',
  write: 'pencil',
  edit: 'pencil',
  task_plan: 'tasks',
  workstation_browser: 'globe',
  skill_save: 'puzzle',
  artifact: 'app-window',
}

/** 摘要行：一眼看出这次调用在干什么，不用展开 */
export function toolBrief(name, args = {}) {
  const first = (value) => String(value || '').split('\n')[0]
  if (name === 'bash') return first(args.command)
  if (name === 'read' || name === 'write' || name === 'edit') return args.path || args.file_path || ''
  if (name === 'workstation_browser') return [args.action, args.url].filter(Boolean).join(' ')
  if (name === 'skill_save') return args.dir || ''
  // 文件内容可能几百 KB，绝不能落到下面那个 JSON.stringify —— 那会把整份作品
  // 拼成一行塞进摘要，卡片直接卡住
  if (name === 'artifact') {
    const what = args.title || args.path || (args.files || []).map((file) => file.path).join(' ') || args.id || ''
    return [args.action, what].filter(Boolean).join(' ')
  }
  const keys = Object.keys(args)
  if (!keys.length) return ''
  return first(JSON.stringify(args))
}

/** 从 task_plan 的结果文本里反解 plan（工具回的是 `{ok:true, plan:{…}}` 的 JSON 串） */
export function readPlan(text) {
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed?.plan?.tasks ? parsed.plan : null
  } catch {
    return null
  }
}

/** 工具还在跑时没有结果，先拿入参预览（形状与结果里的 plan 一致，只是没有 id） */
export function normalizePlan(args) {
  if (!Array.isArray(args?.tasks)) return null
  return { id: args.id || '_running', title: args.title || '', tasks: args.tasks }
}

/**
 * 同一份 plan 只画最后一张。
 *
 * 模型每完成一步就重调 task_plan 传全量清单，直接按调用逐个渲染会堆出一摞快照。
 * 按 plan.id 取最后一次，界面上就是"一张清单实时打勾"。
 */
export function planKeepIndexes(blocks) {
  const keep = new Map()
  blocks.forEach((block, index) => {
    if (block.type !== 'tool' || block.toolName !== 'task_plan') return
    const plan = readPlan(block.preview) || (block.status === 'running' ? normalizePlan(block.args) : null)
    if (plan?.id) keep.set(plan.id, index)
  })
  return new Set(keep.values())
}

/**
 * 一次 artifact 调用该不该画成作品卡片。
 *
 * 三种情况**不画**，让它退回普通的工具卡片：
 *   - `read`：那是模型自己读回正文，没有产出，画一张卡片会让人以为又生成了一份
 *   - 失败：`{ok:false}` 时该看到的是错误原文
 *   - 结果解析不出来：宁可显示原始工具卡片，也不要画一张空卡
 *
 * 还在跑的时候先画一张占位卡：create 的正文是整段发出去的，
 * 大一点的作品要好几秒，这几秒里对话里什么都没有会让人以为卡住了。
 */
export function readArtifactCard(block) {
  if (block.args?.action === 'read') return null

  if (block.status === 'running') {
    return {
      pending: true,
      title: block.args?.title || '正在生成…',
      kind: block.args?.kind || 'code',
      action: block.args?.action || 'create',
      // 边生成边显示文件名：多文件作品要好几秒，这几秒里让人看到它在铺哪些文件
      files: (block.args?.files || []).map((file) => file.path).filter(Boolean),
    }
  }

  try {
    const parsed = JSON.parse(block.preview)
    if (!parsed?.ok || !parsed.artifact?.id) return null
    return { ...parsed.artifact, action: block.args?.action || 'create' }
  } catch {
    // 结果被截断（preview 有长度上限）时会走到这儿
    return null
  }
}

/**
 * 一轮里的 block 按**到达顺序**排开，不把工具收拢到顶部。
 *
 * 模型常常先说一句"我先看看环境"再动手，把那句挪到工具下面读起来就是倒的。
 * 顺序渲染出来就是"说 → 做 → 说结论"，跟它实际干活的次序一致。
 *
 * 返回值里带上 `plan`：是 task_plan 且该画的那一次，就换成清单卡片。
 */
export function layoutBlocks(blocks = []) {
  const planIndexes = planKeepIndexes(blocks)
  const out = []
  blocks.forEach((block, index) => {
    if (block.type === 'tool' && block.toolName === 'task_plan') {
      if (!planIndexes.has(index)) return
      const plan = readPlan(block.preview) || normalizePlan(block.args)
      if (plan) { out.push({ kind: 'plan', key: `plan-${index}`, plan }); return }
    }
    /**
     * 作品**不做 task_plan 那样的去重**。
     *
     * 同一份计划被反复更新时，用户要的是"一张清单实时打勾"；而作品的每一次调用
     * 是一个各不相同的事件（建了 v1、这里改成了 v2），按时间摆开读起来才是
     * 一条能对上号的线索。
     */
    if (block.type === 'tool' && block.toolName === 'artifact') {
      const card = readArtifactCard(block)
      if (card) { out.push({ kind: 'artifact', key: `artifact-${index}`, card }); return }
    }
    out.push({ kind: block.type, key: `${block.type}-${index}`, block })
  })
  return out
}
