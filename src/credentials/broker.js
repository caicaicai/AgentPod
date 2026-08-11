/**
 * Credential Broker —— 凭据的唯一出口。
 *
 * 现阶段是"透传"实现：用调用方随请求带来的登录态去换模型访问权。
 * 它有个天生的天花板：**只在人坐在浏览器前面时成立**。定时任务跑的时候没有浏览器、
 * 没有人在场，转发无从谈起 —— 所以后面必须换成"服务端代持"（tokenGrant/refreshToken 续期，
 * 见 doc/云端Agent方案-总体设计.md §6）。接口在这里先定好，换实现时上层不用动。
 *
 * 硬规则：真实凭据只在服务端流转，**绝不下发给浏览器**（模型清单只返回可公开字段）。
 */
/**
 * @typedef {Object} CredentialBroker
 * @property {(subject) => Promise<{models: Array, apiKey: string, user: object|null, stale?: boolean}>} getLlmAccess
 * @property {(subject) => void} invalidate
 */

export function createPassthroughBroker({ llmInfoClient, logger }) {
  return {
    /** 取该主体可用的模型清单与调用凭据 */
    async getLlmAccess(subject) {
      const info = await llmInfoClient.get({ credential: subject.credential })
      if (info.warning) logger.warn('llminfo 退回过期缓存', { username: subject.username, reason: info.warning })
      return { models: info.llms, apiKey: info.llms[0]?.key || '', user: info.user, stale: Boolean(info.stale) }
    },

    invalidate(subject) {
      llmInfoClient.invalidate(subject.credential)
    },
  }
}

/**
 * 直连一个 OpenAI 兼容端点的模型。**只用于本地做真模型联调。**
 *
 * ── 为什么要有 ────────────────────────────────────────────────────
 *
 * 从前只有两种模式：`platform`（真模型，但要连 llminfo）
 * 和 `faux`（假模型，根本不推理）。本地想验证"真模型到底会不会用这些技能"时，
 * 前者常常连不上、后者答非所问 —— 于是"端到端测过了"这句话里，
 * **最关键的那一环恰恰是假的**。这个模式就是把那一环补上：
 * 给一个 base URL + key + 模型名，其余链路全部照旧。
 *
 * ── 为什么生产必须拒绝 ────────────────────────────────────────────
 *
 * 这里的 key 是**一把静态的、所有人共用的**钥匙。而整套隔离模型的前提是
 * "每个用户用自己的 llmToken"（隔离契约 #1：凭据只属于那一个 run）。
 * 共用一把钥匙意味着计费、限流、审计全都归到同一个主体上，
 * 也就没法回答"这次调用是谁发起的"。所以 config.js 里对它的拒绝是硬的。
 */
export function createDirectBroker({ config }) {
  const { baseUrl, apiKey, models } = config.llm.direct

  return {
    async getLlmAccess() {
      return {
        models: models.map((model) => ({
          model,
          server: baseUrl,
          key: apiKey,
          contextWindow: config.llm.direct.contextWindow,
          maxTokens: config.llm.direct.maxTokens,
          input: config.llm.direct.input,
          reasoning: config.llm.direct.reasoning,
        })),
        apiKey,
        user: null,
      }
    },
    invalidate() {},
  }
}

/** 离线开发用：不碰任何外部服务 */
export function createFauxBroker({ fauxModel }) {
  return {
    async getLlmAccess() {
      return { models: [{ model: fauxModel.id, server: fauxModel.baseUrl, key: '', contextWindow: fauxModel.contextWindow, maxTokens: fauxModel.maxTokens, input: ['text'], reasoning: false }], apiKey: '', user: null }
    },
    invalidate() {},
  }
}
