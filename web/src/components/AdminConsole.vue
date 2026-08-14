<script setup>
import { computed, ref } from 'vue'

import AppIcon from './AppIcon.vue'
import { formatDateTime, formatSince, formatTokens } from '../lib/format.js'
import { askConfirm } from '../lib/dialog.js'
import {
  closeAdmin, createUser, openUsageRow, refreshUsage, refreshUsers, resetUserPassword,
  setAdminTab, setUsageDays, setUsageGroup, setUserDisabled, setUserRole, state,
} from '../stores/app.js'

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
 * ── 两页而不是一张更宽的表 ──────────────────────────────────────────────
 *
 * 「Token 用量」没有并进账号表里多加三列，因为两页问的是不同的问题：
 * 管人是**对某一行做一件事**（禁用他、重置他的密码），看用量是**把所有人排个序**
 * （谁在烧钱）。前者要按用户名找人，后者要按数字找人 —— 塞进一张表的话，
 * 操作列和数字列会互相挤，而两种任务都变难。
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
const form = ref({ username: '', password: '', role: 'user' })

async function onCreate() {
  const username = form.value.username.trim()
  if (!username || !form.value.password) {
    state.adminNote = '用户名和初始密码都要填'
    state.adminNoteWarn = true
    return
  }
  const ok = await createUser({ username, password: form.value.password, role: form.value.role })
  if (ok) {
    form.value = { username: '', password: '', role: 'user' }
    creating.value = false
  }
}

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
      <button
        v-if="state.sidebarCollapsed"
        type="button"
        class="icon-btn"
        title="展开会话列表"
        @click="state.sidebarCollapsed = false"
      >
        <AppIcon name="panel-open" :size="17" />
      </button>
      <button type="button" class="ghost-btn" title="回到对话" @click="closeAdmin">
        <AppIcon name="chevron-right" :size="14" class="back" />对话
      </button>
      <h1>管理员控制台</h1>

      <nav class="tabs">
        <button type="button" :class="{ on: state.adminTab === 'users' }" @click="setAdminTab('users')">账号</button>
        <button type="button" :class="{ on: state.adminTab === 'usage' }" @click="setAdminTab('usage')">Token 用量</button>
      </nav>

      <span v-if="state.adminTab === 'users'" class="head-count">
        {{ state.adminUsers.length }} 个账号 · {{ admins.length }} 个管理员
      </span>
      <span v-else-if="state.adminUsage?.enabled" class="head-count">
        合计 {{ formatTokens(state.adminUsage.total.tokens) }} tokens · {{ listedNote }}
      </span>

      <div class="head-right">
        <div class="search">
          <AppIcon name="search" :size="14" />
          <input
            v-model="state.adminSearch"
            type="search"
            :placeholder="state.adminTab === 'usage' ? '搜用户名或模型' : '搜用户名'"
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
          @click="state.adminTab === 'usage' ? refreshUsage() : refreshUsers()"
        >
          <AppIcon name="refresh" :size="16" />
        </button>
        <button v-if="state.adminTab === 'users'" type="button" class="primary-btn" @click="creating = !creating">
          <AppIcon name="plus" :size="14" />新建账号
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
            <label class="narrow">
              <span>角色</span>
              <select v-model="form.role">
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
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

        <table v-else-if="shown.length" class="users">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
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
                <td>
                  <span v-if="user.disabled" class="tag off-tag">已禁用</span>
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
                <td colspan="5">
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
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}
.ad-head h1 {
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
}
.head-count {
  color: var(--muted-foreground);
  font-size: 12px;
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

.ad-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
  min-height: 0;
  width: min(1080px, 100%);
  margin: 0 auto;
  padding: 18px 20px;
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
  font-size: 11px;
  white-space: nowrap;
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
  max-width: 260px;
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
  max-width: 190px;
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
  /* 账号表：藏掉「创建时间」。`:not(.usage)` 是必须的 —— 用量表的第 4 列是「输出」 */
  .users:not(.usage) th:nth-child(4) {
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
