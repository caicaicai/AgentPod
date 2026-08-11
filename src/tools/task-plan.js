/**
 * task_plan —— 任务清单。移植自 `modules/ap/extensions/ap-skills/index.mjs`。
 *
 * 这个工具不落盘、不出网、不碰凭据：模型每次传**全量**任务列表，工具规范化后原样回流，
 * 渲染端看到 tool_result 里的 `plan` 就合成/原地更新一张清单卡片。
 * 同一份计划复用同一个 id，渲染端按 id 只显示最新一次 —— 所以是"单张实时勾选"而不是堆一摞快照。
 *
 * 因为它无依赖，所以是第一个完成迁移的工具：可以用它验证工具装配链路本身是通的。
 */
import { jsonResult } from './plugin-api.js'

const TASK_STATUSES = ['pending', 'in_progress', 'completed']

const DESCRIPTION = [
  '维护并展示一份「任务清单」，会在对话里渲染成可勾选的待办列表（类似 Cursor / Claude Code 的任务清单）。',
  '用于：当需求较复杂、需要分多步完成时，先用本工具把步骤列成清单；之后每开始或完成一步，再次调用本工具更新对应任务的状态，对话里的清单卡片会原地刷新、把完成项打勾。',
  '**每次调用都要传完整的任务列表（全量，不是增量）**：把所有任务连同各自最新的 status 一起传回。',
  '**同一份计划在多次更新时必须复用同一个 id**：第一次调用可不传 id（系统会生成并在返回里给出），之后每次更新都带上同一个 id，这样清单才会原地更新而不是新开一张。',
  'status 取值：pending=未开始 / in_progress=进行中（同一时刻最多一个进行中）/ completed=已完成。',
  '推荐节奏：先一次性把全部步骤建成 pending；开始某步时把它改 in_progress；做完立刻改 completed 并把下一步改 in_progress。',
  '返回 { ok:true, plan:{ id, title, total, completed } }，其中 id 用于后续更新。',
  '重要：本工具已经把清单画出来了，正文里不要再把任务列表逐条重复贴一遍。',
].join(' ')

const SCHEMA = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: '计划 id。首次创建可不传（系统生成并在返回里给出）；之后更新同一份计划必须复用这个 id。',
    },
    title: {
      type: 'string',
      description: '清单标题，可选，如「实现计划」。不传则显示「任务清单」。',
    },
    tasks: {
      type: 'array',
      description: '完整任务列表（每次都要传全量，含所有任务的最新 status）。',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '任务描述，简短一句。' },
          status: {
            type: 'string',
            enum: TASK_STATUSES,
            description: 'pending=未开始 / in_progress=进行中 / completed=已完成。',
          },
        },
        required: ['content', 'status'],
      },
    },
  },
  required: ['tasks'],
}

export function registerTaskPlanTool(api) {
  api.registerTool({
    name: 'task_plan',
    label: '任务清单',
    description: DESCRIPTION,
    parameters: SCHEMA,
    async execute(_toolCallId, params) {
      const rawTasks = Array.isArray(params?.tasks) ? params.tasks : null
      if (!rawTasks || rawTasks.length === 0) {
        return jsonResult({ ok: false, error: 'tasks 必填，且至少包含一个任务' })
      }

      const tasks = []
      for (const task of rawTasks) {
        const content = String(task?.content || '').trim()
        if (!content) continue
        let status = String(task?.status || 'pending').toLowerCase()
        if (!TASK_STATUSES.includes(status)) status = 'pending'
        tasks.push({ content, status })
      }
      if (tasks.length === 0) {
        return jsonResult({ ok: false, error: 'tasks 里没有有效任务（content 不能为空）' })
      }

      const id =
        String(params?.id || '').trim() ||
        `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const title = String(params?.title || '').trim()
      const completed = tasks.filter((task) => task.status === 'completed').length

      // plan 字段是渲染端识别任务清单卡片的正信号（对应桌面端 utils/taskPlan.js）
      return jsonResult({ ok: true, plan: { id, title, tasks, total: tasks.length, completed } })
    },
  })
}

export const taskPlanPlugin = {
  id: 'ap-task-plan',
  register: registerTaskPlanTool,
}
