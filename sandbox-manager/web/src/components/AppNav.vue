<script setup>
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { health, me, lastUpdatedAt, canWrite, writeBlockedReason, refresh, sessionExpired, stop as stopPoll } from '@/store/cluster.js'
import StatusPill from './StatusPill.vue'
import { relativeTime } from '@/utils/format.js'
import { logout } from '@/api/client.js'

const route = useRoute()

function handleLogout() {
  logout()
  stopPoll()
  sessionExpired.value = true
}

const links = [
  { to: '/', label: '总览' },
  { to: '/nodes', label: '节点' },
  { to: '/simulate', label: '调度试算' },
  { to: '/playground', label: '测试运行' },
  { to: '/config', label: '配置自检' },
  { to: '/docs', label: '接口文档' },
]

const updated = computed(() => (lastUpdatedAt.value ? relativeTime(lastUpdatedAt.value) : '—'))
</script>

<template>
  <header class="nav">
    <div class="inner">
      <div class="brand">
        <span class="dot" :class="health.level" />
        <strong>沙盒集群管理台</strong>
        <StatusPill :level="health.level" :text="health.text" />
        <span v-if="me?.env" class="env mono">{{ me.env }}</span>
      </div>

      <nav class="links">
        <RouterLink v-for="l in links" :key="l.to" :to="l.to" :class="{ active: route.path === l.to }">
          {{ l.label }}
        </RouterLink>
      </nav>

      <div class="meta">
        <!-- 写权限没开时，把原因直接摆在最显眼处。等人点了按钮才被 403 拒绝，
             会让人以为是系统坏了而不是没配名单。 -->
        <span v-if="me && !canWrite" class="readonly" :title="writeBlockedReason">只读</span>
        <span class="faint" :title="`最后一次成功刷新：${new Date(lastUpdatedAt).toLocaleString()}`">
          {{ updated }}
        </span>
        <button @click="refresh">刷新</button>
        <span v-if="me" class="user">{{ me.user.fullname || me.user.username }}</span>
        <button class="logout-btn" title="退出登录" @click="handleLogout">退出</button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.nav {
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 20;
}
.inner {
  max-width: 1280px;
  margin: 0 auto;
  padding: 10px 24px;
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}

.brand { display: flex; align-items: center; gap: 9px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.error { background: var(--error); }

.env {
  font-size: 11.5px;
  color: var(--text-muted);
  background: var(--bg-sunken);
  border-radius: 3px;
  padding: 1px 6px;
}

.links { display: flex; gap: 4px; margin-right: auto; }
.links a {
  padding: 5px 11px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 13.5px;
}
.links a:hover { background: var(--bg-sunken); text-decoration: none; }
.links a.active { background: var(--accent-soft); color: var(--accent); font-weight: 500; }

.meta { display: flex; align-items: center; gap: 12px; font-size: 12.5px; }
.readonly {
  color: var(--warn);
  background: var(--warn-soft);
  border-radius: 3px;
  padding: 1px 7px;
  cursor: help;
}
.user { color: var(--text-muted); }
.logout-btn {
  font-size: 12px;
  padding: 3px 8px;
  color: var(--text-faint);
  border-color: var(--border);
}
</style>
