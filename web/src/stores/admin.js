/**
 * 管理员控制台：账号、分组、模型、Token 用量。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────────
 *
 * 这一块与对话界面**没有任何共享状态**，它只是碰巧和对话住在同一个应用里。
 * 从前它和聊天、作品、记忆、定时任务一起挤在 stores/app.js 那两千行里，
 * 于是"改一下用量表的分组口径"这种改动，diff 会落在一个所有人都要读的文件上。
 *
 * 依赖只有两样：`state` 和 `api`。这不是巧合 —— 管理台做的事就是
 * "拿一份清单、改一条记录、把结果写回状态"，它不需要知道对话是怎么跑的。
 * 哪天这里开始 import 聊天那边的东西了，多半是有个功能放错了地方。
 *
 * 状态仍然挂在全局那个 `state` 上（`admin*` / `usage*` / `models` / `groups`
 * 那几组字段），没有跟着搬成局部 —— 组件读的是同一个单例，搬了就要动一批
 * 组件的 import，而那与本次拆分要解决的问题无关。
 */
import { api } from '../lib/api.js'
import { state } from './state.js'

/* ── 管理员控制台 ── */

export async function refreshUsers() {
  if (!state.features.accounts) return
  state.adminLoading = true
  try {
    state.adminUsers = (await api.adminListUsers()).users || []
    state.adminNote = ''
    state.adminNoteWarn = false
  } catch (error) {
    state.adminNote = `账号清单加载失败：${error.message}`
    state.adminNoteWarn = true
  } finally {
    state.adminLoading = false
  }
}

export async function openAdmin() {
  state.view = 'admin'
  state.panel = ''
  /**
   * 分组和账号一起取：账号表里那一列要显示**分组名**，而账号记录上存的是 id。
   * 等切到分组页才取的话，账号表会先显示一串 `grp_8f2c…`，然后突然变成中文名 ——
   * 一个纯粹由加载顺序造成的、看起来像 bug 的闪烁。
   */
  await Promise.all([refreshUsers(), refreshGroups()])
}

export function closeAdmin() {
  state.view = 'chat'
}

/* ── Token 用量 ── */

/**
 * 总表。
 *
 * 账号清单与用量是**两次请求**，不是一次带回来的：管人那一页每做一次动作都要重取
 * 账号清单（服务端有它自己的规则），而用量是只读的、按时间窗算的，跟着一起重取
 * 只是白花一次聚合查询。服务端已经把两者对齐好了（没跑过的账号也有一行 0），
 * 所以这里不需要在前端做连接。
 */
export async function refreshUsage() {
  if (!state.features.accounts) return
  state.adminUsageLoading = true
  try {
    state.adminUsage = await api.adminUsage(state.adminUsageDays, state.adminUsageGroup)
    state.adminNote = ''
    state.adminNoteWarn = false
  } catch (error) {
    state.adminNote = `用量加载失败：${error.message}`
    state.adminNoteWarn = true
  } finally {
    state.adminUsageLoading = false
  }
}

/**
 * 换时间窗 / 换维度。
 *
 * 两件事都要**收起展开的那一行**：它的曲线是按旧参数取的，留着就会出现
 * 表头写着"近 7 天"而下面那条曲线还是 30 天的。重取比在本地裁剪可靠 ——
 * 裁剪等于把服务端的时间窗规则在前端抄一份。
 */
export async function setUsageDays(days) {
  state.adminUsageDays = Number(days)
  closeUsageRow()
  await refreshUsage()
}

export async function setUsageGroup(group) {
  if (state.adminUsageGroup === group) return
  state.adminUsageGroup = group
  closeUsageRow()
  await refreshUsage()
}

function closeUsageRow() {
  state.adminUsageOpen = ''
  state.adminUsageTrend = null
}

/**
 * 展开/收起一行。再点同一行就是收起。
 *
 * 拆分（这个人用了哪些模型 / 这个模型被谁用了）已经在总表那一行里，界面直接画；
 * 这里只去取**按天曲线**，因为那是唯一一份总表没带的数据。
 */
export async function openUsageRow(key) {
  if (state.adminUsageOpen === key) return closeUsageRow()

  state.adminUsageOpen = key
  state.adminUsageTrend = null
  state.adminUsageTrendLoading = true
  try {
    state.adminUsageTrend = state.adminUsageGroup === 'model'
      ? await api.adminModelTrend(key, state.adminUsageDays)
      : await api.adminUserTrend(key, state.adminUsageDays)
  } catch (error) {
    state.adminUsageOpen = ''
    state.adminNote = `${key} 的用量趋势加载失败：${error.message}`
    state.adminNoteWarn = true
  } finally {
    state.adminUsageTrendLoading = false
  }
}

/* ── 模型配置 ── */

export async function refreshModels() {
  state.adminModelsLoading = true
  try {
    const data = await api.adminListModels()
    state.adminModels = data.models || []
    state.adminModelsMeta = {
      effective: Boolean(data.effective),
      llmMode: data.llmMode || '',
      encrypted: Boolean(data.encrypted),
    }
    state.adminNote = ''
    state.adminNoteWarn = false
  } catch (error) {
    state.adminNote = `模型清单加载失败：${error.message}`
    state.adminNoteWarn = true
  } finally {
    state.adminModelsLoading = false
  }
}

/**
 * 模型的增删改都走这里：跑完重取清单。
 *
 * 与 runAdminAction 分开只因为它刷的是另一份清单 —— 共用一个的话，
 * 改一次模型会顺带把账号清单也拉一遍，而那一页可能根本没打开过。
 */
async function runModelAction(call, okNote) {
  state.adminBusy = true
  state.adminNote = ''
  state.adminNoteWarn = false
  try {
    await call()
    await refreshModels()
    state.adminNote = okNote
    return true
  } catch (error) {
    state.adminNote = error.message
    state.adminNoteWarn = true
    return false
  } finally {
    state.adminBusy = false
  }
}

export function createModel(body) {
  return runModelAction(() => api.adminCreateModel(body), `已添加模型 ${body.model}`)
}

export function updateModel(id, body) {
  return runModelAction(() => api.adminPatchModel(id, body), '模型配置已保存')
}

export function setModelEnabled(id, enabled) {
  return runModelAction(
    () => api.adminPatchModel(id, { enabled }),
    enabled ? '模型已启用' : '模型已停用（立刻生效，正在进行的对话不受影响）',
  )
}

export function deleteModel(id, name) {
  return runModelAction(() => api.adminDeleteModel(id), `已删除模型 ${name}（历史用量记录保留）`)
}

/* ── 用户分组 ── */

export async function refreshGroups() {
  state.adminGroupsLoading = true
  try {
    const data = await api.adminListGroups()
    state.adminGroups = data.groups || []
    state.adminUngrouped = data.ungrouped || 0
    // 每日额度几点归零，由服务端说了算（QUOTA_TIMEZONE），界面不猜
    state.adminQuotaTimezone = data.quotaTimezone || ''
    state.adminNote = ''
    state.adminNoteWarn = false
  } catch (error) {
    state.adminNote = `分组加载失败：${error.message}`
    state.adminNoteWarn = true
  } finally {
    state.adminGroupsLoading = false
  }
}

/**
 * 分组的增删改。
 *
 * 跑完**三份清单一起重取**：删一个分组会同时改到账号（那些人退回无分组）
 * 和模型（可用范围里摘掉它）。只刷分组的话，另外两页会停在删之前的样子，
 * 而用户要等到切过去才发现不对。
 */
async function runGroupAction(call, okNote) {
  state.adminBusy = true
  state.adminNote = ''
  state.adminNoteWarn = false
  try {
    await call()
    await Promise.all([refreshGroups(), refreshModels(), refreshUsers()])
    state.adminNote = okNote
    state.adminNoteWarn = false
    return true
  } catch (error) {
    state.adminNote = error.message
    state.adminNoteWarn = true
    return false
  } finally {
    state.adminBusy = false
  }
}

export function createGroup(body) {
  return runGroupAction(() => api.adminCreateGroup(body), `已新建分组 ${body.name}`)
}

export function updateGroup(id, body) {
  return runGroupAction(() => api.adminPatchGroup(id, body), '分组已保存')
}

export function deleteGroup(id, name) {
  return runGroupAction(
    () => api.adminDeleteGroup(id),
    `已删除分组 ${name}：组里的人退回「无分组」，模型的可用范围里也已摘掉它`,
  )
}

export function setUserGroup(username, groupId) {
  return runAdminAction(
    () => api.adminPatchUser(username, { groupId }),
    groupId ? `${username} 的分组已更新` : `${username} 已退出分组`,
  )
}

/** 切页。每一页第一次进来才取数，来回切不重复请求 */
export async function setAdminTab(tab) {
  state.adminTab = tab
  if (tab === 'usage' && !state.adminUsage) await refreshUsage()
  /**
   * 模型页和分组页**互相需要对方的清单**：模型要按分组勾可用范围，
   * 分组要显示"这个组能用几个模型"。所以进任一页都把两份都备齐，
   * 而不是等切过去才发现勾选框里是一串陌生的 id。
   */
  if ((tab === 'models' || tab === 'groups') && !state.adminGroups.length) await refreshGroups()
  if ((tab === 'models' || tab === 'groups') && !state.adminModels.length) await refreshModels()
}

/**
 * 三个管理动作的公共出口：跑完都要刷新清单。
 *
 * 不在本地改一份状态而是重取，是因为服务端有它自己的规则（不许禁用自己、
 * 不许撤销自己的管理员身份）—— 本地猜一遍就等于把那套规则抄两份，迟早对不上。
 */
async function runAdminAction(call, okNote) {
  state.adminBusy = true
  state.adminNote = ''
  state.adminNoteWarn = false
  try {
    await call()
    await refreshUsers()
    state.adminNote = okNote
    state.adminNoteWarn = false
    return true
  } catch (error) {
    state.adminNote = error.message
    state.adminNoteWarn = true
    return false
  } finally {
    state.adminBusy = false
  }
}

/**
 * 建账号。`groupId` 不传 = 进默认分组（服务端去查哪个组标了默认），
 * 传空串 = 明确不进任何分组。两者不能混成一个值 —— 混了就没法表达"就是不要分组"。
 */
export function createUser({ username, password, role, groupId }) {
  return runAdminAction(
    () => api.adminCreateUser({ username, password, role, ...(groupId === undefined ? {} : { groupId }) }),
    `已创建账号 ${username}`,
  )
}

export function setUserDisabled(username, disabled) {
  return runAdminAction(
    () => api.adminPatchUser(username, { disabled }),
    disabled ? `${username} 已禁用（数据保留，随时可以启用）` : `${username} 已启用`,
  )
}

export function setUserRole(username, role) {
  return runAdminAction(
    () => api.adminPatchUser(username, { role }),
    role === 'admin' ? `${username} 已设为管理员` : `${username} 已改回普通用户`,
  )
}

export function resetUserPassword(username, newPassword) {
  return runAdminAction(
    () => api.adminPatchUser(username, { newPassword }),
    `${username} 的密码已重置 —— 请通过可靠渠道告诉他，并让他登录后自行修改`,
  )
}
