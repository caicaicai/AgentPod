<script setup>
import { onMounted, onBeforeUnmount } from 'vue'

import AppSidebar from './components/AppSidebar.vue'
import ArtifactPanel from './components/ArtifactPanel.vue'
import ChatThread from './components/ChatThread.vue'
import CronPanel from './components/CronPanel.vue'
import DebugPanel from './components/DebugPanel.vue'
import ImageLightbox from './components/ImageLightbox.vue'
import LoginOverlay from './components/LoginOverlay.vue'
import MemoryPanel from './components/MemoryPanel.vue'
import ProjectPanel from './components/ProjectPanel.vue'
import SkillsPanel from './components/SkillsPanel.vue'
import { boot, saveDraft, state, stop } from './stores/app.js'

onMounted(boot)

/**
 * Esc 是全局的：手已经在键盘上了，不该逼人去够那个按钮。
 * 优先级是「关面板 → 停止本轮」—— 面板开着时 Esc 关面板，是所有界面的共同预期。
 */
function onKeydown(event) {
  if (event.key !== 'Escape') return
  if (state.lightbox) { state.lightbox = ''; return }
  if (state.panel) { state.panel = ''; return }
  if (state.live) stop()
}

// 关标签页之前把草稿收好。刷新一下就丢半屏字是最没道理的一种丢失。
function onBeforeUnload() {
  saveDraft()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', onBeforeUnload)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<template>
  <LoginOverlay v-if="state.needLogin" />
  <div v-else class="layout" :class="{ 'sidebar-collapsed': state.sidebarCollapsed }">
    <AppSidebar />
    <ChatThread />

    <SkillsPanel v-if="state.panel === 'skills'" />
    <MemoryPanel v-else-if="state.panel === 'memory'" />
    <CronPanel v-else-if="state.panel === 'cron'" />
    <ProjectPanel v-else-if="state.panel === 'project'" />
    <ArtifactPanel v-else-if="state.panel === 'artifact'" />
    <DebugPanel v-else-if="state.panel === 'debug'" />

    <ImageLightbox v-if="state.lightbox" :src="state.lightbox" @close="state.lightbox = ''" />
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  position: relative;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--background);
}
</style>
