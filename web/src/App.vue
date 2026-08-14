<script setup>
/**
 * 外壳。**这里只做一件事：决定现在显示哪一页，以及页外面常驻着什么。**
 *
 * 页在 `pages/`，与 `lib/route.js` 里那几条地址一一对应；页里用到的零件在
 * `modules/<领域>/`。这个文件不该出现任何"某一页内部怎么排"的逻辑 ——
 * 它一长，就会变成那种谁都要改、谁都不敢改的文件。
 *
 * 三层外壳，从外到内：
 *   访客（分享页 / 未登录的市场页）→ 登录框 → 管理台（整窗口）→ 侧栏 + 正文 + 抽屉
 */
import { onMounted, onBeforeUnmount } from 'vue'

// 页面：与 lib/route.js 里那几条地址一一对应
import AdminPage from '@/pages/AdminPage.vue'
import ArtifactsPage from '@/pages/ArtifactsPage.vue'
import ChatPage from '@/pages/ChatPage.vue'
import MarketPage from '@/pages/MarketPage.vue'
import SharePage from '@/pages/SharePage.vue'
// 外壳上常驻的那几件：侧栏、抽屉、盖在最上面的登录框与灯箱
import AppSidebar from '@/modules/sessions/components/AppSidebar.vue'
import ProjectPanel from '@/modules/sessions/components/ProjectPanel.vue'
import LoginOverlay from '@/modules/account/components/LoginOverlay.vue'
import AccountPanel from '@/modules/account/components/AccountPanel.vue'
import ArtifactPanel from '@/modules/artifacts/components/ArtifactPanel.vue'
import CronPanel from '@/modules/panels/components/CronPanel.vue'
import DebugPanel from '@/modules/panels/components/DebugPanel.vue'
import MemoryPanel from '@/modules/panels/components/MemoryPanel.vue'
import SkillsPanel from '@/modules/panels/components/SkillsPanel.vue'
import AppDialog from '@/components/AppDialog.vue'
import ImageLightbox from '@/components/ImageLightbox.vue'
import {
  boot, closeAdmin, closeArtifactDetail, closeLibrary, closeMarket, closeWizard,
  hasStoredIdentity, saveDraft, state, stop,
} from '@/stores/app.js'
import { dialog } from '@/lib/dialog.js'
import { parsePath } from '@/lib/route.js'

/**
 * 首屏落在哪条地址上。**只在这里判一次**：之后的来回导航由 store 里那套
 * 地址↔状态的同步接手（见 stores/app.js 的「地址栏」一节），这里要的只是
 * "这一次要不要走应用外壳"。
 */
const route = parsePath()

/**
 * 访客外壳：分享页，以及**没有身份痕迹时**的市场页。
 *
 * 关键在于这时候**不调 boot()** —— 那一串接口（会话、模型、技能、记忆）
 * 对没有账号的访客全是 401，sso 模式下还会把他直接甩去登录页。
 * 而这两页存在的全部意义，就是不需要账号也能看。
 *
 * 反过来，自己人打开 `/market` 走的是完整外壳（同一个地址、同一份数据，多一条侧栏），
 * 于是应用里点进市场和把这条链接发给别人，说的是同一件事。分不清是谁时按访客算，
 * 理由见 hasStoredIdentity。
 */
const visitor = route.name === 'share' || (route.name === 'market' && !hasStoredIdentity())

onMounted(() => {
  if (!visitor) boot()
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
  if (state.view === 'admin') { closeAdmin(); return }
  if (state.live) stop()
}

// 关标签页之前把草稿收好。刷新一下就丢半屏字是最没道理的一种丢失。
function onBeforeUnload() {
  saveDraft()
}

onMounted(() => {
  // 访客页上这两个都没有意义：没有面板可关、没有草稿可存
  if (visitor) return
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
  <SharePage v-if="route.name === 'share'" :token="route.token" />
  <MarketPage v-else-if="visitor" standalone />

  <LoginOverlay v-else-if="state.needLogin" />

  <!--
    ── 管理台是整个窗口，不是正文区里的一块 ──────────────────────────────
    它和下面那套外壳并列，**不带会话列表**。
    理由是这一页的活与对话无关：看的是一张要横向比较的表（用户名、角色、几列数字、
    一排操作按钮），而会话列表在旁边占着 260px，只是把每一行挤窄。
    别的视图（作品库、市场）留着侧栏是有道理的 —— 那两处经常"看一眼就跳回某条对话"；
    管人和对账不是那种来回切的活，进来就是要专心看完。

    AppDialog 必须跟着挂：禁用账号、改角色都要先问一次，而问的那个框在这一层。
  -->
  <div v-else-if="state.view === 'admin'" class="layout">
    <AdminPage />
    <AppDialog />
  </div>

  <div v-else class="layout" :class="{ 'sidebar-collapsed': state.sidebarCollapsed }">
    <AppSidebar />
    <!--
      作品库**替换**主区域而不是盖在上面：它是与对话并列的一个去处，
      不是对话的一个弹层。会话列表留着，方便从库里跳回某条对话。
    -->
    <ArtifactsPage v-if="state.view === 'artifacts'" />
    <MarketPage v-else-if="state.view === 'market'" />
    <ChatPage v-else />

    <SkillsPanel v-if="state.panel === 'skills'" />
    <MemoryPanel v-else-if="state.panel === 'memory'" />
    <CronPanel v-else-if="state.panel === 'cron'" />
    <ProjectPanel v-else-if="state.panel === 'project'" />
    <AccountPanel v-else-if="state.panel === 'account'" />
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
