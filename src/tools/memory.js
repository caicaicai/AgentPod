/**
 * memory —— 让模型自己读写长期记忆。
 *
 * ── 为什么光有"自动抓取"还不够 ──────────────────────────────────────────
 *
 * 自动抓取（src/memory/capture.js）是被动的：它在一轮结束后猜哪些值得记。
 * 但用户经常会**显式**表达："记住我以后都用飞书"、"忘了我上次说的那个偏好"。
 * 这类话必须当场生效、当场确认 —— 靠猜的那条路既延迟又不可靠，用户说完看不到
 * 任何反馈，只能下次再试一遍。
 *
 * 反过来，检索也需要它：记忆按上限截断后进系统提示，被截掉的那部分模型看不到。
 * 有了 search，它至少能主动去翻。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 *
 * 作用域（哪个用户、哪个项目）由 ctx 决定，**参数里没有 username** —— 模型没有任何
 * 途径写到别人的记忆里。这是隔离契约 #4 在工具层的落法。
 */
import { jsonResult } from './plugin-api.js'

const DESCRIPTION = [
  '读写关于这位用户的**长期记忆**（跨会话保留的事实清单）。',
  '什么时候用：',
  '① 用户明确要求记住/忘掉某件事（"记住我…"、"以后都…"、"别再…"）——立刻调用，不要只是口头答应；',
  '② 你需要回忆系统提示里没写全的历史信息时，用 action="search" 检索；',
  '③ 对话中出现了明显会长期成立的事实（职责、长期项目、稳定偏好），可以主动 remember。',
  '',
  'action 取值：',
  '- search：按关键词检索，返回匹配的记忆条目。',
  '- read：读出当前全部记忆原文。',
  '- remember：追加事实（facts 数组，一条一句，第三人称陈述）。重复的会自动去重。',
  '- forget：删掉包含指定文本的条目（text 参数）。',
  '',
  '不要记：密码/token 等凭据、一次性琐事、可以随时查到的机制细节。',
  '当前会话如果属于某个项目，读写的是**该项目的**记忆；scope="personal" 可强制写进个人记忆。',
].join('\n')

const SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['search', 'read', 'remember', 'forget'],
      description: 'search=检索 / read=读全文 / remember=追加事实 / forget=删除条目',
    },
    query: { type: 'string', description: 'action=search 时的关键词（多个词之间是「与」的关系）' },
    facts: {
      type: 'array',
      items: { type: 'string' },
      description: 'action=remember 时要记住的事实，一条一句，第三人称。例：["偏好用飞书沟通"]',
    },
    text: { type: 'string', description: 'action=forget 时要删掉的条目内容（包含匹配即可）' },
    scope: {
      type: 'string',
      enum: ['auto', 'personal'],
      description: 'auto=当前作用域（在项目里就是项目记忆，默认）/ personal=强制写进个人记忆',
    },
  },
  required: ['action'],
}

export function registerMemoryTool(api) {
  api.registerTool({
    name: 'memory',
    label: '长期记忆',
    description: DESCRIPTION,
    parameters: SCHEMA,
    async execute(_toolCallId, params) {
      const memory = api.ctx.memory
      if (!memory?.available) return jsonResult({ ok: false, error: '本部署未启用长期记忆' })

      const action = String(params?.action || '').trim()
      const personal = params?.scope === 'personal'

      if (action === 'search') {
        const query = String(params?.query || '').trim()
        if (!query) return jsonResult({ ok: false, error: 'search 需要 query' })
        const hits = await memory.search(query, 20)
        return jsonResult({ ok: true, scope: memory.scope, count: hits.length, memories: hits })
      }

      if (action === 'read') {
        const own = await memory.read()
        // 项目会话里把个人那一份也带上：不然"我是谁"这种问题在项目里反而答不上来
        const mine = memory.scope === 'project' ? await memory.readPersonal() : null
        return jsonResult({
          ok: true,
          scope: memory.scope,
          content: own.content,
          count: own.count,
          ...(mine ? { personal: { content: mine.content, count: mine.count } } : {}),
        })
      }

      if (action === 'remember') {
        const facts = (Array.isArray(params?.facts) ? params.facts : [])
          .map((fact) => String(fact || '').trim())
          .filter(Boolean)
        if (!facts.length) return jsonResult({ ok: false, error: 'remember 需要非空的 facts 数组' })
        const added = personal ? await memory.rememberPersonal(facts) : await memory.remember(facts)
        return jsonResult({
          ok: true,
          added,
          scope: personal ? 'personal' : memory.scope,
          // added=0 不是失败，是"这些都已经记过了"。不说清楚模型会重试几次
          note: added ? undefined : '这些事实已经在记忆里了（自动去重），无需重复记录',
        })
      }

      if (action === 'forget') {
        const text = String(params?.text || '').trim()
        if (!text) return jsonResult({ ok: false, error: 'forget 需要 text' })
        const removed = await memory.forget(text)
        return jsonResult({
          ok: true,
          removed,
          note: removed ? undefined : '没有匹配到任何条目，记忆未改动',
        })
      }

      return jsonResult({ ok: false, error: `未知 action：${action}` })
    },
  })
}

export const memoryPlugin = {
  id: 'ap-memory',
  register: registerMemoryTool,
}
