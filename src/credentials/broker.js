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

/**
 * 模型来自**数据库里管理员配的那份清单**（LLM_MODE=db）。
 *
 * ── 与 direct 的区别 ────────────────────────────────────────────────────
 *
 * 两者都用"部署自己的 key"而不是用户的 llmToken，但 direct 被生产拒绝，
 * 这个不。区别不在 key 上，在**能不能回答"这次调用是谁发起的"**：
 *
 *   direct  一个 base URL + 一把 key 写在环境变量里，全体共用，改要重启；
 *   db      一条记录一个模型、各自带 key，可用范围按用户分组收口，
 *           而每一次 run 的用量都按 username + model_id 落进 ap_usage。
 *
 * 也就是说，分账、审计、限流的**主体仍然是用户**，只有上游那一侧看到的是
 * 一把共享的 key。这个残留边界写在 src/models/model-store.js 的文件头里。
 *
 * ── 为什么不缓存 ────────────────────────────────────────────────────────
 *
 * llminfo 那条路上的缓存是为了不让每条消息都去打一次外部 HTTP。这里的"上游"
 * 是本地数据库里十几行记录，一次查询是亚毫秒级 —— 加缓存换不到什么，
 * 却会带来一个真实的坏处：管理员在控制台停用一个模型之后，
 * **它还能被继续用上几分钟**，而那恰恰是停用这个动作最需要立刻生效的场景
 * （配错了、key 泄了、上游欠费了）。
 *
 * @param {object} params.modelStore src/models/model-store.js
 * @param {object} params.users      账号 store（拿这个人的 groupId）
 */
export function createDbBroker({ modelStore, users, logger }) {
  return {
    async getLlmAccess(subject) {
      /**
       * 分组取不到就按"无分组"处理，而不是抛错。
       *
       * 走到这儿的主体不一定是账号库里的人 —— AUTH_MODE 不是 password 时
       * （比如平台 SSO 透传），username 是外部给的，账号库里根本没有这条记录。
       * 那种部署照样应该能用"没有限制可用范围"的那些模型。
       */
      const account = await users?.get(subject.username).catch(() => null)
      const models = await modelStore.resolveForGroup(account?.groupId || '')

      if (!models.length) {
        logger?.warn?.('这个用户没有任何可用模型', {
          username: subject.username,
          groupId: account?.groupId || '(无分组)',
        })
      }

      return {
        models,
        // 每条记录自己带 key，这个字段只是 run-service 的兜底（`llm.key || access.apiKey`）
        apiKey: models[0]?.key || '',
        user: null,
      }
    },

    /** 没有缓存，也就没有什么要失效的。留着这个方法是为了满足 broker 的契约 */
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
