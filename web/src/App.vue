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
import MarketPage from './components/MarketPage.vue'
import MemoryPanel from './components/MemoryPanel.vue'
import ProjectPanel from './components/ProjectPanel.vue'
import SharePage from './components/SharePage.vue'
import SkillsPanel from './components/SkillsPanel.vue'
import {
  boot, closeArtifactDetail, closeLibrary, closeMarket, closeWizard, saveDraft, state, stop,
} from './stores/app.js'
import { dialog } from './lib/dialog.js'
import { publicRoute } from './lib/route.js'

/**
 * 公开路径（`/s/<token>`、`/market`）走另一套外壳。
 *
 * **只在启动时判一次**，理由见 lib/route.js：访客落在分享页上就一直在分享页，
 * 不会在应用内部导航过去。
 *
 * 关键在于这时候**不调 boot()** —— 那一串接口（会话、模型、技能、记忆）
 * 对没有账号的访客全是 401，结果是一个弹着登录框的分享页。
 * 而这一页存在的全部意义，就是不需要账号也能看。
 */
const route = publicRoute()

onMounted(() => {
  if (!route) boot()
})

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
  if (state.view === 'market') { closeMarket(); return }
  if (state.live) stop()
}

// 关标签页之前把草稿收好。刷新一下就丢半屏字是最没道理的一种丢失。
function onBeforeUnload() {
  saveDraft()
}

onMounted(() => {
  // 公开页上这两个都没有意义：没有面板可关、没有草稿可存
  if (route) return
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', onBeforeUnload)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<template>
  <!--
    公开页排在最前面，连登录框都不参与：访客没有账号，
    给他弹一个登录框等于告诉他"你不配看这份别人分享给你的东西"。
  -->
  <SharePage v-if="route?.name === 'share'" :token="route.token" />
  <MarketPage v-else-if="route?.name === 'market'" standalone />

  <LoginOverlay v-else-if="state.needLogin" />
  <div v-else class="layout" :class="{ 'sidebar-collapsed': state.sidebarCollapsed }">
    <AppSidebar />
    <!--
      作品库**替换**主区域而不是盖在上面：它是与对话并列的一个去处，
      不是对话的一个弹层。会话列表留着，方便从库里跳回某条对话。
    -->
    <ArtifactLibrary v-if="state.view === 'artifacts'" />
    <MarketPage v-else-if="state.view === 'market'" />
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
