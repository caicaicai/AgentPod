<script setup>
import { computed, ref } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import { formatDateTime, formatSince, formatTokens } from '@/lib/format.js'
import { askConfirm } from '@/lib/dialog.js'
import {
  closeAdmin, createGroup, createModel, createUser, deleteGroup, deleteModel, openUsageRow,
  refreshGroups, refreshModels, refreshUsage, refreshUsers, resetUserPassword, setAdminTab,
  setModelEnabled, setUsageDays, setUsageGroup, setUserDisabled, setUserGroup, setUserRole,
  state, updateGroup, updateModel,
} from '@/stores/app.js'

/**
 * 管理员控制台：这个部署里有哪些账号，以及对它们能做什么。
 *
 * ── 为什么是整页而不是抽屉 ──────────────────────────────────────────────
 *
 * 右边那排抽屉（记忆 / 定时任务 / 项目）都是"边看对话边改"的东西。管人不是：
 * 它是一件独立的事，要看一张表、要对比几行、要做不可逆的操作。
 * 挤在 460px 的抽屉里，用户名和三个按钮就把一行占满了。
 *
 * ── 界面上的判定不是安全边界 ────────────────────────────────────────────
 *
 * 这一页只在 `account.role === 'admin'` 时画得出来，但那**只是为了别给人看
 * 一个点了必然失败的入口**。真正的判定在服务端（见 http/server.js 里
 * `/v1/admin/users` 那段：先 users.get(subject.username) 再判 role）——
 * 谁都可以直接 curl 那个地址。
 *
 * ── 四页而不是一张更宽的表 ──────────────────────────────────────────────
 *
 * 「Token 用量」没有并进账号表里多加三列，因为两页问的是不同的问题：
 * 管人是**对某一行做一件事**（禁用他、重置他的密码），看用量是**把所有人排个序**
 * （谁在烧钱）。前者要按用户名找人，后者要按数字找人 —— 塞进一张表的话，
 * 操作列和数字列会互相挤，而两种任务都变难。
 *
 * 「模型」与「分组」是后来加的两页。它们本可以合成一页（分组就是拿来开模型的），
 * 但那样每加一个模型都要在同一片区域里同时读两张表。分开之后各自回答一个问题：
 * 模型页是"这个部署能用什么"，分组页是"谁属于哪一拨人"，
 * 两者在**模型的可用范围**那一格上交汇。
 */

const me = computed(() => state.account?.username || '')

const shown = computed(() => {
  const keyword = state.adminSearch.trim().toLowerCase()
  if (!keyword) return state.adminUsers
  return state.adminUsers.filter((user) => user.username.toLowerCase().includes(keyword))
})

const admins = computed(() => state.adminUsers.filter((user) => user.role === 'admin' && !user.disabled))

/* ═══════════════ 新建账号 ═══════════════ */

const creating = ref(false)
/**
 * `groupId: undefined` 而不是 `''`：两者在接口上是**不同的意思** ——
 * 不传表示"用默认分组"（服务端去查哪个组标了默认），传空串表示"明确不进任何分组"。
 * 表单里那个下拉的第一项就是"默认分组"，选它就是不传。
 */
const form = ref({ username: '', password: '', email: '', role: 'user', groupId: undefined })

async function onCreate() {
  const username = form.value.username.trim()
  if (!username || !form.value.password) {
    state.adminNote = '用户名和初始密码都要填'
    state.adminNoteWarn = true
    return
  }
  const ok = await createUser({
    username,
    password: form.value.password,
    role: form.value.role,
    // 空串就干脆不传：传了会让服务端去跑一遍邮箱校验，而"没填"不是"填了个空的"
    ...(form.value.email.trim() ? { email: form.value.email.trim() } : {}),
    ...(form.value.groupId === undefined ? {} : { groupId: form.value.groupId }),
  })
  if (ok) {
    form.value = { username: '', password: '', email: '', role: 'user', groupId: undefined }
    creating.value = false
  }
}

/** 默认分组的名字，写在新建表单那个下拉的第一项里 —— 别让人去别的页面查 */
const defaultGroupName = computed(() => state.adminGroups.find((group) => group.isDefault)?.name || '')

/* ═══════════════ 行内动作 ═══════════════ */

/**
 * 禁用要问一次，启用不用。
 *
 * 不对称是有意的：禁用会把一个人挡在门外（他正在用的话，下一次请求就 401），
 * 而启用只是把门打开 —— 前者值得停一下，后者停一下只是碍事。
 */
async function onToggleDisabled(user) {
  if (!user.disabled) {
    const ok = await askConfirm({
      title: `禁用 ${user.username}`,
      message: '他将无法登录，但**数据全部保留**（会话、作品、记忆都还在），随时可以启用回来。',
      confirmText: '禁用',
      danger: true,
    })
    if (!ok) return
  }
  await setUserDisabled(user.username, !user.disabled)
}

async function onToggleRole(user) {
  const toAdmin = user.role !== 'admin'
  const ok = await askConfirm({
    title: toAdmin ? `把 ${user.username} 设为管理员` : `取消 ${user.username} 的管理员`,
    message: toAdmin
      ? '管理员能创建账号、禁用别人、重置任何人的密码。'
      : '他将只能管理自己的账号。',
    confirmText: toAdmin ? '设为管理员' : '取消管理员',
    danger: !toAdmin,
  })
  if (ok) await setUserRole(user.username, toAdmin ? 'admin' : 'user')
}

/**
 * 重置密码就地展开一个输入框，而不是弹一个对话框。
 *
 * 对话框那套只有单行文本一种形状，密码要 `type="password"`（别让新密码明晃晃
 * 留在屏幕上给旁边的人看）。就地展开还有个好处：这一行上方就是用户名，
 * 不会出现"弹框弹出来忘了自己点的是谁"。
 */
const resetting = ref('')
const newPassword = ref('')

function startReset(username) {
  resetting.value = resetting.value === username ? '' : username
  newPassword.value = ''
}

async function onReset(username) {
  if (!newPassword.value) return
  const ok = await resetUserPassword(username, newPassword.value)
  if (ok) {
    resetting.value = ''
    newPassword.value = ''
  }
}

/**
 * 这一行的动作是不是该禁掉。
 *
 * 服务端也拦（不许禁用自己、不许撤销自己的管理员身份），这里禁掉按钮是为了
 * 别让人点一下才知道不行。**两边都要有**：只有前端拦等于没拦，
 * 只有后端拦则是每次都要靠一条报错来学规则。
 */
const isMe = (user) => user.username === me.value
/** 最后一个管理员不能被降级或禁用 —— 降完就没人能再把它改回来了 */
const isLastAdmin = (user) => user.role === 'admin' && !user.disabled && admins.value.length <= 1

/* ═══════════════ 分组（账号页与模型页共用的查表） ═══════════════ */

/** id → 分组名。两张表都要把存着的 id 显示成人看得懂的名字 */
const groupName = (id) => state.adminGroups.find((group) => group.id === id)?.name || ''
/**
 * 指着一个已经不存在的分组时不显示空白。
 *
 * 正常路径上不会出现（删分组时服务端把引用一起摘了），但只要出现过一次，
 * 空白格会让人以为"这个人没分组"，而实际上他的可用模型与无分组的人相同却
 * 显示不同 —— 写出来比藏起来好排查。
 */
const groupLabel = (id) => (id ? (groupName(id) || `未知分组（${id}）`) : '')

/* ═══════════════ 模型 ═══════════════ */

/**
 * 新建时的初值。
 *
 * contextWindow 给 128000 而不是留空：绝大多数当代模型都在这个量级，
 * 填错了只是浪费一点上下文预算；而 maxTokens 留 0（= 这个字段整个不发，
 * 让上游用自己的默认值）—— 编一个偏小的上限会把模型的输出在**工具参数中间**
 * 截断，现象是模型"犯傻"而不是"被掐了"，极难认。
 */
const emptyModel = () => ({
  name: '',
  model: '',
  baseUrl: '',
  key: '',
  contextWindow: 128000,
  maxTokens: 0,
  image: false,
  reasoning: false,
  maxTokensField: '',
  groups: [],
  enabled: true,
  sort: 0,
})

const modelForm = ref(emptyModel())

function startCreateModel() {
  state.adminModelEditing = state.adminModelEditing === 'new' ? '' : 'new'
  modelForm.value = emptyModel()
}

function startEditModel(model) {
  if (state.adminModelEditing === model.id) {
    state.adminModelEditing = ''
    return
  }
  state.adminModelEditing = model.id
  modelForm.value = {
    ...emptyModel(),
    ...model,
    // 界面上「支持读图」是一个开关，存储里是 input 数组。text 永远在，不给它开关
    image: (model.input || []).includes('image'),
    /**
     * key 一律留空。服务端只回掩码，把掩码填进输入框会让它在保存时**被当成新 key
     * 写回去** —— 那时候库里存的就是一串 `sk-••••1234`，而模型开始报 401。
     */
    key: '',
    groups: [...(model.groups || [])],
  }
}

/** 表单 → 接口 body。`input` 在这一层拼，别让存储层去猜界面上的开关 */
function modelBody() {
  const form = modelForm.value
  return {
    name: form.name.trim(),
    model: form.model.trim(),
    baseUrl: form.baseUrl.trim(),
    contextWindow: Number(form.contextWindow) || 0,
    maxTokens: Number(form.maxTokens) || 0,
    input: form.image ? ['text', 'image'] : ['text'],
    reasoning: Boolean(form.reasoning),
    maxTokensField: form.maxTokensField || '',
    groups: [...form.groups],
    enabled: Boolean(form.enabled),
    sort: Number(form.sort) || 0,
    // 空 = 不动（新建时服务端按"没配 key"处理），见 api.js 上的说明
    ...(form.key.trim() ? { key: form.key.trim() } : {}),
  }
}

async function onSubmitModel() {
  const form = modelForm.value
  if (!form.name.trim() || !form.model.trim() || !form.baseUrl.trim()) {
    state.adminNote = '名称、模型 ID、接口地址都要填'
    state.adminNoteWarn = true
    return
  }
  const ok = state.adminModelEditing === 'new'
    ? await createModel(modelBody())
    : await updateModel(state.adminModelEditing, modelBody())
  if (ok) state.adminModelEditing = ''
}

async function onDeleteModel(model) {
  const ok = await askConfirm({
    title: `删除模型 ${model.name}`,
    message: '正在用它的对话会立刻失败（下一条消息就报"模型不在你可用的清单里"）。'
      + '**历史用量记录会保留** —— 账还要对得上。只是想临时停用的话，用「停用」。',
    confirmText: '删除',
    danger: true,
  })
  if (ok) await deleteModel(model.id, model.name)
}

/** 勾一个分组进/出可用范围。表单内的操作，保存时才写回服务端 */
function toggleModelGroup(groupId) {
  const list = modelForm.value.groups
  const index = list.indexOf(groupId)
  if (index >= 0) list.splice(index, 1)
  else list.push(groupId)
}

/** 一条模型的可用范围，写成一句话。空 = 所有分组（与服务端 visibleTo 的约定一致） */
const modelScope = (model) => (model.groups.length
  ? model.groups.map((id) => groupLabel(id) || id).join('、')
  : '所有分组')

const shownModels = computed(() => {
  const keyword = state.adminSearch.trim().toLowerCase()
  if (!keyword) return state.adminModels
  return state.adminModels.filter((model) => `${model.name} ${model.model} ${model.baseUrl}`
    .toLowerCase().includes(keyword))
})

/* ═══════════════ 分组的增删改 ═══════════════ */

/**
 * 两个额度在表单里是**字符串**（数字输入框给的就是字符串），空串 = 不限。
 *
 * 不在前端转成数字：0 和空串在这个位置是同一个意思（不限），而 `Number('')`
 * 是 0、`Number('abc')` 是 NaN —— 转早了就分不清"他清空了"和"他打错了"。
 * 收口在服务端一处做（group-store 的 assertQuota），错了会回一条说得清的 400。
 */
const groupForm = ref({ name: '', description: '', isDefault: false, tokenQuota: '', dailyTokenQuota: '' })

/** 存着的 0（不限）在输入框里要显示成空，而不是一个碍眼的 0 */
const quotaInput = (value) => (Number(value) > 0 ? String(value) : '')

function startCreateGroup() {
  state.adminGroupEditing = state.adminGroupEditing === 'new' ? '' : 'new'
  groupForm.value = { name: '', description: '', isDefault: false, tokenQuota: '', dailyTokenQuota: '' }
}

function startEditGroup(group) {
  if (state.adminGroupEditing === group.id) {
    state.adminGroupEditing = ''
    return
  }
  state.adminGroupEditing = group.id
  groupForm.value = {
    name: group.name,
    description: group.description,
    isDefault: group.isDefault,
    tokenQuota: quotaInput(group.tokenQuota),
    dailyTokenQuota: quotaInput(group.dailyTokenQuota),
  }
}

async function onSubmitGroup() {
  if (!groupForm.value.name.trim()) {
    state.adminNote = '分组名不能为空'
    state.adminNoteWarn = true
    return
  }
  const body = {
    name: groupForm.value.name.trim(),
    description: groupForm.value.description.trim(),
    isDefault: Boolean(groupForm.value.isDefault),
    tokenQuota: String(groupForm.value.tokenQuota ?? '').trim(),
    dailyTokenQuota: String(groupForm.value.dailyTokenQuota ?? '').trim(),
  }
  const ok = state.adminGroupEditing === 'new'
    ? await createGroup(body)
    : await updateGroup(state.adminGroupEditing, body)
  if (ok) state.adminGroupEditing = ''
}

async function onDeleteGroup(group) {
  const ok = await askConfirm({
    title: `删除分组 ${group.name}`,
    message: `组里的 ${group.userCount} 个人会退回「无分组」，只剩下那些不限可用范围的模型；`
      + '模型的可用范围里也会把它摘掉。**账号和模型本身都不会被删。**',
    confirmText: '删除分组',
    danger: true,
  })
  if (ok) await deleteGroup(group.id, group.name)
}

/* ═══════════════ Token 用量 ═══════════════ */

/**
 * 时间窗。三个够了：一周（这阵子谁在跑）、一个月（对账周期）、全部（这个部署总共用了多少）。
 * 0 = 全部，与服务端的约定一致。
 */
const RANGES = [{ days: 7, label: '近 7 天' }, { days: 30, label: '近 30 天' }, { days: 0, label: '全部' }]

/**
 * 两个维度。
 *
 * 「按用户」回答分账的问题（这个人该付多少），「按模型」回答定价和选型的问题
 * （哪个模型吃掉了量）。两边是同一份「用户 × 模型」交叉表的转置，服务端一次查完，
 * 所以两页的合计一定相等 —— 不会出现"换个维度总数就变了"。
 */
const GROUPS = [{ key: 'user', label: '按用户' }, { key: 'model', label: '按模型' }]

const byModel = computed(() => state.adminUsage?.group === 'model')

/** 这一维的取值就是行的 key：用户名或模型 id。表格与展开都用它 */
const rowKey = (row) => (byModel.value ? row.modelId : row.username)
/** 每行里另一维的拆分（用户行 → 他用过的模型；模型行 → 用了它的人） */
const rowChildren = (row) => (byModel.value ? row.users : row.models) || []
const childKey = (child) => (byModel.value ? child.username : child.modelId)
/** 模型 id 可能是空串（老数据、或者哪天网关没给），别在界面上留一片空白 */
const label = (value) => value || '（未记录）'

const usageRows = computed(() => {
  const source = state.adminUsage || {}
  const rows = (byModel.value ? source.models : source.users) || []
  const keyword = state.adminSearch.trim().toLowerCase()
  if (!keyword) return rows
  /**
   * 搜索框在两个维度上搜的东西不一样，但都**连另一维一起搜**：
   * 按用户时输 `opus` 能筛出"用过 opus 的人"，按模型时输 `zhangsan` 能筛出
   * "张三用过的模型"。只搜主维的话，这个框在另一页上就像坏了。
   */
  return rows.filter((row) => String(rowKey(row) || '').toLowerCase().includes(keyword)
    || rowChildren(row).some((child) => String(childKey(child) || '').toLowerCase().includes(keyword)))
})

/** 只把用过的算进这句话：0 那些行在表里有意义（"他没用过"），在这句话里没有 */
const activeCount = computed(() => ((state.adminUsage?.users) || []).filter((row) => row.tokens > 0).length)
/**
 * 服务端给的数（两个视图都有）。不用 `models.length` —— 那个只在按模型看时才存在，
 * 于是「模型」这一格会在切到按用户看时凭空消失。
 */
const modelCount = computed(() => state.adminUsage?.modelCount || 0)

/**
 * 表头那句话。
 *
 * 合计与统计块**始终是整个时间窗的**（搜索不改变它们：那是这个部署真的花掉的量）。
 * 所以一旦在搜，就必须把"现在列出来的只是一部分"写出来 —— 否则
 * "合计 677,101 tokens · 1 个模型"读起来像是这一个模型花掉了 67 万。
 */
const listedNote = computed(() => {
  const total = byModel.value ? modelCount.value : activeCount.value
  const unit = byModel.value ? '个模型' : '人在用'
  if (!state.adminSearch.trim()) return `${total} ${unit}`
  return `筛出 ${usageRows.value.length} / ${total} ${byModel.value ? '个模型' : '人'}`
})

/**
 * 条形图的标尺。
 *
 * 按**当前这张表里的最大值**归一，而不是按合计 —— 一个部署里最多的那个人常常
 * 占不到总量的三成，按合计归一之后所有条都短得看不出差别，而"谁比谁多"正是
 * 这一列存在的唯一理由。数字本身照样印在旁边，条只是让排序看得更快。
 */
const barMax = (rows) => Math.max(1, ...rows.map((row) => row.tokens || 0))
/** 非零的最小宽度是 2%：一个"有一点点"的人不该和"完全没用过"长得一样 */
const barWidth = (value, max) => `${Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100))}%`

const usageMax = computed(() => barMax(usageRows.value))
const trend = computed(() => state.adminUsageTrend)
const trendMax = computed(() => barMax(trend.value?.daily || []))
</script>

<template>
  <main class="admin">
    <header class="ad-head">
      <!--
        这一页占满整个窗口，没有会话列表，所以**这个按钮是唯一的出口** ——
        它不能是一个只有图标的小按钮（那种在满屏的表格旁边找不着），
        写清"返回对话"，并且是顶栏最左边第一个东西。Esc 也能退（见 App.vue）。
      -->
      <button type="button" class="ghost-btn back-btn" title="返回对话（Esc）" @click="closeAdmin">
        <AppIcon name="chevron-right" :size="14" class="back" />返回对话
      </button>
      <h1><AppIcon name="shield" :size="15" />管理员控制台</h1>

      <nav class="tabs">
        <button type="button" :class="{ on: state.adminTab === 'users' }" @click="setAdminTab('users')">账号</button>
        <button type="button" :class="{ on: state.adminTab === 'models' }" @click="setAdminTab('models')">模型</button>
        <button type="button" :class="{ on: state.adminTab === 'groups' }" @click="setAdminTab('groups')">分组</button>
        <button type="button" :class="{ on: state.adminTab === 'usage' }" @click="setAdminTab('usage')">Token 用量</button>
      </nav>

      <span v-if="state.adminTab === 'users'" class="head-count">
        {{ state.adminUsers.length }} 个账号 · {{ admins.length }} 个管理员
      </span>
      <span v-else-if="state.adminTab === 'models'" class="head-count">
        {{ state.adminModels.filter((m) => m.enabled).length }} 个启用 · 共 {{ state.adminModels.length }} 个
      </span>
      <span v-else-if="state.adminTab === 'groups'" class="head-count">
        {{ state.adminGroups.length }} 个分组 · {{ state.adminUngrouped }} 人无分组
      </span>
      <span v-else-if="state.adminUsage?.enabled" class="head-count">
        合计 {{ formatTokens(state.adminUsage.total.tokens) }} tokens · {{ listedNote }}
      </span>

      <div class="head-right">
        <div v-if="state.adminTab !== 'groups'" class="search">
          <AppIcon name="search" :size="14" />
          <input
            v-model="state.adminSearch"
            type="search"
            :placeholder="state.adminTab === 'usage' ? '搜用户名或模型'
              : state.adminTab === 'models' ? '搜模型名 / ID / 地址' : '搜用户名'"
          />
        </div>
        <!-- 维度与时间窗紧挨着刷新：它们是同一类动作（换一份要看的数） -->
        <template v-if="state.adminTab === 'usage'">
          <div class="ranges">
            <button
              v-for="group in GROUPS"
              :key="group.key"
              type="button"
              :class="{ on: state.adminUsageGroup === group.key }"
              :disabled="state.adminUsageLoading"
              @click="setUsageGroup(group.key)"
            >{{ group.label }}</button>
          </div>
          <div class="ranges">
            <button
              v-for="range in RANGES"
              :key="range.days"
              type="button"
              :class="{ on: state.adminUsageDays === range.days }"
              :disabled="state.adminUsageLoading"
              @click="setUsageDays(range.days)"
            >{{ range.label }}</button>
          </div>
        </template>
        <button
          type="button"
          class="icon-btn"
          title="刷新"
          @click="state.adminTab === 'usage' ? refreshUsage()
            : state.adminTab === 'models' ? refreshModels()
              : state.adminTab === 'groups' ? refreshGroups() : refreshUsers()"
        >
          <AppIcon name="refresh" :size="16" />
        </button>
        <button v-if="state.adminTab === 'users'" type="button" class="primary-btn" @click="creating = !creating">
          <AppIcon name="plus" :size="14" />新建账号
        </button>
        <button v-else-if="state.adminTab === 'models'" type="button" class="primary-btn" @click="startCreateModel">
          <AppIcon name="plus" :size="14" />添加模型
        </button>
        <button v-else-if="state.adminTab === 'groups'" type="button" class="primary-btn" @click="startCreateGroup">
          <AppIcon name="plus" :size="14" />新建分组
        </button>
      </div>
    </header>

    <section class="ad-body">
      <p v-if="state.adminNote" class="note" :class="{ warn: state.adminNoteWarn }">{{ state.adminNote }}</p>

      <!-- ══════════ 账号 ══════════ -->
      <template v-if="state.adminTab === 'users'">
        <!-- ── 新建 ── -->
        <form v-if="creating" class="create" @submit.prevent="onCreate">
          <div class="create-row">
            <label>
              <span>用户名</span>
              <input v-model="form.username" placeholder="字母、数字、点、下划线、连字符" autocomplete="off" />
            </label>
            <label>
              <span>初始密码</span>
              <input v-model="form.password" type="password" placeholder="至少 8 位" autocomplete="new-password" />
            </label>
            <!--
              邮箱选填。管理员建的账号**一律直接可用**，不用等验证码 ——
              人就在他面前，身份已经确认过了；这一栏留的是"以后联系得上"。
            -->
            <label>
              <span>邮箱<span class="opt">（选填）</span></span>
              <input v-model="form.email" type="email" placeholder="用于联系" autocomplete="off" />
            </label>
            <label class="narrow">
              <span>角色</span>
              <select v-model="form.role">
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </select>
            </label>
            <label class="narrow">
              <span>分组</span>
              <select v-model="form.groupId">
                <!-- :value="undefined" = 不传这个字段，由服务端落到默认分组 -->
                <option :value="undefined">
                  {{ defaultGroupName ? `默认（${defaultGroupName}）` : '默认（暂无默认分组）' }}
                </option>
                <option value="">不进任何分组</option>
                <option v-for="group in state.adminGroups" :key="group.id" :value="group.id">{{ group.name }}</option>
              </select>
            </label>
          </div>
          <div class="create-foot">
            <!--
              这句必须写在建号的地方，而不是等出了事再解释：初始密码是**管理员设的**，
              他知道它是什么，直到对方改掉为止。
            -->
            <p class="hint">
              初始密码由你设定，请通过可靠渠道告诉对方，并让他登录后在「我的账号」里自行修改。
            </p>
            <button type="button" class="ghost-btn" @click="creating = false">取消</button>
            <button type="submit" class="primary-btn" :disabled="state.adminBusy">创建</button>
          </div>
        </form>

        <div v-if="state.adminLoading && !state.adminUsers.length" class="empty">
          <span class="spinner" />正在加载…
        </div>

        <table v-else-if="shown.length" class="users accounts">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>分组</th>
              <th>邮箱</th>
              <th>状态</th>
              <th>创建时间</th>
              <th class="acts-col">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="user in shown" :key="user.username">
              <tr :class="{ off: user.disabled }">
                <td class="name">
                  <AppIcon name="user" :size="13" />{{ user.username }}
                  <span v-if="isMe(user)" class="tag me">这是你</span>
                </td>
                <td>
                  <span v-if="user.role === 'admin'" class="tag admin">管理员</span>
                  <span v-else class="muted">普通用户</span>
                </td>
                <!--
                  分组直接在行里改，不用进另一个页面。
                  它是这一列**唯一**的动作，而且是可逆的（改错了再改回来，
                  代价只是那个人的可选模型变了一次），所以不值得一次确认对话框。
                -->
                <td>
                  <select
                    class="row-select"
                    :value="user.groupId"
                    :disabled="state.adminBusy"
                    @change="setUserGroup(user.username, $event.target.value)"
                  >
                    <option value="">无分组</option>
                    <option v-for="group in state.adminGroups" :key="group.id" :value="group.id">
                      {{ group.name }}
                    </option>
                    <!-- 指着一个已删除的分组时，别让 select 显示成空 -->
                    <option v-if="user.groupId && !groupName(user.groupId)" :value="user.groupId">
                      {{ groupLabel(user.groupId) }}
                    </option>
                  </select>
                </td>
                <td class="muted">{{ user.email || '—' }}</td>
                <td>
                  <span v-if="user.disabled" class="tag off-tag">已禁用</span>
                  <!--
                    未激活 = 自助注册了但还没填验证码。要单独标出来：
                    否则管理员看到的是一个"正常"的账号，而那个人根本登不进去，
                    来问的时候两边都说不清是怎么回事。
                  -->
                  <span v-else-if="!user.activated" class="tag off-tag">未激活</span>
                  <span v-else class="muted">正常</span>
                </td>
                <td class="muted time">{{ user.createdAt ? formatDateTime(user.createdAt) : '—' }}</td>
                <td class="acts">
                  <button
                    type="button"
                    class="ghost-btn"
                    :disabled="state.adminBusy"
                    @click="startReset(user.username)"
                  >重置密码</button>
                  <button
                    type="button"
                    class="ghost-btn"
                    :disabled="state.adminBusy || isMe(user) || isLastAdmin(user)"
                    :title="isMe(user) ? '不能改自己的角色' : isLastAdmin(user) ? '这是最后一个管理员，降级之后就没人能改回来了' : ''"
                    @click="onToggleRole(user)"
                  >{{ user.role === 'admin' ? '取消管理员' : '设为管理员' }}</button>
                  <button
                    type="button"
                    class="ghost-btn"
                    :class="{ danger: !user.disabled }"
                    :disabled="state.adminBusy || (isMe(user) && !user.disabled) || (isLastAdmin(user) && !user.disabled)"
                    :title="isMe(user) ? '不能禁用自己 —— 那样就再没人能把它打开了' : isLastAdmin(user) ? '这是最后一个管理员' : ''"
                    @click="onToggleDisabled(user)"
                  >{{ user.disabled ? '启用' : '禁用' }}</button>
                </td>
              </tr>
              <tr v-if="resetting === user.username" class="reset-row">
                <!-- 列数跟着上面那张表头走：用户名 / 角色 / 分组 / 邮箱 / 状态 / 创建时间 / 操作 -->
                <td colspan="7">
                  <form class="reset" @submit.prevent="onReset(user.username)">
                    <span class="reset-label">给 <strong>{{ user.username }}</strong> 设一个新密码：</span>
                    <input
                      v-model="newPassword"
                      type="password"
                      placeholder="至少 8 位"
                      autocomplete="new-password"
                    />
                    <button type="submit" class="primary-btn" :disabled="state.adminBusy || !newPassword">确定</button>
                    <button type="button" class="ghost-btn" @click="resetting = ''">取消</button>
                  </form>
                </td>
              </tr>
            </template>
          </tbody>
        </table>

        <p v-else class="empty">没有匹配的账号。</p>

        <!--
          ── 本部署 ──
          管理员最常问的下一个问题是"这台跑的是什么配置"。这些值全部来自 /healthz
          （首屏已经取过），不需要任何新的接口，也不含任何用户数据。
        -->
        <section v-if="state.health" class="deploy">
          <h2>本部署</h2>
          <dl>
            <div><dt>存储</dt><dd>{{ state.health.storage || '—' }}</dd></div>
            <div><dt>身份</dt><dd>{{ state.health.authMode }}</dd></div>
            <div><dt>模型</dt><dd>{{ state.health.llmMode }}</dd></div>
            <div><dt>沙盒</dt><dd>{{ state.health.sandbox }}</dd></div>
            <div><dt>自助注册</dt><dd>{{ state.features.register ? '开' : '关' }}</dd></div>
            <div><dt>作品分享</dt><dd>{{ state.features.artifactShare ? (state.features.artifactMarket ? '开（含市场）' : '开') : '关' }}</dd></div>
            <div><dt>定时任务</dt><dd>{{ state.features.cron ? (state.features.cronScheduler ? '开（本副本调度）' : '开（本副本不调度）') : '关' }}</dd></div>
            <div><dt>并发上限</dt><dd>{{ state.health.budget ?? '—' }}</dd></div>
          </dl>
        </section>
      </template>

      <!-- ══════════ 模型 ══════════ -->
      <template v-else-if="state.adminTab === 'models'">
        <!--
          ── 这份清单现在生不生效 ──
          一个配得完全正确的模型，在 LLM_MODE≠db 的部署上是**一点作用都没有**的，
          而界面上看不出任何区别。这条提示是唯一能防住"配完了以为好了"的东西，
          所以它排在最上面，而不是折在某个说明文字里。
        -->
        <p v-if="!state.adminModelsMeta.effective" class="note warn">
          本部署当前的模型来源是 <strong>LLM_MODE={{ state.adminModelsMeta.llmMode || '未知' }}</strong>，
          这里配置的模型<strong>不会生效</strong>。改成 <code>LLM_MODE=db</code> 并重启后，
          用户能用的就是下面这份清单。现在可以先把模型配好，再切换 —— 顺序反过来会有一段
          「所有人都没有模型可用」的空窗。
        </p>
        <p v-else-if="!state.adminModelsMeta.encrypted" class="note">
          模型的 API Key 以<strong>明文</strong>存在数据库里，挡住它的只有数据库的访问控制。
          配置 <code>LLM_CONFIG_SECRET</code> 后新保存的 Key 会加密入库（AES-256-GCM）；
          换掉或丢掉这个密钥，已加密的 Key 就解不开了。
        </p>

        <!-- ── 新建 / 编辑（同一个表单，只有提交去处不同）── -->
        <form v-if="state.adminModelEditing === 'new'" class="create" @submit.prevent="onSubmitModel">
          <div class="create-row">
            <label>
              <span>名称</span>
              <input v-model="modelForm.name" placeholder="给人看的名字，如「生产 Claude」" autocomplete="off" />
            </label>
            <label>
              <span>模型 ID</span>
              <input v-model="modelForm.model" placeholder="发给上游的那个名字，如 claude-sonnet-5" autocomplete="off" />
            </label>
          </div>
          <div class="create-row">
            <label class="wide">
              <span>接口地址</span>
              <input
                v-model="modelForm.baseUrl"
                placeholder="OpenAI 兼容端点，如 https://api.example.com/v1（不要带 /chat/completions）"
                autocomplete="off"
              />
            </label>
            <label>
              <span>API Key</span>
              <input v-model="modelForm.key" type="password" placeholder="留空表示这个端点不需要 Key" autocomplete="new-password" />
            </label>
          </div>
          <div class="create-row">
            <label class="narrow">
              <span>上下文长度</span>
              <input v-model="modelForm.contextWindow" type="number" min="1024" />
            </label>
            <label class="narrow">
              <span>单次输出上限</span>
              <input v-model="modelForm.maxTokens" type="number" min="0" placeholder="0 = 不发这个字段" />
            </label>
            <label class="narrow">
              <span>上限字段名</span>
              <select v-model="modelForm.maxTokensField">
                <option value="">自动探测</option>
                <option value="max_tokens">max_tokens</option>
                <option value="max_completion_tokens">max_completion_tokens</option>
              </select>
            </label>
            <label class="narrow">
              <span>排序</span>
              <input v-model="modelForm.sort" type="number" />
            </label>
          </div>
          <div class="create-row switches">
            <label class="switch"><input v-model="modelForm.image" type="checkbox" /><span>支持读图</span></label>
            <label class="switch"><input v-model="modelForm.reasoning" type="checkbox" /><span>思维链模型</span></label>
            <label class="switch"><input v-model="modelForm.enabled" type="checkbox" /><span>启用</span></label>
          </div>
          <!--
            ── 可用范围 ──
            一个都不勾 = 所有分组可用。这个默认值是有取舍的：管理员配第一个模型时
            多半还没建任何分组，如果"不勾 = 谁也用不了"，他配完之后打开对话框会
            发现一个模型都没有，而界面上完全看不出问题在哪。
          -->
          <div class="scope">
            <span class="scope-label">可用分组</span>
            <div class="scope-list">
              <label v-for="group in state.adminGroups" :key="group.id" class="switch">
                <input
                  type="checkbox"
                  :checked="modelForm.groups.includes(group.id)"
                  @change="toggleModelGroup(group.id)"
                />
                <span>{{ group.name }}</span>
              </label>
              <span v-if="!state.adminGroups.length" class="hint">
                还没有任何分组。不建分组也能用 —— 那样所有人都能用所有启用的模型。
              </span>
            </div>
            <p class="hint">一个都不勾 = 所有分组（含没有分组的人）都能用。</p>
          </div>
          <div class="create-foot">
            <p class="hint">保存后<strong>立刻生效</strong>，不需要重启。</p>
            <button type="button" class="ghost-btn" @click="state.adminModelEditing = ''">取消</button>
            <button type="submit" class="primary-btn" :disabled="state.adminBusy">添加</button>
          </div>
        </form>

        <div v-if="state.adminModelsLoading && !state.adminModels.length" class="empty">
          <span class="spinner" />正在加载…
        </div>

        <table v-else-if="shownModels.length" class="users models">
          <thead>
            <tr>
              <th>名称</th>
              <th>模型 ID</th>
              <th>接口地址</th>
              <th>Key</th>
              <th>可用分组</th>
              <th>状态</th>
              <th class="acts-col">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="model in shownModels" :key="model.id">
              <tr :class="{ off: !model.enabled }">
                <td class="name">
                  <AppIcon name="sparkle" :size="13" filled />{{ model.name }}
                  <span v-if="model.reasoning" class="tag">思维链</span>
                  <span v-if="model.input.includes('image')" class="tag">读图</span>
                </td>
                <td class="mono">{{ model.model }}</td>
                <td class="muted mono url">{{ model.baseUrl }}</td>
                <td>
                  <!--
                    只显示掩码。管理员在这一列要回答的问题只有"配没配、是不是我以为
                    的那一把"，前四位加后四位足够 —— 而完整的 Key 一旦渲染出来，
                    就会进浏览器缓存、进截图、进录屏。
                  -->
                  <span v-if="model.keyBroken" class="tag off-tag" title="LLM_CONFIG_SECRET 与写入时不一致，或这条记录被改过">
                    解不开
                  </span>
                  <span v-else-if="model.hasKey" class="mono muted">{{ model.keyMask }}</span>
                  <span v-else class="muted">—</span>
                </td>
                <td class="muted">{{ modelScope(model) }}</td>
                <td>
                  <span v-if="model.enabled" class="muted">已启用</span>
                  <span v-else class="tag off-tag">已停用</span>
                </td>
                <td class="acts">
                  <button type="button" class="ghost-btn" :disabled="state.adminBusy" @click="startEditModel(model)">
                    {{ state.adminModelEditing === model.id ? '收起' : '编辑' }}
                  </button>
                  <button
                    type="button"
                    class="ghost-btn"
                    :disabled="state.adminBusy"
                    @click="setModelEnabled(model.id, !model.enabled)"
                  >{{ model.enabled ? '停用' : '启用' }}</button>
                  <button
                    type="button"
                    class="ghost-btn danger"
                    :disabled="state.adminBusy"
                    @click="onDeleteModel(model)"
                  >删除</button>
                </td>
              </tr>

              <!-- 就地展开编辑：上一行就是它的名字，不会出现"弹框弹出来忘了点的是谁" -->
              <tr v-if="state.adminModelEditing === model.id" class="reset-row">
                <td colspan="7">
                  <form class="create" @submit.prevent="onSubmitModel">
                    <div class="create-row">
                      <label><span>名称</span><input v-model="modelForm.name" autocomplete="off" /></label>
                      <label><span>模型 ID</span><input v-model="modelForm.model" autocomplete="off" /></label>
                    </div>
                    <div class="create-row">
                      <label class="wide"><span>接口地址</span><input v-model="modelForm.baseUrl" autocomplete="off" /></label>
                      <label>
                        <span>API Key</span>
                        <input
                          v-model="modelForm.key"
                          type="password"
                          :placeholder="model.hasKey ? `留空 = 不改（当前 ${model.keyMask}）` : '留空 = 不配 Key'"
                          autocomplete="new-password"
                        />
                      </label>
                    </div>
                    <div class="create-row">
                      <label class="narrow"><span>上下文长度</span><input v-model="modelForm.contextWindow" type="number" min="1024" /></label>
                      <label class="narrow"><span>单次输出上限</span><input v-model="modelForm.maxTokens" type="number" min="0" /></label>
                      <label class="narrow">
                        <span>上限字段名</span>
                        <select v-model="modelForm.maxTokensField">
                          <option value="">自动探测</option>
                          <option value="max_tokens">max_tokens</option>
                          <option value="max_completion_tokens">max_completion_tokens</option>
                        </select>
                      </label>
                      <label class="narrow"><span>排序</span><input v-model="modelForm.sort" type="number" /></label>
                    </div>
                    <div class="create-row switches">
                      <label class="switch"><input v-model="modelForm.image" type="checkbox" /><span>支持读图</span></label>
                      <label class="switch"><input v-model="modelForm.reasoning" type="checkbox" /><span>思维链模型</span></label>
                      <label class="switch"><input v-model="modelForm.enabled" type="checkbox" /><span>启用</span></label>
                    </div>
                    <div class="scope">
                      <span class="scope-label">可用分组</span>
                      <div class="scope-list">
                        <label v-for="group in state.adminGroups" :key="group.id" class="switch">
                          <input
                            type="checkbox"
                            :checked="modelForm.groups.includes(group.id)"
                            @change="toggleModelGroup(group.id)"
                          />
                          <span>{{ group.name }}</span>
                        </label>
                        <span v-if="!state.adminGroups.length" class="hint">还没有任何分组。</span>
                      </div>
                      <p class="hint">一个都不勾 = 所有分组（含没有分组的人）都能用。</p>
                    </div>
                    <div class="create-foot">
                      <p class="hint">保存后立刻生效。</p>
                      <button type="button" class="ghost-btn" @click="state.adminModelEditing = ''">取消</button>
                      <button type="submit" class="primary-btn" :disabled="state.adminBusy">保存</button>
                    </div>
                  </form>
                </td>
              </tr>
            </template>
          </tbody>
        </table>

        <p v-else class="empty">
          {{ state.adminSearch.trim() ? '没有匹配的模型。'
            : '还没有配置任何模型。点右上角「添加模型」，填上 OpenAI 兼容端点的地址与 Key 即可。' }}
        </p>

        <!--
          排序不是装饰：**列表里的第一个就是用户没有指定模型时用的那个**。
          这句话必须写在页面上，否则"默认模型是哪个"只能靠试。
        -->
        <p v-if="state.adminModels.length" class="hint">
          排序值小的排在前面。<strong>启用的第一个就是默认模型</strong> ——
          用户在对话框里不选模型时用的就是它。
        </p>
      </template>

      <!-- ══════════ 分组 ══════════ -->
      <template v-else-if="state.adminTab === 'groups'">
        <p class="note">
          分组决定<strong>一个人能用哪些模型</strong>、<strong>能用多少 token</strong>。它不是角色（能不能管别人那是「账号」页的管理员开关），
          也不是隔离边界 —— 会话、作品、记忆一直是按账号隔离的，与分组无关。
          没有分组的人能用的是那些<strong>没有限制可用范围</strong>的模型，且不受额度限制。
        </p>
        <!--
          这两句要写在页面上，不能只写在代码注释里 —— 它们是管理员**填之前**
          就必须知道的事，填完再从别处发现"原来是每人一份"就晚了。
        -->
        <p class="note">
          两个额度都是<strong>按人算</strong>的：填 100 万的意思是"组里每个人各有 100 万"，不是全组共用。
          口径是<strong>输入 + 输出</strong>（不含缓存读入），与「用量」页那张表一致；
          总额度<strong>永不重置</strong>，每日额度按 {{ state.adminQuotaTimezone || 'Asia/Shanghai' }} 的零点归零。留空或 0 = 不限。
        </p>

        <form v-if="state.adminGroupEditing === 'new'" class="create" @submit.prevent="onSubmitGroup">
          <div class="create-row">
            <label>
              <span>分组名</span>
              <input v-model="groupForm.name" placeholder="如「研发」「试用」" autocomplete="off" />
            </label>
            <label class="wide">
              <span>说明（可选）</span>
              <input v-model="groupForm.description" placeholder="这个分组是给谁的、为什么这么分" autocomplete="off" />
            </label>
          </div>
          <div class="create-row">
            <label>
              <span>总额度（tokens）</span>
              <input v-model="groupForm.tokenQuota" type="number" min="0" step="10000" placeholder="留空 = 不限" />
            </label>
            <label>
              <span>每日额度（tokens）</span>
              <input v-model="groupForm.dailyTokenQuota" type="number" min="0" step="10000" placeholder="留空 = 不限" />
            </label>
          </div>
          <div class="create-row switches">
            <label class="switch">
              <input v-model="groupForm.isDefault" type="checkbox" />
              <span>设为默认分组（新建的账号自动进这里）</span>
            </label>
          </div>
          <div class="create-foot">
            <p class="hint">最多只有一个默认分组：设了新的，旧的会自动取消。</p>
            <button type="button" class="ghost-btn" @click="state.adminGroupEditing = ''">取消</button>
            <button type="submit" class="primary-btn" :disabled="state.adminBusy">新建</button>
          </div>
        </form>

        <div v-if="state.adminGroupsLoading && !state.adminGroups.length" class="empty">
          <span class="spinner" />正在加载…
        </div>

        <table v-else-if="state.adminGroups.length" class="users groups">
          <thead>
            <tr>
              <th>分组</th>
              <th>说明</th>
              <th class="num">人数</th>
              <th class="num">可用模型</th>
              <th class="num">总额度</th>
              <th class="num">每日额度</th>
              <th class="acts-col">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="group in state.adminGroups" :key="group.id">
              <tr>
                <td class="name">
                  <AppIcon name="user" :size="13" />{{ group.name }}
                  <span v-if="group.isDefault" class="tag admin">默认</span>
                </td>
                <td class="muted">{{ group.description || '—' }}</td>
                <td class="num">{{ group.userCount }}</td>
                <!--
                  这一格回答的是"这个组的人现在有没有模型可用"。0 要显眼：
                  那个组里的人打开对话框会是空的，而他们不会知道为什么。
                -->
                <td class="num" :class="{ warnnum: !group.modelCount }">{{ group.modelCount }}</td>
                <!--
                  「不限」写成灰字而不是 0 或空白：0 在这一列上会被读成"一点都不给"，
                  而空白看起来像是这一格没加载出来。
                -->
                <td class="num" :class="{ muted: !group.tokenQuota }">
                  {{ group.tokenQuota ? formatTokens(group.tokenQuota) : '不限' }}
                </td>
                <td class="num" :class="{ muted: !group.dailyTokenQuota }">
                  {{ group.dailyTokenQuota ? formatTokens(group.dailyTokenQuota) : '不限' }}
                </td>
                <td class="acts">
                  <button type="button" class="ghost-btn" :disabled="state.adminBusy" @click="startEditGroup(group)">
                    {{ state.adminGroupEditing === group.id ? '收起' : '编辑' }}
                  </button>
                  <button
                    type="button"
                    class="ghost-btn"
                    :disabled="state.adminBusy || group.isDefault"
                    :title="group.isDefault ? '默认分组不能直接设回非默认：把别的分组设为默认即可' : ''"
                    @click="updateGroup(group.id, { isDefault: true })"
                  >设为默认</button>
                  <button type="button" class="ghost-btn danger" :disabled="state.adminBusy" @click="onDeleteGroup(group)">
                    删除
                  </button>
                </td>
              </tr>
              <tr v-if="state.adminGroupEditing === group.id" class="reset-row">
                <td colspan="7">
                  <form class="create" @submit.prevent="onSubmitGroup">
                    <div class="create-row">
                      <label><span>分组名</span><input v-model="groupForm.name" autocomplete="off" /></label>
                      <label class="wide"><span>说明</span><input v-model="groupForm.description" autocomplete="off" /></label>
                    </div>
                    <div class="create-row">
                      <label>
                        <span>总额度（tokens）</span>
                        <input v-model="groupForm.tokenQuota" type="number" min="0" step="10000" placeholder="留空 = 不限" />
                      </label>
                      <label>
                        <span>每日额度（tokens）</span>
                        <input v-model="groupForm.dailyTokenQuota" type="number" min="0" step="10000" placeholder="留空 = 不限" />
                      </label>
                    </div>
                    <div class="create-foot">
                      <!--
                        调高额度对已经被拦住的人是**立刻生效**的：闸门每一轮都重新查一次，
                        没有任何缓存。这句话要写在这里 —— 否则管理员改完会去猜"要不要让他重新登录"。
                      -->
                      <p class="hint">改名不影响成员：模型和账号存的是分组 id，不是名字。改额度下一轮对话就生效。</p>
                      <button type="button" class="ghost-btn" @click="state.adminGroupEditing = ''">取消</button>
                      <button type="submit" class="primary-btn" :disabled="state.adminBusy">保存</button>
                    </div>
                  </form>
                </td>
              </tr>
            </template>
            <!--
              无分组的人也占一行。不列的话，各分组人数加起来对不上账号总数，
              而那个差额没有任何地方解释得了。
            -->
            <tr v-if="state.adminUngrouped" class="ungrouped">
              <td class="name muted"><AppIcon name="user" :size="13" />无分组</td>
              <td class="muted">只能用那些不限可用范围的模型</td>
              <td class="num">{{ state.adminUngrouped }}</td>
              <td class="num">{{ state.adminModels.filter((m) => m.enabled && !m.groups.length).length }}</td>
              <!-- 无分组 = 没有额度可言。额度挂在分组上，没有分组就没有那两个数 -->
              <td class="num muted">不限</td>
              <td class="num muted">不限</td>
              <td />
            </tr>
          </tbody>
        </table>

        <p v-else class="empty">
          还没有分组。不建分组也能用 —— 那样所有人都能用所有启用的模型。
          要区别对待时（比如只给一部分人开贵的模型），在这里建一个。
        </p>
      </template>

      <!-- ══════════ Token 用量 ══════════ -->
      <template v-else>
        <div v-if="state.adminUsageLoading && !state.adminUsage" class="empty">
          <span class="spinner" />正在统计…
        </div>

        <!--
          这个部署没在记账（没接结构化存储时）。说清楚"从什么时候起才有数"很重要 ——
          否则升级上来的部署会显示一张几乎全 0 的表，看起来像是没人在用。
        -->
        <p v-else-if="!state.adminUsage?.enabled" class="empty">
          本部署没有开启用量台账，看不到 token 用量。
        </p>

        <template v-else>
          <!--
            四个数：总量在最前面（它是这一页的答案），输入/输出/缓存读入在后面。
            缓存读入单列而不是并进总量：它是另一档计价（便宜一个数量级），
            加进去会让"总用量"既不等于花的钱、也不等于模型看的字数。
          -->
          <dl class="tiles">
            <div class="tile lead">
              <dt>总 token</dt>
              <dd>{{ formatTokens(state.adminUsage.total.tokens) }}</dd>
            </div>
            <div class="tile"><dt>输入</dt><dd>{{ formatTokens(state.adminUsage.total.input) }}</dd></div>
            <div class="tile"><dt>输出</dt><dd>{{ formatTokens(state.adminUsage.total.output) }}</dd></div>
            <div class="tile">
              <dt>缓存读入</dt>
              <dd>{{ formatTokens(state.adminUsage.total.cacheRead) }}</dd>
            </div>
            <div class="tile"><dt>run 次数</dt><dd>{{ formatTokens(state.adminUsage.total.runs) }}</dd></div>
            <!-- 用到了几个模型：多模型切换开起来之后，这个数本身就是一条信息 -->
            <div v-if="modelCount" class="tile"><dt>模型</dt><dd>{{ modelCount }}</dd></div>
          </dl>

          <p class="hint range-note">
            {{ state.adminUsage.since ? `统计自 ${formatDateTime(state.adminUsage.since)}` : '统计全部历史' }}
            · 只统计跑成功且真的花了 token 的 run，失败的那些不在其中
            · 每一行都按模型分开记账（模型单价差一个数量级，不分开就是笔糊涂账）
          </p>

          <table v-if="usageRows.length" class="users usage">
            <thead>
              <tr>
                <th>{{ byModel ? '模型' : '用户名' }}</th>
                <th class="dim-col">{{ byModel ? '使用者' : '模型' }}</th>
                <th class="num">合计</th>
                <th class="num">输入</th>
                <th class="num">输出</th>
                <th class="num">缓存读入</th>
                <th class="num">run</th>
                <th>最近一次</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="row in usageRows" :key="rowKey(row)">
                <!--
                  整行可点：点开是这一行的按天曲线 + 另一维的完整拆分。
                  一行 0 的也能点（点开是一句"这段时间没有用量"），不特殊处理 ——
                  "点了没反应"比"点开是空的"更让人怀疑是不是坏了。
                -->
                <tr
                  class="clickable"
                  :class="{ off: row.disabled, on: state.adminUsageOpen === rowKey(row) }"
                  @click="openUsageRow(rowKey(row))"
                >
                  <td class="name">
                    <!-- sparkle 是这个界面里代表"模型/助手"的那个记号（见 AssistantMessage） -->
                    <AppIcon :name="byModel ? 'sparkle' : 'user'" :size="13" :filled="byModel" />
                    <span class="row-name" :title="rowKey(row)">{{ label(rowKey(row)) }}</span>
                    <span v-if="!byModel && row.role === 'admin'" class="tag admin">管理员</span>
                    <span v-if="row.disabled" class="tag off-tag">已禁用</span>
                    <!-- 账号已经不在了，但它的账还在台账里。藏起来只会让合计对不上 -->
                    <span v-if="row.orphan" class="tag off-tag" title="这个账号已经不存在了，用量是它留下的">账号已删除</span>
                  </td>
                  <!--
                    ── 另一维就在行上，不用点开 ──
                    这一列是这次改动的重点：以前模型只在展开之后才出现，于是"用量和
                    模型的关系"在表上根本看不见。现在每一行都写着占比最大的那个，
                    多于一个时后面缀 `+N`，点开看全部。
                  -->
                  <td class="dim-cell muted">
                    <template v-if="rowChildren(row).length">
                      <span class="chip" :title="childKey(rowChildren(row)[0])">
                        {{ label(childKey(rowChildren(row)[0])) }}
                      </span>
                      <span v-if="rowChildren(row).length > 1" class="more">+{{ rowChildren(row).length - 1 }}</span>
                    </template>
                    <span v-else>—</span>
                  </td>
                  <td class="num total-cell">
                    <span class="num-text">{{ formatTokens(row.tokens) }}</span>
                    <!--
                      条只是让"谁比谁多"一眼看出来，数字本身照样印着 ——
                      所以它 aria-hidden，读屏的人读到的是那个数，不是一个装饰。
                    -->
                    <span class="bar" aria-hidden="true">
                      <span class="bar-fill" :style="{ width: barWidth(row.tokens, usageMax) }" />
                    </span>
                  </td>
                  <td class="num muted">{{ formatTokens(row.input) }}</td>
                  <td class="num muted">{{ formatTokens(row.output) }}</td>
                  <td class="num muted">{{ formatTokens(row.cacheRead) }}</td>
                  <td class="num muted">{{ formatTokens(row.runs) }}</td>
                  <td class="muted time">{{ formatSince(row.lastAt) }}</td>
                </tr>

                <tr v-if="state.adminUsageOpen === rowKey(row)" class="detail-row">
                  <td colspan="8">
                    <div v-if="!row.runs" class="empty small">这段时间没有用量。</div>
                    <div v-else class="detail">
                      <!--
                        ── 拆分 ──
                        数字直接来自总表那一行（服务端一次查询里带下来的），不再打一次
                        接口。所以它与上面那一行**一定加得起来** —— 分两次取的话，
                        中间又跑了一轮就会出现"表里 450,092、展开后 450,318"。
                      -->
                      <section>
                        <h3>{{ byModel ? '这个模型被谁用了' : '这个人用了哪些模型' }}</h3>
                        <ul class="bars" :class="{ models: !byModel }">
                          <li v-for="child in rowChildren(row)" :key="childKey(child)">
                            <span class="bar-label wide" :title="childKey(child)">{{ label(childKey(child)) }}</span>
                            <span class="bar" aria-hidden="true">
                              <span class="bar-fill" :style="{ width: barWidth(child.tokens, barMax(rowChildren(row))) }" />
                            </span>
                            <span class="bar-value">{{ formatTokens(child.tokens) }}</span>
                            <span class="bar-runs">{{ child.runs }} run</span>
                          </li>
                        </ul>
                      </section>

                      <section>
                        <h3>按天</h3>
                        <div v-if="state.adminUsageTrendLoading" class="empty small">
                          <span class="spinner" />正在取趋势…
                        </div>
                        <ul v-else-if="trend?.daily?.length" class="bars">
                          <li v-for="day in trend.daily" :key="day.day">
                            <span class="bar-label">{{ day.day.slice(5) }}</span>
                            <span class="bar" aria-hidden="true">
                              <span class="bar-fill" :style="{ width: barWidth(day.tokens, trendMax) }" />
                            </span>
                            <span class="bar-value">{{ formatTokens(day.tokens) }}</span>
                            <span class="bar-runs">{{ day.runs }} run</span>
                          </li>
                        </ul>
                        <div v-else class="empty small">取不到按天数据。</div>
                      </section>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>

          <!--
            按模型这一维**只列用过的模型**：服务端没有"本部署有哪些模型"的权威清单
            （每个人的可用模型是各自从 llminfo 拿的），所以这里空就是"这段时间还没人
            用过任何模型"，而不是"模型清单取不到"。
          -->
          <p v-else class="empty">
            {{ state.adminSearch.trim() ? '没有匹配的行。' : byModel ? '这段时间还没有任何模型产生用量。' : '没有账号。' }}
          </p>
        </template>
      </template>
    </section>
  </main>
</template>

<style scoped>
/*
  ── 整个窗口都是这一页 ──────────────────────────────────────────────────
  App.vue 里它与「侧栏 + 正文」那套外壳并列，不在正文区里。所以这里要自己
  撑满高度（外壳的 .layout 给了 100dvh，flex:1 拿到全部宽度）。
*/
.admin {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--background);
}

.ad-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  height: var(--head-h);
  padding: 0 20px;
  border-bottom: 1px solid var(--border);
}
.ad-head h1 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
  white-space: nowrap;
}
/* 出口要看得见：给它一道边，别让它像一句可点的说明文字 */
.back-btn {
  border: 1px solid var(--border);
}
.head-count {
  color: var(--muted-foreground);
  font-size: 12px;
  white-space: nowrap;
}
.head-right {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.back {
  transform: rotate(180deg);
}

/* ── 两页的切换 ── */
.tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--secondary) 55%, transparent);
}
.tabs button {
  padding: 4px 11px;
  border: 0;
  border-radius: calc(var(--radius-sm) - 2px);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12.5px;
  cursor: pointer;
}
.tabs button:hover {
  color: var(--foreground);
}
.tabs button.on {
  background: var(--background);
  color: var(--foreground);
  font-weight: 500;
}

/* 时间窗：与 .tabs 同一个形状，因为它也是"这一组里选一个" */
.ranges {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--secondary) 55%, transparent);
}
.ranges button {
  padding: 3px 9px;
  border: 0;
  border-radius: calc(var(--radius-sm) - 2px);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12px;
  cursor: pointer;
}
.ranges button.on {
  background: var(--background);
  color: var(--foreground);
}
.ranges button:disabled {
  opacity: 0.6;
  cursor: default;
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--muted-foreground);
}
.search input {
  width: 150px;
  border: 0;
  background: transparent;
  color: var(--foreground);
  font-size: 12.5px;
  outline: none;
}

/*
  ── 正文的宽度 ──────────────────────────────────────────────────────────

  从 1080px 放到 1560px。这不是"能宽就宽"：

  用量表有 8 列（主维 + 另一维 + 五个数字 + 时间），账号表的操作列里有三个按钮。
  1080px 下这两张表都在**互相挤**：模型名被截成 `claude-sonn…`、三个操作按钮换行。
  1560px 之后两张表都能一行放完，而这正是表格存在的理由 —— 横向比较。

  仍然留一个上限、并且居中：一张表在 3440px 的屏上铺满，眼睛要从屏幕最左扫到
  最右才能把一行读完，那比挤更难读。
*/
.ad-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
  min-height: 0;
  width: min(1560px, 100%);
  margin: 0 auto;
  padding: 20px 24px 32px;
  overflow-y: auto;
}

.note {
  margin: 0;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--secondary) 40%, var(--background));
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.65;
}
.note.warn {
  border-color: color-mix(in srgb, var(--warning) 40%, var(--border));
  color: var(--warning);
}

/* ── 新建表单 ── */
.create {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--brand-accent) 34%, var(--border));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--brand-accent) 5%, var(--background));
}
.create-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.create label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
  min-width: 180px;
  font-size: 12px;
  color: var(--muted-foreground);
}
.create label.narrow {
  flex: 0 0 140px;
  min-width: 0;
}
/* 「（选填）」比字段名淡一档：它是补充说明，不该和标题抢注意力 */
.create label .opt {
  opacity: 0.7;
}
/* 接口地址比别的字段长得多，给它两倍的份额，否则 URL 永远只看得见前半截 */
.create label.wide {
  flex: 2;
  min-width: 260px;
}

/* ── 开关一排 ── */
.create-row.switches {
  gap: 18px;
  align-items: center;
}
.switch {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  min-width: 0;
  font-size: 12.5px;
  color: var(--foreground);
  cursor: pointer;
}
.switch input {
  width: 14px;
  height: 14px;
  accent-color: var(--brand-accent);
}

/* ── 可用分组 ── */
.scope {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--background);
}
.scope-label {
  font-size: 12px;
  color: var(--muted-foreground);
}
.scope-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
}
.scope .hint {
  flex: none;
}
.create input,
.create select {
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-size: 13px;
}
.create input:focus,
.create select:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--brand-accent) 50%, var(--border));
}
.create-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hint {
  flex: 1;
  margin: 0;
  color: var(--muted-foreground);
  font-size: 11.5px;
  line-height: 1.6;
}

/* ── 用户表 ── */
.users {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.users th {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--muted-foreground);
  font-size: 11.5px;
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
}
.users td {
  padding: 9px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  vertical-align: middle;
}
/* 禁用的行整体压暗：一眼看得出"这个人现在进不来" */
.users tr.off td {
  opacity: 0.55;
}
.name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.muted {
  color: var(--muted-foreground);
}
.time {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.tag {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--secondary);
  color: var(--muted-foreground);
  font-size: 11px;
  white-space: nowrap;
}

/* ── 行内下拉（账号表里的分组）── */
.row-select {
  max-width: 150px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-size: 12.5px;
}
.row-select:disabled {
  opacity: 0.6;
}

/* 模型 ID 和地址是要一个字一个字核对的东西，等宽字体让"看错一位"变难 */
.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
}
.url {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 「可用模型 0」要显眼：那个分组的人打开对话框是空的，而他们不会知道为什么 */
.warnnum {
  color: var(--warning);
  font-weight: 600;
}
.ungrouped td {
  border-top: 1px dashed var(--border);
}
.tag.admin {
  background: color-mix(in srgb, var(--brand-accent) 16%, transparent);
  color: var(--brand-accent);
}
.tag.me {
  background: var(--secondary);
  color: var(--muted-foreground);
}
.tag.off-tag {
  background: color-mix(in srgb, var(--destructive) 14%, transparent);
  color: var(--destructive);
}

.acts-col {
  width: 1%;
}
.acts {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
  white-space: nowrap;
}
.acts .ghost-btn {
  padding: 4px 9px;
  font-size: 12px;
}
.acts .ghost-btn.danger:hover:not(:disabled) {
  color: var(--destructive);
}

/* ── 就地重置密码 ── */
.reset-row td {
  padding: 0 10px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}
.reset {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 11px;
  border: 1px solid color-mix(in srgb, var(--brand-accent) 34%, var(--border));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--brand-accent) 5%, var(--background));
}
.reset-label {
  color: var(--muted-foreground);
  font-size: 12.5px;
}
.reset-label strong {
  color: var(--foreground);
}
.reset input {
  flex: 1;
  max-width: 240px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-size: 13px;
}
.reset input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--brand-accent) 50%, var(--border));
}
.reset .primary-btn,
.reset .ghost-btn {
  padding: 5px 11px;
  font-size: 12.5px;
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 34px 0;
  color: var(--muted-foreground);
  font-size: 13px;
}
.empty.small {
  padding: 16px 0;
  font-size: 12.5px;
}

/* ══════════ Token 用量 ══════════ */

/* 四个数一排。总量那一格字大一号：它是这一页的答案，其余三个是它的拆分 */
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin: 0;
}
.tile {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.tile dt {
  color: var(--muted-foreground);
  font-size: 11.5px;
}
.tile dd {
  margin: 3px 0 0;
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tile.lead {
  border-color: color-mix(in srgb, var(--brand-accent) 34%, var(--border));
  background: color-mix(in srgb, var(--brand-accent) 5%, var(--background));
}
.tile.lead dd {
  font-size: 19px;
}
.range-note {
  margin: -4px 0 0;
}

/* 数字列右对齐 + 等宽数字：位数对齐之后，长短本身就是"谁多谁少" */
.users .num,
.usage .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.usage tr.clickable {
  cursor: pointer;
}
.usage tr.clickable:hover td {
  background: color-mix(in srgb, var(--secondary) 45%, transparent);
}
.usage tr.on td {
  background: color-mix(in srgb, var(--brand-accent) 7%, transparent);
}
.total-cell {
  min-width: 148px;
}
.num-text {
  display: block;
  font-weight: 500;
}

/* 主维那一列的名字：模型 id 可以很长，给它一个上限并 hover 看全 */
.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

/*
  ── 另一维那一列 ──
  只写占比最大的那一个 + `+N`。写全部会把行撑成两行高，而这一列的作用是
  "扫一眼就知道这行主要花在什么上"，不是替代展开后的完整拆分。
*/
.dim-col {
  width: 1%;
}
.dim-cell {
  white-space: nowrap;
}
.chip {
  display: inline-block;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--secondary) 60%, transparent);
  color: var(--foreground);
  font-size: 11.5px;
}
.more {
  margin-left: 4px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

/*
  条形：单色、贴着基线、圆头。
  用 --brand-accent 而不是给每个人分一个颜色 —— 这一列表达的是**大小**，
  不是身份；按人上色会让"颜色"看起来像在说什么，而它什么也没说。
*/
.bar {
  display: block;
  height: 4px;
  margin-top: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--secondary) 70%, transparent);
  overflow: hidden;
}
.bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: color-mix(in srgb, var(--brand-accent) 75%, transparent);
}

/* ── 展开的明细 ── */
.detail-row td {
  padding: 0 10px 12px;
  background: color-mix(in srgb, var(--brand-accent) 4%, transparent);
}
.detail {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 18px;
  padding: 12px 13px;
  border: 1px solid color-mix(in srgb, var(--brand-accent) 28%, var(--border));
  border-radius: var(--radius-sm);
  background: var(--background);
}
.detail h3 {
  margin: 0 0 8px;
  color: var(--muted-foreground);
  font-size: 11.5px;
  font-weight: 500;
}
.bars {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
  /* 一个人跑了三个月就是 90 行，让它自己滚，不要把整页顶长 */
  max-height: 232px;
  overflow-y: auto;
}
.bars li {
  display: grid;
  grid-template-columns: 46px 1fr auto auto;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.bar-label {
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
/* 模型 id 比日期长得多，给它宽一点的那一列（`hover` 上有完整的） */
.bars.models li {
  grid-template-columns: minmax(80px, 130px) 1fr auto auto;
}
.bar-label.wide {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bars .bar {
  margin: 0;
}
.bar-value {
  min-width: 62px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.bar-runs {
  min-width: 46px;
  color: var(--muted-foreground);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* ── 本部署 ── */
.deploy {
  margin-top: 6px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.deploy h2 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
}
.deploy dl {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px 16px;
  margin: 0;
}
.deploy dl > div {
  display: flex;
  gap: 8px;
  font-size: 12.5px;
}
.deploy dt {
  flex: 0 0 76px;
  color: var(--muted-foreground);
}
.deploy dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 860px) {
  .acts {
    flex-wrap: wrap;
  }
  .time {
    display: none;
  }
  /*
    账号表：藏掉「创建时间」（第 5 列，分组那一列插进来之后它往后挪了一位）。
    表格的类名必须写具体 —— 靠 `:not(.usage)` 排除的写法在多了模型表和分组表
    之后就不成立了：那两张表的第 5 列分别是「可用分组」和「操作」。
  */
  .users.accounts th:nth-child(5) {
    display: none;
  }
  /* 模型表窄屏砍掉「接口地址」和「Key」：核对配置是坐下来做的事，不是路上做的 */
  .users.models th:nth-child(3),
  .users.models td:nth-child(3):not([colspan]),
  .users.models th:nth-child(4),
  .users.models td:nth-child(4):not([colspan]) {
    display: none;
  }
  /*
    用量表窄屏只留「主维 / 另一维 / 合计 / 输入」。
    先砍输出、缓存读入、run 次数、最近一次：它们是"再看一眼"的信息。
    **另一维那一列不砍** —— 用量和模型的关联正是这张表要说的事，
    砍掉它就退回成一列不知道花在哪的数字了。展开之后照样看得到全部。
  */
  .usage th:nth-child(n + 5),
  .usage td:nth-child(n + 5):not([colspan]) {
    display: none;
  }
  .row-name,
  .chip {
    max-width: 120px;
  }
  .detail {
    grid-template-columns: 1fr;
  }
}
</style>
