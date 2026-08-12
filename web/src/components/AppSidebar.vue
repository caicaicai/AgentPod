<script setup>
import { computed } from 'vue'

import AppIcon from './AppIcon.vue'
import SessionRow from './SessionRow.vue'
import {
  createProject, deleteSession, getDevUsername, identityName, logout, openSession, patchSession,
  renameSession, scheduleSearch, setDevUsername, startNewSession, state, switchProject,
  toggleTheme, togglePanel, openLibrary,
} from '../stores/app.js'

/** 置顶的单独成组：它们是用户手动钉上去的，混在时间序里就等于没钉 */
const pinned = computed(() => state.sessions.filter((s) => s.pinned))
const others = computed(() => state.sessions.filter((s) => !s.pinned))

const devMode = computed(() => state.health?.authMode === 'dev')
const passwordMode = computed(() => state.health?.authMode === 'password')

function onProjectChange(event) {
  const value = event.target.value
  if (value === '__new__') {
    // 选完就把下拉框拨回原位：新建可能被取消，而下拉框停在「＋ 新建项目…」上
    // 会让人以为当前正处在一个叫这个名字的项目里
    event.target.value = state.projectId
    const name = window.prompt('项目名称', '')
    if (name?.trim()) createProject(name).then((project) => { if (project) togglePanel('project') })
    return
  }
  switchProject(value)
}

async function onRowAction(action, session) {
  const key = session.sessionKey
  if (action === 'delete') {
    if (!window.confirm(`删除会话「${session.title || key}」？此操作不可恢复。`)) return
    return deleteSession(key)
  }
  if (action === 'rename') {
    const title = window.prompt('会话名称', session.title || '')
    if (title === null) return
    return renameSession(key, title)
  }
  if (action === 'pin') return patchSession(key, { pinned: !session.pinned })
  if (action === 'archive') return patchSession(key, { archived: !session.archived })
}

function onDevUsernameChange(event) {
  setDevUsername(event.target.value.trim())
  location.reload() // 换了身份，会话、模型清单全都要重取
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-lockup">
        <span class="brand-mark"><AppIcon name="sparkle" :size="14" filled /></span>
        <span class="brand-name">AgentPod</span>
      </div>
      <button
        type="button"
        class="icon-btn"
        :title="state.sidebarCollapsed ? '展开会话列表' : '收起会话列表'"
        @click="state.sidebarCollapsed = !state.sidebarCollapsed"
      >
        <AppIcon :name="state.sidebarCollapsed ? 'panel-open' : 'panel-close'" :size="17" />
      </button>
    </div>

    <div class="sidebar-top">
      <button type="button" class="new-chat" :disabled="Boolean(state.live)" title="新对话" @click="startNewSession">
        <AppIcon name="square-pen" :size="16" /><span>新对话</span>
      </button>

      <!--
        项目切换器。
        选中某个项目之后，会话列表只显示它下面的对话，新开的对话也自动归进去 ——
        "在哪个项目里"是一个持续状态，不是每次新建时再选一遍的参数。
      -->
      <div v-if="state.features.projects" class="project-bar">
        <div class="select-wrap">
          <AppIcon name="folder" :size="14" class="select-icon" />
          <select :value="state.projectId" title="切换项目" @change="onProjectChange">
            <option value="">全部对话</option>
            <option v-for="project in state.projects" :key="project.id" :value="project.id">
              {{ project.name }}
            </option>
            <option value="__new__">＋ 新建项目…</option>
          </select>
          <AppIcon name="chevron-down" :size="13" class="select-caret" />
        </div>
        <button
          v-if="state.projectId"
          type="button"
          class="icon-btn"
          title="项目设置"
          @click="togglePanel('project')"
        >
          <AppIcon name="settings" :size="16" />
        </button>
      </div>

      <div class="search-box">
        <AppIcon name="search" :size="14" class="search-icon" />
        <input
          v-model="state.search"
          type="text"
          placeholder="搜索会话（含正文）"
          autocomplete="off"
          @input="scheduleSearch"
        />
        <button v-if="state.search" type="button" class="chip-x" title="清空" @click="state.search = ''; scheduleSearch()">
          <AppIcon name="x" :size="12" />
        </button>
      </div>
    </div>

    <nav class="session-list">
      <!-- 搜索态下列表整个换成命中结果：那是后端算的（含正文），不是本地过滤能拼出来的 -->
      <template v-if="state.searchHits">
        <div v-if="!state.searchHits.length" class="list-empty">没有匹配的会话</div>
        <template v-else>
          <div class="section-label">搜索到 {{ state.searchHits.length }} 条（含正文匹配）</div>
          <SessionRow
            v-for="session in state.searchHits"
            :key="session.sessionKey"
            :session="session"
            :active="session.sessionKey === state.activeKey"
            show-snippet
            @open="openSession"
            @action="onRowAction"
          />
        </template>
      </template>

      <template v-else>
        <div
          v-if="state.pendingNew"
          class="session-row pending"
          :class="{ active: !state.sessions.some((s) => s.sessionKey === state.activeKey) }"
        >
          <div class="session">
            <span class="title">新对话</span>
            <span class="meta">还没有消息</span>
          </div>
        </div>

        <template v-if="pinned.length">
          <div class="section-label">置顶</div>
          <SessionRow
            v-for="session in pinned"
            :key="session.sessionKey"
            :session="session"
            :active="session.sessionKey === state.activeKey"
            @open="openSession"
            @action="onRowAction"
          />
          <div v-if="others.length" class="section-label">最近</div>
        </template>

        <SessionRow
          v-for="session in others"
          :key="session.sessionKey"
          :session="session"
          :active="session.sessionKey === state.activeKey"
          @open="openSession"
          @action="onRowAction"
        />

        <div v-if="!state.sessions.length && !state.pendingNew" class="list-empty">
          {{ state.projectId ? '这个项目下还没有对话' : '还没有会话，上面开一个' }}
        </div>
      </template>
    </nav>

    <div class="sidebar-foot">
      <button type="button" class="navrow" @click="togglePanel('skills')">
        <AppIcon name="puzzle" :size="16" /><span>技能</span>
        <span class="pill">{{ state.skills.length || '–' }}</span>
      </button>
      <button v-if="state.features.memory" type="button" class="navrow" @click="togglePanel('memory')">
        <AppIcon name="brain" :size="16" /><span>长期记忆</span>
        <span class="pill">{{ state.memory.count || 0 }}</span>
      </button>
      <button v-if="state.features.cron" type="button" class="navrow" @click="togglePanel('cron')">
        <AppIcon name="clock" :size="16" /><span>定时任务</span>
        <span class="pill">{{ state.crons.filter((c) => c.enabled).length || 0 }}</span>
      </button>
      <!--
        和上面几个一样**常驻**，哪怕这条会话一份作品都没有。
        曾经做成"有作品才出现"，结果是：新装好的部署里这个功能没有任何入口，
        既看不到它存在，也无从确认它有没有生效 —— 一个要靠模型先产出点什么
        才肯现身的入口，等于没有入口。
      -->
      <button
        v-if="state.features.artifacts"
        type="button"
        class="navrow"
        :class="{ on: state.view === 'artifacts' }"
        @click="openLibrary"
      >
        <AppIcon name="app-window" :size="16" /><span>作品</span>
        <span class="pill">{{ state.libraryArtifacts.length || state.artifacts.length || 0 }}</span>
      </button>

      <div class="identity">
        <!--
          dev 模式的身份输入框必须**始终**渲染，不能挂在"接口调用成功"之后：
          后端信任 X-Username，没有它所有接口都 401，而这里又是唯一能填上它的地方 ——
          挂在成功之后就会死锁。
        -->
        <template v-if="devMode">
          <span class="identity-tag">AUTH_MODE=dev</span>
          <input
            class="username-input"
            placeholder="用户名"
            :value="getDevUsername()"
            @change="onDevUsernameChange"
          />
        </template>
        <template v-else-if="passwordMode">
          <span v-if="identityName()" class="identity-name">
            <AppIcon name="user" :size="14" />{{ identityName() }}
          </span>
          <button type="button" class="icon-btn" title="退出登录" @click="logout">
            <AppIcon name="log-out" :size="16" />
          </button>
        </template>
        <span v-else-if="identityName()" class="identity-name">
          <AppIcon name="user" :size="14" />{{ identityName() }}
        </span>
        <span v-else />

        <button
          type="button"
          class="icon-btn"
          :title="state.theme === 'dark' ? '切到浅色' : '切到深色'"
          @click="toggleTheme"
        >
          <AppIcon :name="state.theme === 'dark' ? 'sun' : 'moon'" :size="16" />
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-w);
  flex-shrink: 0;
  padding: 10px 8px;
  border-right: 1px solid var(--border);
  background: color-mix(in srgb, var(--secondary) 42%, var(--background));
  overflow: hidden;
  transition: width 0.18s ease;
}

/*
  收起来之后侧栏**留在流里**变成一条 50px 的窄轨，而不是浮在正文上面：
  浮层会盖住正文，且展开按钮本身也跟着飘走。里面的内容用 visibility 藏掉
  （不是 display:none）—— 保持原来的宽度让它被裁掉，而不是重排一遍。
*/
.layout.sidebar-collapsed .sidebar {
  width: 50px;
}
.layout.sidebar-collapsed .sidebar > :not(.brand) {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}
.layout.sidebar-collapsed .brand-lockup {
  width: 0;
  opacity: 0;
  overflow: hidden;
}
.layout.sidebar-collapsed .brand {
  padding-inline: 0;
  gap: 0;
}
.sidebar > :not(.brand) {
  min-width: calc(var(--sidebar-w) - 16px);
}
@media (prefers-reduced-motion: reduce) {
  .sidebar {
    transition: none;
  }
}

.brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 9px;
  padding: 6px 6px 14px;
  font-size: 15px;
  font-weight: 600;
  line-height: 1;
}
.brand-lockup {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  border-radius: 6px;
  background: var(--brand-accent);
  color: #fff;
}
.brand-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-top {
  flex: 0 0 auto;
}

.new-chat {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 11px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--background);
  color: var(--foreground);
  font-size: 14px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}
.new-chat:hover:not(:disabled) {
  background: var(--secondary);
}
.new-chat:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.project-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}
.select-wrap {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1;
}
.select-wrap select {
  width: 100%;
  padding: 6px 24px 6px 28px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground);
  font-size: 13px;
  cursor: pointer;
  appearance: none;
}
.select-wrap select:hover {
  background: var(--secondary);
}
.select-icon,
.select-caret {
  position: absolute;
  color: var(--muted-foreground);
  pointer-events: none;
}
.select-icon {
  left: 8px;
}
.select-caret {
  right: 7px;
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: 6px;
}
.search-box input {
  width: 100%;
  padding: 7px 26px 7px 29px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-size: 13px;
  outline: 0;
}
.search-box input::placeholder {
  color: var(--muted-foreground);
}
.search-box input:focus {
  border-color: color-mix(in srgb, var(--brand-accent) 45%, var(--border));
}
.search-icon {
  position: absolute;
  left: 9px;
  color: var(--muted-foreground);
  pointer-events: none;
}
.search-box .chip-x {
  position: absolute;
  right: 5px;
}

.session-list {
  flex: 1;
  min-height: 0;
  margin: 4px -2px 0;
  padding: 0 2px;
  overflow-y: auto;
}

.section-label {
  padding: 12px 10px 5px;
  color: var(--muted-foreground);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.list-empty {
  padding: 18px 10px;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.6;
}

/* 还没落库的「新对话」行：和真会话长得一样，但不可点也没有菜单 */
.session-row.pending .session {
  padding: 7px 10px;
  border-radius: var(--radius-sm);
}
.session-row.pending.active .session {
  background: color-mix(in srgb, var(--foreground) 9%, transparent);
}
.session-row.pending .title {
  display: block;
  overflow: hidden;
  color: var(--foreground);
  font-size: 13.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-row.pending .meta {
  display: block;
  color: var(--muted-foreground);
  font-size: 11.5px;
}

.sidebar-foot {
  flex: 0 0 auto;
  padding-top: 8px;
  margin-top: 6px;
  border-top: 1px solid var(--border);
}
.navrow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
/* 作品库是一个"去处"而不是一次动作，所以要有选中态 —— 否则用户不知道自己在哪 */
.navrow.on {
  background: color-mix(in srgb, var(--brand-accent) 12%, transparent);
  color: var(--foreground);
}

.navrow:hover {
  background: var(--secondary);
  color: var(--foreground);
}
.navrow span:not(.pill) {
  flex: 1;
  min-width: 0;
}

.identity {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 34px;
  padding: 4px 4px 0 10px;
  margin-top: 4px;
  color: var(--muted-foreground);
  font-size: 12px;
}
.identity-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.identity-tag {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  color: var(--warning);
  font-size: 10.5px;
}
.username-input {
  min-width: 0;
  flex: 1;
  padding: 4px 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--background);
  font-size: 12px;
  outline: 0;
}
</style>
