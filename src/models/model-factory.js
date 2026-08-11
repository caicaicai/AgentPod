/**
 * llminfo 的一条记录 → pi 的 Model 对象。
 *
 * 字段映射与桌面端 `modules/ap/src/main/runtime/openclaw-manager.js:buildPlatformModelPatch()`
 * 保持一致，避免出现"客户端一套、云端一套"的模型行为差异。
 *
 * 注意 key（用户的 llmToken）**不放进 Model**：pi 通过 ModelRegistry.getApiKeyAndHeaders(model)
 * 从 AuthStorage 按 provider 取，我们在每个 run 里用 AuthStorage.inMemory() 注入，
 * 这样凭据只活在那一个 run 的内存里（隔离契约 #1）。
 */
export const AP_PROVIDER_ID = 'ap-gateway'

/**
 * `input` 里有没有 `image`，决定的是**图片到底会不会被发给模型**。
 *
 * pi 在 openai-completions 这一层有一句
 *     if (hasImages && model.input.includes("image"))
 * 不满足就把工具结果里的 image part **静默丢掉**，只发文本。现象非常具有迷惑性：
 * 截图工具回"成功、11622 bytes"，模型却说"截图拿到了但我看不见"，
 * 而两边日志都正常。实测对照过：同一段会话，input 是 ['text'] 时发出去的请求体里
 * 没有 image_url，加上 'image' 就有了。
 *
 * 所以当平台的 llminfo 没把某个多模态模型标出来时，需要能在部署侧兜一下 ——
 * 这比等平台改元数据快得多，而标错的代价只是"发过去模型不认"。
 */
export function buildModel(llm = {}, { imageCapableModels = [], maxTokensField = '' } = {}) {
  const modelId = String(llm.model || llm.id || '').trim()
  if (!modelId) throw new Error('模型记录缺少 model 字段')

  const declared = Array.isArray(llm.input) && llm.input.length ? llm.input : ['text']
  const forced = imageCapableModels.includes(modelId) && !declared.includes('image')
  const input = forced ? [...declared, 'image'] : declared

  return {
    id: modelId,
    name: `AP/${modelId}`,
    api: 'openai-completions',
    provider: AP_PROVIDER_ID,
    // OpenAI SDK 会自己拼 /chat/completions
    baseUrl: String(llm.server || llm.baseUrl || '').replace(/\/+$/, ''),
    reasoning: Boolean(llm.reasoning),
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number(llm.contextWindow) || 128000,

    /**
     * 显式声明网关的兼容口味，别让 pi 猜。
     *
     * ── supportsDeveloperRole: false（实测撞出来的）─────────────────────
     *
     * pi 的判断是 `useDeveloperRole = model.reasoning && compat.supportsDeveloperRole`
     * （openai-completions.js:562）。而 `detectCompat` 是**按 baseUrl / provider 白名单**
     * 认"非标准"实现的，我们这个网关不在任何名单里 → 被当成标准 OpenAI →
     * `supportsDeveloperRole: true`。同时 llminfo 把三个模型全标了 `reasoning: true`。
     * 两个条件一凑，系统提示就被发成了 `role: "developer"`。
     *
     * 上游原话：
     *   messages[0] has invalid role: developer, must be one of [user, assistant, system, tool]
     * 那是 `developer` 出现之前的 OpenAI schema —— 这个上游只认老的四个角色。
     *
     * 表现极具迷惑性：网关把它包成 `400 模型服务调用失败` 回来，看着像"服务不稳定"，
     * 实际上是**每一条请求都发错了**，与稳定性无关。
     *
     * ── 其余几项 ────────────────────────────────────────────────────────
     *
     * 同一个 detectCompat 还决定了 `store: false`、`reasoning_effort`、以及
     * `max_completion_tokens`（而不是 `max_tokens`）。这几项**目前没有证据说上游不认**
     * —— 校验器在 messages[0] 就退出了，后面的字段还没轮到检查。
     * 既然上游用的是老 schema，它们是下一批嫌疑人，所以留了开关（见 llm.maxTokensField）
     * 而不是直接改：改一个本来就工作的字段，是在用一个未知换另一个未知。
     */
    compat: {
      supportsDeveloperRole: false,
      // 留空 = 用 pi 的探测结果。上游若报 max_completion_tokens 相关的 400，设成 max_tokens
      ...(maxTokensField ? { maxTokensField } : {}),
    },

    /**
     * 平台没声明就**整个字段不发**，让网关用自己的默认值。
     *
     * 以前这里兜底 `|| 4096` —— 一个我们凭空编出来的、对 2026 年的思维链模型明显偏小的数。
     * 撞上限的表现极其难认：模型输出在中途被砍断，而断点往往落在**工具参数中间**，
     * 于是我们收到的是 `{"path":"x.py"}`（少了 edits）或者 content 停在 `print("接口返回`。
     * 看上去像模型犯傻，其实是被我们掐了。
     *
     * 注意不能写成 0：pi 的 model-registry 会对 `maxTokens <= 0` 直接抛
     * "invalid maxTokens"。要的是这个键不存在 —— pi 那边是 `if (options?.maxTokens)`
     * 才拼 max_tokens 字段。
     *
     * 顺带说明后端一侧：workers/llminfo.lua 走 modules/llm_models.lua 的 pick_params，
     * `maxTokens = entry.maxTokens or DEFAULT_MAX_TOKENS(8192)` —— 所以正常情况下
     * 这里总能拿到值，走不到省略分支。真走到了，说明 llminfo 的形状变了，该看日志。
     */
    ...(Number(llm.maxTokens) > 0 ? { maxTokens: Number(llm.maxTokens) } : {}),
  }
}

export function pickModel(llms, requestedId) {
  if (!Array.isArray(llms) || !llms.length) return null
  if (!requestedId) return llms[0]
  return llms.find((llm) => llm.model === requestedId) || null
}

/** 挑一个支持图片的模型，供多模态场景使用（对齐桌面端 pickImageModelId） */
export function pickImageModel(llms) {
  return (llms || []).find((llm) => Array.isArray(llm.input) && llm.input.includes('image')) || null
}
