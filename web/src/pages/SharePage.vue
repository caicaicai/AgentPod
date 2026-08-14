<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import ArtifactViewer from '@/modules/artifacts/components/ArtifactViewer.vue'
import { publicApi } from '@/lib/api.js'
import { formatTime } from '@/lib/format.js'
import { kindLabel, needsFrame } from '@/modules/artifacts/artifact-view.js'
import { MARKET_PATH } from '@/lib/route.js'
import { state, toggleTheme } from '@/stores/app.js'

/**
 * 访客看到的那一页：`/s/<token>`。
 *
 * ── 这一页**没有框** ───────────────────────────────────────────────────
 *
 * 作品铺满整个视口，四边到底：没有站点头、没有工具条、没有边框和圆角。
 * 作者把它设计成什么样，访客打开就是什么样 —— 一条分享链接给出去，
 * 对方期待的是"那个东西"，不是"套在我们界面里的那个东西"。
 *
 * 代价是所有周边信息（谁做的、第几版、源码）都没地方放了，于是它们收进
 * 左下角那枚浮标里：默认半透明地待着，点开才摊成一张卡。这是这一页上
 * **唯一**属于我们的像素，所以它必须小到可以被忽略，又一直在原地。
 *
 * ── 这一页的读者没有账号 ────────────────────────────────────────────────
 *
 * 它是整个界面里唯一一处**不假设有登录态**的地方，所以：
 *   - 不调 boot()，不碰会话/模型/技能那一堆接口（全都会 401）；
 *   - 只用 publicApi 那两条免鉴权接口；
 *   - 出错时说的是人话，不是"需要登录"—— 访客既没有账号也不该被要求去注册。
 *
 * ── 安全上它没有开任何新口子 ────────────────────────────────────────────
 *
 * 作品正文照旧走 JSON，由 ArtifactViewer 塞进**不带 allow-same-origin** 的
 * sandbox iframe（理由见 modules/artifacts/artifact-view.js 的文件头）。同源的这一层始终是
 * 我们自己的代码 —— 服务端从不以 HTML 的身份吐出模型生成的内容。
 * 「铺满」只改了那个 iframe 的宽高和边框，隔离契约一个字没动。
 */
const props = defineProps({
  token: { type: String, required: true },
})

const detail = ref(null)
const loading = ref(true)
const error = ref('')

/** 预览还是源码。工具条不画了，这一格由下面那张卡直接切 */
const tab = ref('preview')
/** 浮标摊开没有。默认收着 —— 打开这一页第一眼该是作品，不是我们的介绍 */
const open = ref(false)

const meta = computed(() => detail.value?.meta || null)
const share = computed(() => detail.value?.share || null)
/**
 * 市场入口画不画，由**这次响应**说了算，不看 state.features ——
 * 这一页没跑过 boot()，那份能力宣告是空的。看它的结果是把一个 404 的链接画给访客。
 */
const hasMarket = computed(() => Boolean(detail.value?.features?.market))
/** 有预览可看才给"源码/预览"这一对。code 类型本来就只有源码，切什么都是它 */
const canSwitch = computed(() => Boolean(meta.value) && needsFrame(meta.value.kind))

/**
 * 主题开关只在**看得见它的时候**给：作品自己带着配色（预览沙箱是白底），
 * 换主题对它没有任何影响，摆在那儿只会让人以为点了没反应。
 * 源码页用的是我们的变量，那时候它才真的有用。
 */
const themeMatters = computed(() => tab.value === 'source' || !canSwitch.value)

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  try {
    const data = await publicApi.getShare(props.token)
    detail.value = data
    // 预览沙箱的 CSP 由服务端下发，公开这条路也一样要接住，
    // 否则配了 ARTIFACT_ALLOWED_ORIGINS 的部署里，分享页的预览会比作者自己看到的更严
    state.artifactPreview = data.preview || { allowedOrigins: [] }
    document.title = `${data.meta.title} · AgentPod`
  } catch (err) {
    error.value = err.status === 404
      ? '这个分享链接不存在，或者已经被作者取消了。'
      : `打不开这份作品：${err.message}`
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

/**
 * Esc 收起浮标。
 *
 * ⚠️ 这个监听挂在**父页面**上，而预览是个不透明源的 iframe —— 焦点掉进作品里之后，
 * 它的按键根本不会传到这儿来。所以这不是"总能用"的快捷键，只是给刚点开卡片
 * （焦点还在我们这边）的人一条退路。别指望它当唯一的关闭方式，遮罩那一层才是。
 */
function onKeydown(event) {
  if (event.key === 'Escape') open.value = false
}
</script>

<template>
  <div class="share-page">
    <div v-if="loading" class="sp-center"><span class="spinner" />正在打开…</div>

    <div v-else-if="error" class="sp-center col">
      <div class="sp-logo"><AppIcon name="link-off" :size="24" /></div>
      <p class="sp-error">{{ error }}</p>
      <a class="primary-btn" href="/">去 AgentPod 做一份自己的</a>
    </div>

    <template v-else>
      <!-- 作品本身：铺满，四边到底，不带任何我们的装饰 -->
      <ArtifactViewer v-model:tab="tab" bare readonly :detail="detail" />

      <!--
        摊开时压一层遮罩：一来点哪儿都能收回去（Esc 在 iframe 里收不到，见 onKeydown），
        二来那张卡是浮在别人的作品上的，不压一下会跟作品自己的元素糊在一起分不清层次。
      -->
      <div v-if="open" class="sp-scrim" @click="open = false" />

      <div class="sp-badge" :class="{ open }">
        <!-- ── 收起时：一枚半透明的小徽标，仅此而已 ── -->
        <button
          v-if="!open"
          type="button"
          class="sp-mark"
          title="作品信息 · 由 AgentPod 生成"
          aria-label="展开作品信息"
          @click="open = true"
        >
          <AppIcon name="sparkle" :size="14" filled />
        </button>

        <!-- ── 摊开时：谁做的、什么时候的、要不要看源码 ── -->
        <section v-else class="sp-card">
          <header class="sp-card-head">
            <h1 :title="meta.title">{{ meta.title }}</h1>
            <button type="button" class="chip-x" title="收起" @click="open = false">
              <AppIcon name="x" :size="12" />
            </button>
          </header>

          <p class="sp-sub">
            {{ kindLabel(meta) }}
            <span class="sp-dot">·</span>第 {{ meta.version }} 版
            <span class="sp-dot">·</span>{{ formatTime(meta.updatedAt) }}
          </p>

          <p class="sp-by">
            <span class="sp-avatar"><AppIcon name="user" :size="12" /></span>
            由 <strong>{{ share.author }}</strong> 分享
            <span class="sp-dot">·</span>
            <AppIcon name="eye" :size="12" />{{ share.views || 0 }}
            <span v-if="share.market" class="sp-tag">已在市场</span>
          </p>

          <p v-if="share.summary" class="sp-summary">{{ share.summary }}</p>

          <div class="sp-acts">
            <button
              v-if="canSwitch"
              type="button"
              class="ghost-btn"
              @click="tab = tab === 'source' ? 'preview' : 'source'"
            >
              <AppIcon :name="tab === 'source' ? 'app-window' : 'terminal'" :size="14" />
              {{ tab === 'source' ? '看作品' : '看源码' }}
            </button>
            <button
              v-if="themeMatters"
              type="button"
              class="icon-btn"
              :title="state.theme === 'dark' ? '浅色' : '深色'"
              @click="toggleTheme"
            >
              <AppIcon :name="state.theme === 'dark' ? 'sun' : 'moon'" :size="15" />
            </button>
          </div>

          <!-- 我们的落款收在最底下一行：访客要的是这份作品，不是这个产品 -->
          <footer class="sp-foot">
            <a v-if="hasMarket" :href="MARKET_PATH">
              <AppIcon name="store" :size="12" />作品市场
            </a>
            <a class="sp-home" href="/">
              <AppIcon name="sparkle" :size="12" filled />用 AgentPod 做一份自己的
            </a>
          </footer>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
/*
  整页就是作品的画布：不留内边距、不设最大宽度、不画分隔线。
  这一节里凡是有颜色的东西，都只属于左下角那枚浮标。
*/
.share-page {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--background);
}

/* ═══════════════ 左下角那枚浮标 ═══════════════ */

.sp-badge {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 20;
}

/*
  收起态刻意压到半透明：它盖在别人的作品上，常态就该像水印一样退到后面去。
  鼠标一靠近就实起来 —— 触屏没有 hover，所以 0.45 已经是"看得见、点得着"的下限，
  再淡就变成一个找不着的按钮了。
*/
.sp-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--background);
  color: var(--brand-accent);
  opacity: 0.45;
  cursor: pointer;
  box-shadow: 0 3px 12px color-mix(in srgb, var(--foreground) 16%, transparent);
  transition: opacity 0.15s linear, transform 0.15s ease;
}
.sp-mark:hover,
.sp-mark:focus-visible {
  opacity: 1;
  transform: translateY(-1px);
}

/* 摊开时压在作品上的一层：点哪儿都收回去 */
.sp-scrim {
  position: fixed;
  inset: 0;
  z-index: 19;
  background: color-mix(in srgb, var(--foreground) 12%, transparent);
}

.sp-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(320px, calc(100vw - 32px));
  padding: 13px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--background);
  box-shadow: 0 14px 40px color-mix(in srgb, var(--foreground) 28%, transparent);
}

.sp-card-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.sp-card-head h1 {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--foreground);
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}
.chip-x:hover {
  background: var(--secondary);
  color: var(--foreground);
}

.sp-sub,
.sp-by {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin: 0;
  color: var(--muted-foreground);
  font-size: 12px;
}
.sp-by strong {
  color: var(--foreground);
  font-weight: 600;
}
.sp-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--secondary);
}
.sp-dot {
  opacity: 0.5;
}
.sp-tag {
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--brand-accent) 14%, transparent);
  color: var(--brand-accent);
  font-size: 11px;
}
.sp-summary {
  margin: 0;
  color: var(--foreground);
  font-size: 12.5px;
  line-height: 1.7;
}

.sp-acts {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 1px;
}
.sp-acts .ghost-btn {
  padding: 5px 11px;
  font-size: 12.5px;
}
.sp-acts .icon-btn {
  margin-left: auto;
}

.sp-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 9px;
  border-top: 1px solid var(--border);
}
.sp-foot a {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--muted-foreground);
  font-size: 11.5px;
  text-decoration: none;
}
.sp-foot a:hover {
  color: var(--foreground);
}
.sp-foot .sp-home {
  margin-left: auto;
  color: var(--brand-accent);
}

/* ═══════════════ 打不开的时候 ═══════════════ */

.sp-center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  color: var(--muted-foreground);
  font-size: 13px;
}
.sp-center.col {
  flex-direction: column;
  gap: 14px;
}
.sp-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 16px;
  background: var(--secondary);
}
.sp-error {
  margin: 0;
  max-width: 420px;
  text-align: center;
  line-height: 1.75;
}
.sp-center .primary-btn {
  text-decoration: none;
}

/* 窄屏上浮标往边角再收一点，别压住作品自己的底栏 */
@media (max-width: 620px) {
  .sp-badge {
    left: 10px;
    bottom: 10px;
  }
}
</style>
