<script setup>
import { onMounted, computed } from 'vue'
import { RouterView } from 'vue-router'
import AppNav from '@/components/AppNav.vue'
import ToastHost from '@/components/ToastHost.vue'
import LoginOverlay from '@/components/LoginOverlay.vue'
import { start, sessionExpired, error, loading, paused } from '@/store/cluster.js'
import { USE_MOCK } from '@/api/client.js'

onMounted(start)

const showShell = computed(() => !sessionExpired.value)
</script>

<template>
  <div class="app">
    <LoginOverlay v-if="!showShell && !USE_MOCK" />

    <AppNav v-if="showShell" />

    <div v-if="USE_MOCK" class="mock-banner">
      本地 mock 数据 —— 没有连接任何真实集群。<code>npm run dev:live</code> 可连真实 manager。
    </div>

    <main v-if="showShell" class="main">
      <div v-if="error" class="banner error">
        <span>拉取集群状态失败：{{ error }}</span>
        <span class="faint">下方仍是最后一次成功的数据</span>
      </div>
      <div v-else-if="paused" class="banner muted-banner">页面切到后台，已暂停轮询</div>

      <div v-if="loading" class="loading">正在加载集群状态…</div>
      <RouterView v-else />
    </main>

    <ToastHost />
  </div>
</template>

<style scoped>
.app { min-height: 100vh; display: flex; flex-direction: column; }

.main {
  flex: 1;
  width: 100%;
  max-width: 1280px;
  margin: 0 auto;
  padding: 20px 24px 48px;
}

.mock-banner {
  background: var(--warn-soft);
  color: var(--warn);
  padding: 6px 24px;
  font-size: 12.5px;
  text-align: center;
  border-bottom: 1px solid var(--border);
}

.banner {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 9px 14px;
  border-radius: var(--radius-sm);
  margin-bottom: 16px;
  font-size: 13px;
}
.banner.error { background: var(--error-soft); color: var(--error); }
.banner.muted-banner { background: var(--neutral-soft); color: var(--text-muted); }

.loading { padding: 64px 0; text-align: center; color: var(--text-muted); }
</style>
