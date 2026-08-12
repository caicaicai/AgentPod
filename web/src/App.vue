<script setup>
import { onMounted, onBeforeUnmount } from 'vue'

import AppDialog from './components/AppDialog.vue'
import AppSidebar from './components/AppSidebar.vue'
import ArtifactLibrary from './components/ArtifactLibrary.vue'
import ArtifactPanel from './components/ArtifactPanel.vue'
import ChatThread from './components/ChatThread.vue'
import CronPanel from './components/CronPanel.vue'
import DebugPanel from './components/DebugPanel.vue'
import ImageLightbox from './components/ImageLightbox.vue'
import LoginOverlay from './components/LoginOverlay.vue'
import MemoryPanel from './components/MemoryPanel.vue'
import ProjectPanel from './components/ProjectPanel.vue'
import SkillsPanel from './components/SkillsPanel.vue'
import { boot, closeArtifactDetail, closeLibrary, closeWizard, saveDraft, state, stop } from './stores/app.js'
import { dialog } from './lib/dialog.js'

onMounted(boot)

/**
 * Esc 是全局的：手已经在键盘上了，不该逼人去够那个按钮。
 * 优先级是「关面板 → 停止本轮」—— 面板开着时 Esc 关面板，是所有界面的共同预期。
 */
function onKeydown(event) {
  if (event.key !== 'Escape') return
  // 询问框自己处理 Esc（要兑现那个 Promise），这里不能抢在它前面把面板关掉
  if (dialog.open) return
  if (state.wizardOpen) { closeWizard(); return }
  if (state.lightbox) { state.lightbox = ''; return }
  if (state.panel) { state.panel = ''; return }
  // 作品库里逐层退：详情 → 列表 → 对话。一步退到底会让人丢掉刚翻到的位置
  if (state.view === 'artifacts') {
    if (state.artifactDetail) closeArtifactDetail()
    else closeLibrary()
    return
  }
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
    <!--
      作品库**替换**主区域而不是盖在上面：它是与对话并列的一个去处，
      不是对话的一个弹层。会话列表留着，方便从库里跳回某条对话。
    -->
    <ArtifactLibrary v-if="state.view === 'artifacts'" />
    <ChatThread v-else />

    <SkillsPanel v-if="state.panel === 'skills'" />
    <MemoryPanel v-else-if="state.panel === 'memory'" />
    <CronPanel v-else-if="state.panel === 'cron'" />
    <ProjectPanel v-else-if="state.panel === 'project'" />
    <ArtifactPanel v-else-if="state.panel === 'artifact'" />
    <DebugPanel v-else-if="state.panel === 'debug'" />

    <ImageLightbox v-if="state.lightbox" :src="state.lightbox" @close="state.lightbox = ''" />
    <!-- 全局只挂一个：同一时刻只可能有一个问题在问 -->
    <AppDialog />
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
