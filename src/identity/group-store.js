/**
 * 用户分组。
 *
 * ── 它只回答一个问题 ────────────────────────────────────────────────────
 *
 * "这个人能用哪些模型"。分组本身不带任何权限含义 —— 它不是角色（那是
 * `role: user | admin`，管的是能不能管别人），也不是租户（隔离一直是按
 * username 做的，见隔离契约 #4）。把它做成一个只有一件用途的概念，
 * 是为了避免它慢慢长成第二套权限系统：一旦"分组"开始决定能不能用某个技能、
 * 能不能建作品、能跑几个并发，任何一次授权问题都要同时查两个地方。
 *
 * 真需要那些的时候，该加的是各自的开关，而不是往分组上挂。
 *
 * ── 没有分组的人是什么状态 ──────────────────────────────────────────────
 *
 * 合法状态，不是错误。`groupId: ''` 的人能用的是**没有限制可用范围的那些模型**
 * （模型记录里 groups 为空的）。所以一个部署可以完全不建分组就跑起来：
 * 配几个模型，所有人都能用。分组是在"要区别对待"的那一刻才引入的东西。
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

    async create({ name, description = '', isDefault = false }) {
      const now = Date.now()
      const record = {
        id: `grp_${randomUUID().slice(0, 12)}`,
        name: assertName(name),
        description: String(description || '').trim().slice(0, DESC_MAX),
        isDefault: Boolean(isDefault),
        createdAt: now,
        updatedAt: now,
      }
      await map.put(record.id, record)
      if (record.isDefault) await clearDefaultExcept(record.id)
      logger.info?.('新建用户分组', { id: record.id, name: record.name })
      return toPublicGroup(record)
    },

    async update(id, { name, description, isDefault }) {
      const key = String(id || '')
      const patch = { updatedAt: Date.now() }
      if (name !== undefined) patch.name = assertName(name)
      if (description !== undefined) patch.description = String(description || '').trim().slice(0, DESC_MAX)
      if (isDefault !== undefined) patch.isDefault = Boolean(isDefault)

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
