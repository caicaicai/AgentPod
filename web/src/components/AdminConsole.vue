<script setup>
import { computed, ref } from 'vue'

import AppIcon from './AppIcon.vue'
import { formatDateTime } from '../lib/format.js'
import { askConfirm } from '../lib/dialog.js'
import {
  closeAdmin, createUser, refreshUsers, resetUserPassword, setUserDisabled, setUserRole, state,
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
      <span class="head-count">{{ state.adminUsers.length }} 个账号 · {{ admins.length }} 个管理员</span>

      <div class="head-right">
        <div class="search">
          <AppIcon name="search" :size="14" />
          <input v-model="state.adminSearch" type="search" placeholder="搜用户名" />
        </div>
        <button type="button" class="icon-btn" title="刷新" @click="refreshUsers">
          <AppIcon name="refresh" :size="16" />
        </button>
        <button type="button" class="primary-btn" @click="creating = !creating">
          <AppIcon name="plus" :size="14" />新建账号
        </button>
      </div>
    </header>

    <section class="ad-body">
      <p v-if="state.adminNote" class="note" :class="{ warn: state.adminNoteWarn }">{{ state.adminNote }}</p>

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
  .users th:nth-child(4) {
    display: none;
  }
}
</style>
