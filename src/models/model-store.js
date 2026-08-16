/**
 * 部署自己的模型清单：**存在数据库里，由管理员在控制台维护**。
 *
 * ── 它解决的是哪一个问题 ────────────────────────────────────────────────
 *
 * 在它之前，"这个部署有哪些模型"只有三种答案，没有一种是自助的：
 *
 *   LLM_MODE=platform  每个用户各自去上游 llminfo 换一份清单 —— 加模型要平台改；
 *   LLM_MODE=direct    一个 base URL + 一把 key 写在环境变量里，改一次要重启，
 *                      而且**全体共用一把 key**，所以生产直接拒绝启动；
 *   LLM_MODE=faux      假模型。
 *
 * 于是"我想接自己的模型网关，并且给不同的人开不同的模型"这件最普通的需求，
 * 只能靠改环境变量 + 重启，还做不到分人。这个 store 就是那份清单的正经落点：
 * 一条记录一个模型，改完立刻生效（下一次 getLlmAccess 就读到了），
 * 每条记录自己带 key，可用范围按**用户分组**收口（见 src/identity/group-store.js）。
 *
 * ── 关于 key 的边界，必须说清楚 ─────────────────────────────────────────
 *
 * 这里的 key 是**管理员配的**，因此在同一个模型上是所有人共用的一把 ——
 * 这与 LLM_MODE=direct 被生产拒绝的理由是同一件事。区别在于代价被补上了：
 *
 *   1. 用量按人记账。`ap_usage` 每一行都带 username + model_id（见 schema.sql），
 *      所以"谁烧了多少、烧在哪个模型上"照样答得出来 —— direct 模式当年缺的
 *      正是这个，而不是缺一把 key。
 *   2. 可用范围按分组收口。不是所有人都能看到所有模型，也就不存在"一把 key
 *      被全体无差别使用"。
 *   3. key 不下发浏览器（接口只回掩码），且可以加密入库（LLM_CONFIG_SECRET）。
 *
 * 仍然做不到的是**上游侧的分账**：上游看到的是一把 key，它那边的账单只有一行。
 * 需要上游按人分账的部署，该用 platform 模式。
 *
 * ── 为什么用通用 KV 而不是新建一张表 ────────────────────────────────────
 *
 * 读写模式就是"按 id 存一个小 JSON + 全量列出"，没有任何按字段查询/排序分页的
 * 需求（一个部署里的模型是十几条量级，不是十万条）。schema.sql 的注释把这条
 * 判据写死了：长出自己的查询需求时再拆表，那时候拆才是有依据的。
 * 顺带的好处是**不需要改表结构**，老部署升上来直接能用。
 */
import { randomUUID } from 'node:crypto'

import { createSecretBox, maskKey } from '../credentials/secret-box.js'
import { PAGE_DEFAULT, finishPage } from '../persistence/page.js'
import { requireStorage } from '../persistence/storage.js'

/** ap_kv 里的集合名。与 accounts / user_groups 并列，都是不按用户分区的全局集合 */
const COLLECTION = 'llm_models'

const NAME_MAX = 64
const MODEL_ID_MAX = 128
/** 与 ap_usage.model_id 的列宽一致 —— 超了会被静默截断，然后用量对不上号 */
const URL_MAX = 512
const KEY_MAX = 512

/** pi 认得的两种输入模态。别的字符串传进去只会让上游报一句看不懂的话 */
const INPUT_KINDS = ['text', 'image']

/**
 * 单价的三个字段，**单位统一为「每百万 token」**。
 *
 * ── 为什么单价住在模型记录上 ────────────────────────────────────────────
 *
 * `ap_usage` 每行都带 username + model_id + 三种 token（见 telemetry/usage-store.js
 * 的文件头），唯一缺的就是单价。而单价天然属于"这条模型接的是哪个上游、按什么价"，
 * 与 baseUrl / key 是同一件事的三个面 —— 放在别处（一份独立的价目配置）就会出现
 * "模型改了上游、价没跟着改"这种只在月底对账时才发现的错位。
 *
 * ── 为什么是"每百万"而不是"每 token" ────────────────────────────────────
 *
 * 上游的价目表全是按百万报的（$3.00 / 1M input）。让管理员把它换算成
 * 0.000003 再填，等于把一次每人都要做、做错了还看不出来的乘法塞进配置流程 ——
 * 而填错一个数量级的表现是账单差 1000 倍，且界面上完全看不出异常。
 *
 * ── null 与 0 是两回事，必须分开 ────────────────────────────────────────
 *
 * `null` = **没填**（这条模型没定价，算不出钱）；`0` = **填了，就是免费**
 * （自建模型、包月的私有部署）。合成一个值的话，没定价的模型会在账单上显示
 * ¥0.00 —— 那不是"不要钱"，那是"我们不知道"，而这两句话在一张账单上
 * 差别极大。所以未定价一路以 null 传到界面，由界面写"未定价"。
 */
const PRICE_FIELDS = ['priceInput', 'priceOutput', 'priceCacheRead']

/**
 * 单价的上限，纯粹是个手滑闸门。
 *
 * 挡的是把"每 token 的价格"当成"每百万"填反了的那一类（或者多按了几个 0）：
 * 真实单价没有超过每百万一千块的，而一个填成 3000000 的数字会让某一天的账单
 * 变成一串没人看得懂的数字，然后被当成统计代码的 bug 去查。
 */
const PRICE_MAX = 1000

/** 报错文案里那个字段叫什么。回一句"priceCacheRead 不能是负数"等于没说 */
const PRICE_LABELS = {
  priceInput: '输入单价',
  priceOutput: '输出单价',
  priceCacheRead: '缓存读入单价',
}

function trimmed(value, max, field) {
  const text = String(value ?? '').trim()
  if (text.length > max) throw new Error(`${field}不能超过 ${max} 个字符`)
  return text
}

function positiveInt(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.round(number)
}

/**
 * 单价的收口：`null` = 没填，数字 = 填了（含 0）。
 *
 * 空串、null、undefined 全部归到 null —— 表单里那个没动过的输入框回来的是空串，
 * 而它的含义就是"这一项我没填"。**只有真的写了一个数字才叫定价**。
 *
 * 非法输入（负数、NaN、超过 PRICE_MAX）**抛错而不是兜底成 null**：
 * 其余字段兜底是因为它们兜错了顶多行为不对，而单价兜错了会安静地把一条模型
 * 从"定价 3 元"变成"未定价"，账单上少一块钱谁也不会去查配置。
 */
function priceOrNull(value, field) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!text) return null
  const number = Number(text)
  if (!Number.isFinite(number)) throw new Error(`${field}必须是数字`)
  if (number < 0) throw new Error(`${field}不能是负数`)
  if (number > PRICE_MAX) throw new Error(`${field}超过 ${PRICE_MAX}（单位是每百万 token，别填成每 token 的价）`)
  return number
}

/**
 * baseUrl 的收口。
 *
 * 只认 http/https，并且**把结尾的 /chat/completions 和多余的斜杠去掉** ——
 * 这是配置里最高频的一个错：管理员从上游文档里复制的往往是完整的
 * `https://x/v1/chat/completions`，而 OpenAI SDK 会自己拼后半段，
 * 于是真实请求打到了 `/v1/chat/completions/chat/completions`，回来一个 404。
 * llminfo 那条路上也做了同样的兜底（见 llminfo-client.js:normalizeServer）。
 */
function normalizeBaseUrl(input) {
  const raw = trimmed(input, URL_MAX, '接口地址')
  if (!raw) throw new Error('接口地址不能为空')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('接口地址不是合法的 URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('接口地址只能是 http:// 或 https://')
  }
  return raw.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '')
}

function normalizeInput(value) {
  const list = Array.isArray(value) ? value : ['text']
  const picked = INPUT_KINDS.filter((kind) => list.includes(kind))
  // text 是底线：一个连文本都不收的模型没有任何用处，多半是前端传了个空数组
  return picked.includes('text') ? picked : ['text', ...picked]
}

/**
 * 从一条记录里读出三个单价，外加两个**算好的判据**。
 *
 * 判据算在这里而不是留给界面各算一遍：
 *   `priced`         能不能算钱（input 或 output 至少填了一个）
 *   `priceComplete`  三项都填了。缺项在计价时按 0 计，界面据此写一句提示 ——
 *                    只填了 input/output 的部署，缓存读入那部分成本会被算成 0，
 *                    那是**低估**，而低估的账单没人会去质疑。
 *
 * ⚠️ 老记录（这个字段上线之前建的）里三项都不存在，读出来是 null，
 * 于是它们表现为"未定价" —— 那正是事实，不必迁移。
 */
function readPrices(record) {
  const prices = {}
  for (const field of PRICE_FIELDS) {
    const value = record?.[field]
    prices[field] = typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  return {
    ...prices,
    priced: prices.priceInput !== null || prices.priceOutput !== null,
    priceComplete: PRICE_FIELDS.every((field) => prices[field] !== null),
  }
}

/**
 * 一条记录 → 给浏览器看的形状。
 *
 * **key 只回掩码**，且带一个 `hasKey` 让界面能区分"没配"和"配了但你看不全"。
 * `keyBroken` 是解密失败：那一条在库里还在，但这个进程读不出来 ——
 * 界面上必须写出来，否则管理员看到的是一个"配置齐全却一直调不通"的模型。
 */
function toPublicModel(record, box) {
  let keyMask = ''
  let keyBroken = false
  if (record.key) {
    try {
      keyMask = maskKey(box.open(record.key))
    } catch {
      keyBroken = true
    }
  }
  return {
    id: record.id,
    name: record.name,
    model: record.model,
    baseUrl: record.baseUrl,
    enabled: Boolean(record.enabled),
    groups: Array.isArray(record.groups) ? record.groups : [],
    contextWindow: record.contextWindow,
    maxTokens: record.maxTokens,
    input: normalizeInput(record.input),
    reasoning: Boolean(record.reasoning),
    maxTokensField: record.maxTokensField || '',
    sort: Number(record.sort) || 0,
    ...readPrices(record),
    hasKey: Boolean(record.key),
    keyMask,
    keyBroken,
    createdAt: record.createdAt || 0,
    updatedAt: record.updatedAt || 0,
  }
}

/**
 * 排序：sort 小的在前，同 sort 按创建时间，再同则按 id。
 *
 * 顺序不是装饰 —— **列表的第一个就是没指定模型时用的那个**
 * （见 models/model-factory.js:pickModel）。所以"哪个是默认模型"这件事
 * 必须是管理员能决定的，而不是取决于记录 id 的字典序。
 *
 * ⚠️ 最后那一级 id 是必须的，不是防御性代码：createdAt 是**毫秒**，
 * 而一次脚本化的初始化（或者管理员连点两下）完全可能在同一毫秒里建两条。
 * 那时候前两级全部相等，比较函数返回 0，剩下的顺序就取决于底层的返回顺序 ——
 * 而那是按随机 id 排的。表现是**默认模型在两条记录之间来回跳**，
 * 每次进程重启或换个副本就换一个，谁也复现不了。
 */
function bySort(a, b) {
  const left = Number(a.sort) || 0
  const right = Number(b.sort) || 0
  if (left !== right) return left - right
  const born = (a.createdAt || 0) - (b.createdAt || 0)
  if (born) return born
  return String(a.id).localeCompare(String(b.id))
}

/**
 * @param {object} params
 * @param {object} params.storage 结构化存储后端
 * @param {object} [params.config] 读 config.llm.configSecret（LLM_CONFIG_SECRET）
 */
export function createModelStore({ config = {}, storage, logger = console }) {
  requireStorage(storage, 'createModelStore')
  const map = storage.globalMap(COLLECTION)
  const box = createSecretBox({ passphrase: config?.llm?.configSecret || '' })

  /**
   * 模型 id（发给上游的那个名字）在整个部署内**唯一**。
   *
   * 为什么要这条约束：它是这套东西对外的身份 —— 浏览器选模型传的是它
   * （/v1/models 回的 id 就是它，见 llminfo-client.js:toPublicModels），
   * pickModel 按它匹配，用量台账也按它记账。允许重名的话，
   *   - 用户选了 `gpt-4o`，pickModel 拿到的是**先出现的那条**，而不是他想要的；
   *   - 两条记录的用量在台账里合成一行，再也分不开。
   *
   * 代价是"同一个模型接两个上游"要起两个不同的名字（`gpt-4o` / `gpt-4o-backup`），
   * 那是一次改名，换掉的是上面两个只在生产上才现形的错。
   */
  async function assertModelIdFree(modelId, exceptId = '') {
    const all = await map.all()
    if (all.some((item) => item.model === modelId && item.id !== exceptId)) {
      throw new Error(`模型 ID ${modelId} 已经被另一条配置占用了`)
    }
  }

  /** 新建与修改共用的字段校验。`partial` 时只校验传进来的那些 */
  function normalizeFields(body, { partial = false, current = null } = {}) {
    const next = {}

    if (!partial || body.name !== undefined) {
      const name = trimmed(body.name, NAME_MAX, '名称')
      if (!name && !partial) throw new Error('名称不能为空')
      if (name) next.name = name
    }
    if (!partial || body.model !== undefined) {
      const model = trimmed(body.model, MODEL_ID_MAX, '模型 ID')
      if (!model) throw new Error('模型 ID 不能为空（发给上游的那个名字）')
      next.model = model
    }
    if (!partial || body.baseUrl !== undefined) {
      next.baseUrl = normalizeBaseUrl(body.baseUrl)
    }
    if (!partial || body.contextWindow !== undefined) {
      next.contextWindow = positiveInt(body.contextWindow, current?.contextWindow || 128000)
    }
    if (!partial || body.maxTokens !== undefined) {
      /**
       * 0 是合法的，含义是"这个字段整个不发，让上游用自己的默认值"。
       * 不能兜底成一个我们编出来的数：偏小的上限会把模型的输出在**工具参数中间**
       * 截断，现象是模型"犯傻"而不是"被掐了"（model-factory.js 文件头有完整记录）。
       */
      next.maxTokens = Math.max(0, Math.round(Number(body.maxTokens) || 0))
    }
    if (!partial || body.input !== undefined) {
      next.input = normalizeInput(body.input)
    }
    if (!partial || body.reasoning !== undefined) {
      next.reasoning = Boolean(body.reasoning)
    }
    if (!partial || body.enabled !== undefined) {
      next.enabled = body.enabled === undefined ? true : Boolean(body.enabled)
    }
    if (!partial || body.sort !== undefined) {
      next.sort = Math.round(Number(body.sort) || 0)
    }
    if (!partial || body.maxTokensField !== undefined) {
      const field = trimmed(body.maxTokensField, 32, '上限字段名')
      if (field && !['max_tokens', 'max_completion_tokens'].includes(field)) {
        throw new Error('上限字段名只能是 max_tokens 或 max_completion_tokens')
      }
      next.maxTokensField = field
    }
    /**
     * 三个单价各自独立判断"传了没有"。
     *
     * 不能像别的字段那样在 `!partial` 时统一给默认值：新建时没填单价的含义是
     * "先不定价"，而那正好就是 null —— priceOrNull 对 undefined 回的也是 null，
     * 两条路殊途同归。改的时候没传则整个字段不动（PATCH 的常规语义）。
     */
    for (const field of PRICE_FIELDS) {
      if (!partial || body[field] !== undefined) {
        next[field] = priceOrNull(body[field], PRICE_LABELS[field])
      }
    }
    if (!partial || body.groups !== undefined) {
      // 去重 + 去空，空数组的含义是"所有分组可用"（见 visibleTo）
      next.groups = [...new Set((Array.isArray(body.groups) ? body.groups : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean))]
    }
    return next
  }

  /** 管理台用：全部记录（含停用的），key 只回掩码 */
  async function listAll() {
    const all = await map.all()
    return all.sort(bySort).map((record) => toPublicModel(record, box))
  }

  return {
    list: listAll,

    /**
     * 分页版的清单。
     *
     * ⚠️ 与分组那边同一句话：**这里的分页收的是响应体和界面，不是数据库。**
     * 模型记录不小（baseUrl、掩码、三个单价、可用范围数组），一次全下发给浏览器
     * 是实打实的浪费；但库那一侧仍然是整取，而且**必须**是整取：
     *
     *   - 排序键是 `sort` → `createdAt` → `id` 三段，全住在 payload 的 JSON 里，
     *     SQL 排不了（账号能做真 keyset，是因为它的排序键就是主键 id 本身）；
     *   - 顺序在这里不是装饰 —— **列表的第一个就是没指定模型时用的那个**
     *     （见 model-factory.js:pickModel）。按别的键翻页会把"哪个是默认模型"
     *     变成一件取决于翻页实现的事；
     *   - `resolveForGroup()` 跑在**每一次对话之前**，它要的就是完整的优先级序列，
     *     没有"只看一页"的版本。
     *
     * 也就是说：模型这一维天然有界（一个部署十几条，文件头那段判据没变），
     * 真到它长到需要在库里排序分页的那天，该做的是把它拆成一张有 sort 列和索引的
     * 正经表 —— 那时候接口和前端一行都不用改，因为形状已经是分页的了。
     */
    async page({ cursor = '', limit = PAGE_DEFAULT } = {}) {
      const sorted = await listAll()
      // 找不到游标指的那条（翻页当中它被删了）就退回第一页，而不是当成翻到底
      const from = cursor ? sorted.findIndex((model) => model.id === cursor) : -1
      const rest = from >= 0 ? sorted.slice(from + 1) : sorted
      const { page, hasMore, nextCursor } = finishPage(rest.slice(0, limit + 1), limit, (model) => model.id)
      return { items: page, hasMore, nextCursor }
    },

    async get(id) {
      const record = await map.get(String(id || ''))
      return record ? toPublicModel(record, box) : null
    },

    async create(body = {}) {
      const fields = normalizeFields(body, { partial: false })
      await assertModelIdFree(fields.model)
      const now = Date.now()
      const record = {
        id: `mdl_${randomUUID().slice(0, 12)}`,
        ...fields,
        key: box.seal(trimmed(body.key, KEY_MAX, 'API Key')),
        createdAt: now,
        updatedAt: now,
      }
      await map.put(record.id, record)
      logger.info?.('新增模型配置', { id: record.id, model: record.model, enabled: record.enabled })
      return toPublicModel(record, box)
    },

    /**
     * 改一条。
     *
     * **key 留空 = 不动它**，而不是清空。改一个模型的 contextWindow 时，
     * 界面上那个 key 输入框是空的（它本来就只显示掩码）—— 如果空串意味着清空，
     * 那么每一次无关的小改动都会顺手把 key 抹掉，而现象是"改完之后模型就调不通了"。
     * 真要清掉，传 `key: null`。
     */
    async update(id, body = {}) {
      const key = String(id || '')
      const current = await map.get(key)
      if (!current) return null

      const fields = normalizeFields(body, { partial: true, current })
      if (fields.model && fields.model !== current.model) await assertModelIdFree(fields.model, key)

      const patch = { ...fields, updatedAt: Date.now() }
      if (body.key === null) patch.key = ''
      else if (typeof body.key === 'string' && body.key.trim()) {
        patch.key = box.seal(trimmed(body.key, KEY_MAX, 'API Key'))
      }

      const updated = await map.merge(key, patch)
      return updated ? toPublicModel(updated, box) : null
    },

    async remove(id) {
      const key = String(id || '')
      const record = await map.get(key)
      if (!record) return false
      await map.delete(key)
      logger.info?.('删除模型配置', { id: key, model: record.model })
      return true
    },

    /** 这个分组被从系统里删掉了：把它从所有模型的可用范围里摘掉，别留悬空 id */
    async dropGroup(groupId) {
      const target = String(groupId || '')
      if (!target) return 0
      let touched = 0
      for (const record of await map.all()) {
        if (!Array.isArray(record.groups) || !record.groups.includes(target)) continue
        await map.merge(record.id, {
          groups: record.groups.filter((item) => item !== target),
          updatedAt: Date.now(),
        })
        touched += 1
      }
      return touched
    },

    /**
     * **给 broker 用的那一份：带明文 key。**
     *
     * 形状与 llminfo 回的那种记录对齐（model / server / key / contextWindow /
     * maxTokens / input / reasoning），于是 buildModel、pickModel、run-service
     * 一行都不用改 —— 它们本来就只认这个形状。
     *
     * @param {string} groupId 用户所属分组；空串 = 没分组的人
     */
    async resolveForGroup(groupId) {
      const all = (await map.all()).sort(bySort)
      const out = []
      for (const record of all) {
        if (!record.enabled) continue
        if (!visibleTo(record, groupId)) continue
        let key = ''
        try {
          key = box.open(record.key)
        } catch (error) {
          /**
           * 解不开就**跳过这一条**，而不是让整个清单失败。
           *
           * 换过 LLM_CONFIG_SECRET 的部署里，可能只有一部分记录是用旧密钥写的；
           * 让那几条拖垮所有人的对话是不成比例的。管理台上那条会标成"Key 解不开"。
           */
          logger.warn?.('模型 Key 解密失败，已跳过这条配置', { id: record.id, model: record.model, err: error?.message })
          continue
        }
        out.push({
          model: record.model,
          server: record.baseUrl,
          key,
          contextWindow: record.contextWindow,
          maxTokens: record.maxTokens,
          input: normalizeInput(record.input),
          reasoning: Boolean(record.reasoning),
          maxTokensField: record.maxTokensField || '',
          // 给日志和界面用的人类名字，不参与任何匹配
          label: record.name,
        })
      }
      return out
    },

    /**
     * 给用量台账用的价目表：`model_id → { input, output, cacheRead }`。
     *
     * **键是 `record.model`（发给上游的那个名字），不是 `record.id`** —— 台账里
     * `ap_usage.model_id` 存的就是它（run-service 记的是 `model.id`，而 model-factory
     * 把 `record.model` 放进了 `id`）。用错一个键的表现是所有模型都"未定价"，
     * 而那看起来像是"管理员还没填"，不像是接错了。
     *
     * **停用的模型也要回。** 一条模型停用了，它过去的用量还在账上，账单还要对得起来；
     * 漏掉它只会让那部分成本无声地变成"未定价"。删掉的那些则确实回不来了 ——
     * 记录都没了，价从哪儿来 —— 它们在用量页上如实显示为未定价。
     */
    async prices() {
      const out = new Map()
      for (const record of await map.all()) {
        const { priceInput, priceOutput, priceCacheRead, priced } = readPrices(record)
        if (!priced) continue
        out.set(record.model, {
          input: priceInput ?? 0,
          output: priceOutput ?? 0,
          cacheRead: priceCacheRead ?? 0,
        })
      }
      return out
    },

    /**
     * 库里一条都没有 —— 用来在 /healthz 和管理台上把"还没配"和"配错了"分开。
     * 走 `COUNT(*)`：这一句只想要一个整数，没必要为它把每条模型配置（含密文 key）
     * 都读出来再数一遍长度。
     */
    async count() {
      return map.count()
    },

    /**
     * 表头那两个数：一共几条、其中几条启用着。
     *
     * 分页之前它们是前端拿整份清单 `filter().length` 算的 —— 分页之后那会变成
     * "当前加载的这几条里有几条启用"，而管理员看那一行是为了确认
     * "这个部署到底有没有可用的模型"。
     */
    async stats() {
      const [total, enabled] = await Promise.all([
        map.count(),
        map.countMatching({ enabled: true }),
      ])
      return { total, enabled }
    },
  }
}

/**
 * 这条模型对这个分组可见吗。
 *
 * **空 groups = 所有分组可用**，而不是"谁也用不了"。
 *
 * 这个默认值是有取舍的：管理员建第一个模型时多半还没建任何分组，
 * 如果空表示"谁也看不到"，那么他配完之后打开对话框会发现一个模型都没有，
 * 而界面上完全看不出问题在哪。反过来，"忘了限制范围"的后果是多几个人
 * 看得到这个模型，那是一个在管理台上**一眼就能看见并改掉**的状态。
 * 让不显眼的那种错误变成显眼的那种，这是唯一的理由。
 */
export function visibleTo(record, groupId) {
  const groups = Array.isArray(record.groups) ? record.groups : []
  if (!groups.length) return true
  return Boolean(groupId) && groups.includes(String(groupId))
}
