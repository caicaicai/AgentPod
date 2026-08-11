/**
 * AP工具装配。
 *
 * 每个 run 现造一套：工具的 execute 闭包里带着这一个用户的上下文，
 * 所以工具集本身就是 run 级的，不存在"共享一份工具但里面藏着别人凭据"的可能。
 *
 * **能力闸门**：一个后端还没上云的工具，不要注册。
 * 注册了只会让模型反复尝试、每次拿回一句 501，白烧 token 又把对话带偏。
 * 宁可它不知道有这个能力，也不要它以为有、然后失败。
 */
import { createToolContext } from './context.js'
import { loadPlugins } from './plugin-api.js'
import { taskPlanPlugin } from './task-plan.js'
import { skillSavePlugin } from './skill-save.js'
import { workstationBrowserPlugin } from './workstation-browser.js'
import { memoryPlugin } from './memory.js'
import { cronPlugin } from './cron.js'

/**
 * 已完成迁移的插件，以及各自的启用条件。
 * `requires` 里的能力有一个不满足就不注册，并在日志里说清楚缺什么。
 */
const PLUGIN_REGISTRY = [
  { plugin: taskPlanPlugin, requires: [] }, // 纯本地，无依赖
  { plugin: memoryPlugin, requires: ['memory'] }, // 要 MEMORY_ENABLED + DATA_DIR
  { plugin: cronPlugin, requires: ['cron'] }, // 要 CRON_ENABLED + DATA_DIR
  { plugin: skillSavePlugin, requires: ['skills'] }, // 要用户工作空间（USER_WORKSPACE_ROOT）
  { plugin: workstationBrowserPlugin, requires: ['browser'] }, // 要沙盒提供浏览器能力
]

function describeMissing(requires, capabilities) {
  return requires.filter((capability) => !capabilities[capability])
}

/**
 * @returns {{tools: Array, ctx: object, skipped: Array}}
 */
export function buildApTools({
  runId, username, credential, logger, config = {}, sandboxSession = null, workspace = null,
  memory = null, crons = null, projectId = '',
}) {
  const ctx = createToolContext({
    runId,
    username,
    credential,
    logger,
    sandboxSession,
    workspace,
    memory,
    crons,
    projectId,
    browserCookieDomains: config.browserCookieDomains,
  })

  const capabilities = {
    credential: ctx.credentialFacts.present,
    browser: ctx.browser.available,
    skills: ctx.skills.available,
    memory: ctx.memory.available,
    cron: ctx.crons.available,
  }

  const enabled = []
  const skipped = []
  for (const entry of PLUGIN_REGISTRY) {
    const missing = describeMissing(entry.requires, capabilities)
    if (missing.length) {
      skipped.push({ plugin: entry.plugin.id, missing })
      continue
    }
    enabled.push(entry.plugin)
  }

  const { tools, hooks } = loadPlugins(enabled, { ctx, config })

  if (skipped.length) {
    logger.debug?.('部分工具因缺少前置能力未注册', { runId, username, skipped })
  }

  /**
   * 钩子**不在这里**套上去，而是回传给 buildTools。
   *
   * openclaw 的 before_tool_call 是全局的 —— ap-skills 就是靠它否决 `browser`
   * 这个自己没注册过的工具。只套在插件工具上等于把语义悄悄改窄了，
   * 而"钩子对某些工具不生效"这种事从日志里根本看不出来。
   */
  return { tools, ctx, skipped, hooks }
}

export { createToolContext, describeCredential } from './context.js'
export { jsonResult, textResult, normalizeToolResult, createPluginApi, loadPlugins, applyToolHooks, hasToolHooks } from './plugin-api.js'
