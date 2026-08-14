/**
 * AP 平台模型清单客户端（GET {SPEED_API_BASE}/ap/llminfo）。
 *
 * 一次返回三样东西：用户信息、模型清单、该用户的 llmToken。
 *
 * 两个来之不易的设计点：
 *   1. **缓存键是凭据主体，不是业务用户名。** 上游认凭据，不认我们传的 username。
 *      早期按 username 缓存 → 页面只给左边用户预热 → 右边用户每条消息都要重打上游 →
 *      上游一抖就表现为"一个对话框正常、另一个提示需要登录"的诡异不对称。
 *   2. **stale-while-error**：上游失败但有过期缓存时退回旧数据。模型清单对新鲜度不敏感，
 *      但"对话说到一半突然说你没登录"对用户是灾难。
 */
import { fingerprint } from '../logger.js'
import { platformFailureToError } from '../platform/http.js'

/** 后端已把 server 结尾的 /chat/completions 去掉，这里再兜一次底 */
function normalizeServer(url) {
  return String(url || '').trim().replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '')
}

export function createLlmInfoClient({ config, platform, logger }) {
  const cache = new Map() // credentialFingerprint -> { at, user, llms }
  const ttl = config.llm.cacheTtlMs

  async function fetchFresh(credential) {
    const result = await platform.getJson('/ap/llminfo', { credential })
    if (!result.ok) return { ok: false, error: result.error, failure: result }

    const llms = (Array.isArray(result.data?.llms) ? result.data.llms : [])
      .filter((item) => item && item.model && item.key && item.server)
      .map((item) => ({ ...item, server: normalizeServer(item.server) }))

    if (!llms.length) return { ok: false, error: '平台没有返回可用模型', failure: result }
    return { ok: true, user: result.data?.user || null, llms }
  }

  return {
    /** 返回 { llms, user, cached, stale, warning }；失败抛 AppError */
    async get({ credential, force = false }) {
      const key = fingerprint(credential)
      const hit = cache.get(key)

      if (!force && hit && Date.now() - hit.at < ttl) {
        return { llms: hit.llms, user: hit.user, cached: true }
      }

      const fresh = await fetchFresh(credential)
      if (fresh.ok) {
        cache.set(key, { at: Date.now(), user: fresh.user, llms: fresh.llms })
        return { llms: fresh.llms, user: fresh.user, cached: false }
      }

      if (hit) {
        const ageSec = Math.round((Date.now() - hit.at) / 1000)
        return {
          llms: hit.llms,
          user: hit.user,
          cached: true,
          stale: true,
          warning: `llminfo 本次失败（${fresh.error}），已退回 ${ageSec}s 前的缓存`,
        }
      }

      logger.warn('llminfo 获取失败且无缓存可退', { credential, reason: fresh.error })
      throw platformFailureToError(fresh.failure || { error: fresh.error })
    },

    invalidate(credential) {
      if (credential) cache.delete(fingerprint(credential))
      else cache.clear()
    },

    stats() {
      return { entries: cache.size, ttlMs: ttl }
    },
  }
}

/** 只暴露可公开字段 —— llmToken 绝不下发给浏览器 */
export function toPublicModels(llms) {
  return (llms || []).map((llm) => ({
    id: llm.model,
    /**
     * 给人看的名字，只有 LLM_MODE=db 那条路上才有（管理员在控制台起的）。
     * 空的时候界面退回显示 id —— 平台/direct 模式下本来就只有 id 这一个名字。
     */
    name: llm.label || '',
    reasoning: Boolean(llm.reasoning),
    input: Array.isArray(llm.input) ? llm.input : ['text'],
    contextWindow: Number(llm.contextWindow) || 0,
    maxTokens: Number(llm.maxTokens) || 0,
  }))
}
