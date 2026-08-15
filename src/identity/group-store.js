/**
 * 用户分组。
 *
 * ── 它回答的是"这个人的档位" ────────────────────────────────────────────
 *
 * 具体是两件事，而且只有这两件：**能用哪些模型**，以及**能用多少 token**。
 * 它们是同一个轴上的两个刻度 —— "给试用用户开便宜的模型、每天一百万 token"
 * 是一句话里的一件事，拆到两个概念上只会让管理员在两个页面之间来回对齐。
 *
 * 分组仍然**不带任何权限含义**：它不是角色（那是 `role: user | admin`，管的是
 * 能不能管别人），也不是租户（隔离一直是按 username 做的，见隔离契约 #4）。
 * 这条边界要守住，否则它会慢慢长成第二套权限系统：一旦"分组"开始决定能不能用
 * 某个技能、能不能建作品、能跑几个并发，任何一次授权问题都要同时查两个地方。
 *
 * 真需要那些的时候，该加的是各自的开关，而不是往分组上挂。
 *
 * ── 两个额度的口径 ──────────────────────────────────────────────────────
 *
 *   tokenQuota       累计总量，**永不重置**。烧完就停，要继续用得管理员调高上限。
 *   dailyTokenQuota  每天的量，跨零点归零。"零点"按 QUOTA_TIMEZONE 算（见 telemetry/quota.js）。
 *
 * 都是 **0 = 不限**，而不是"没配过 = 不限、配了 0 = 一点都不给" —— 后者会让
 * "把额度清空"这个动作变成"把人封死"，而管理员想做的十有八九是前者。
 *
 * 更要紧的是：**额度是按人算的，不是全组共用一个池子**。配 100 万的意思是
 * "组里每个人各有 100 万"。共用池的话，一个人跑几个大任务就能让整组停摆，
 * 而被停的人既看不出是谁烧的、也做不了任何事。想按部门做预算的时候，
 * 要加的是"部门"这个新概念，不是把分组的语义改掉。
 *
 * ── 没有分组的人是什么状态 ──────────────────────────────────────────────
 *
 * 合法状态，不是错误。`groupId: ''` 的人能用的是**没有限制可用范围的那些模型**
 * （模型记录里 groups 为空的），而且**不受任何额度限制**。所以一个部署可以完全
 * 不建分组就跑起来：配几个模型，所有人都能用、都不限量。分组是在"要区别对待"
 * 的那一刻才引入的东西。
 *
 * ⚠️ 这也意味着额度**不是一道安全边界**：把一个人移出分组就等于给他解开了限制。
 * 它防的是"跑飞的任务把这个月的预算烧光"，不是防内鬼。
 *
 * ── 默认分组 ────────────────────────────────────────────────────────────
 *
 * 最多一个分组能被标成默认，新建的账号自动进它。这条不是可有可无的便利：
 * 没有它，管理员每加一个人都要记得再点一次分组，而"忘了点"的表现是
 * 那个人打开对话框发现没有模型可选 —— 一个看不出原因的空列表。
 */
import { randomUUID } from 'node:crypto'

import { requireStorage } from '../persistence/storage.js'

const COLLECTION = 'user_groups'
const NAME_MAX = 32
const DESC_MAX = 200

export function toPublicGroup(record) {
  if (!record) return null
  return {
    id: record.id,
    name: record.name,
    description: record.description || '',
    isDefault: Boolean(record.isDefault),
    /**
     * 两个额度都**兜底成 0（不限）**：这个字段是后加的，老记录里根本没有它。
     * 不兜底的话，升级上来的部署里每个分组的额度都是 undefined，
     * 而 `undefined >= quota` 是 false —— 恰好不拦，看起来像是好的，
     * 直到有人在界面上点开一个分组，看到两个空输入框保存了一次。
     */
    tokenQuota: Number(record.tokenQuota) || 0,
    dailyTokenQuota: Number(record.dailyTokenQuota) || 0,
    createdAt: record.createdAt || 0,
    updatedAt: record.updatedAt || 0,
  }
}

export function createGroupStore({ storage, logger = console }) {
  requireStorage(storage, 'createGroupStore')
  const map = storage.globalMap(COLLECTION)

  function assertName(input) {
    const name = String(input ?? '').trim()
    if (!name) throw new Error('分组名不能为空')
    if (name.length > NAME_MAX) throw new Error(`分组名不能超过 ${NAME_MAX} 个字符`)
    return name
  }

  /**
   * 额度收口成一个非负整数。
   *
   * **乱填要报错，不能悄悄退回 0** —— 与查询参数不同（那些错填一下只是让人多点
   * 一次，见 usage-store 的 resolveSince）。这里退回 0 的意思是"不限"：管理员
   * 想配 100 万、少打了一个字，得到的却是"这个组从此不限量"，而界面上会如实
   * 显示"不限"，没有任何地方提示他刚才那一下没生效。
   *
   * 空串同样按 0 收：界面上那个数字输入框清空之后给过来的就是空串，
   * 而在那个位置上"清空"就是"不限"的意思。
   */
  function assertQuota(input, label) {
    const text = String(input ?? '').trim()
    if (!text) return 0
    const value = Number(text)
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label}要填一个不小于 0 的整数（0 = 不限）`)
    if (!Number.isSafeInteger(Math.floor(value))) throw new Error(`${label}太大了`)
    return Math.floor(value)
  }

  /**
   * 只能有一个默认分组。
   *
   * 把这件事做成"设置新的默认时清掉旧的"，而不是保存时校验"是不是已经有一个了"：
   * 后者会让管理员必须先取消旧的再设新的（两步，中间那一刻没有默认分组，
   * 那时候建的账号会掉进无分组）。
   */
  async function clearDefaultExcept(keepId) {
    for (const record of await map.all()) {
      if (record.id === keepId || !record.isDefault) continue
      await map.merge(record.id, { isDefault: false, updatedAt: Date.now() })
    }
  }

  return {
    async list() {
      const all = await map.all()
      return all
        .map(toPublicGroup)
        // 默认分组排最前（它是"大多数人在哪儿"），其余按名字
        .sort((a, b) => (Number(b.isDefault) - Number(a.isDefault)) || a.name.localeCompare(b.name))
    },

    async get(id) {
      const record = await map.get(String(id || ''))
      return record ? toPublicGroup(record) : null
    },

    /** 新账号该进哪个分组。没有默认分组时回空串（= 无分组，合法） */
    async defaultGroupId() {
      const all = await map.all()
      return all.find((record) => record.isDefault)?.id || ''
    },

    async create({ name, description = '', isDefault = false, tokenQuota = 0, dailyTokenQuota = 0 }) {
      const now = Date.now()
      const record = {
        id: `grp_${randomUUID().slice(0, 12)}`,
        name: assertName(name),
        description: String(description || '').trim().slice(0, DESC_MAX),
        isDefault: Boolean(isDefault),
        tokenQuota: assertQuota(tokenQuota, '总额度'),
        dailyTokenQuota: assertQuota(dailyTokenQuota, '每日额度'),
        createdAt: now,
        updatedAt: now,
      }
      await map.put(record.id, record)
      if (record.isDefault) await clearDefaultExcept(record.id)
      logger.info?.('新建用户分组', { id: record.id, name: record.name })
      return toPublicGroup(record)
    },

    async update(id, { name, description, isDefault, tokenQuota, dailyTokenQuota }) {
      const key = String(id || '')
      const patch = { updatedAt: Date.now() }
      if (name !== undefined) patch.name = assertName(name)
      if (description !== undefined) patch.description = String(description || '').trim().slice(0, DESC_MAX)
      if (isDefault !== undefined) patch.isDefault = Boolean(isDefault)
      if (tokenQuota !== undefined) patch.tokenQuota = assertQuota(tokenQuota, '总额度')
      if (dailyTokenQuota !== undefined) patch.dailyTokenQuota = assertQuota(dailyTokenQuota, '每日额度')

      const updated = await map.merge(key, patch)
      if (!updated) return null
      if (patch.isDefault) await clearDefaultExcept(key)
      return toPublicGroup(updated)
    },

    /**
     * 删一个分组。
     *
     * 调用方（HTTP 层）负责把它从用户和模型上摘干净 —— 这里不反向依赖那两个 store，
     * 否则三者会绕成一个环（分组 → 账号 → …）。删干净的顺序写在路由那一处，
     * 因为"删之前要不要拦一下"是一个界面决策，不是存储决策。
     */
    async remove(id) {
      const key = String(id || '')
      const record = await map.get(key)
      if (!record) return false
      await map.delete(key)
      logger.info?.('删除用户分组', { id: key, name: record.name })
      return true
    },
  }
}
