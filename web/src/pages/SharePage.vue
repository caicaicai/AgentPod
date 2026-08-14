<script setup>
import { computed, onMounted, ref } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import ArtifactViewer from '@/modules/artifacts/components/ArtifactViewer.vue'
import { publicApi } from '@/lib/api.js'
import { formatTime } from '@/lib/format.js'
import { kindLabel } from '@/modules/artifacts/artifact-view.js'
import { MARKET_PATH } from '@/lib/route.js'
import { state, toggleTheme } from '@/stores/app.js'

/**
 * 访客看到的那一页：`/s/<token>`。
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
 */
const props = defineProps({
  token: { type: String, required: true },
})

const detail = ref(null)
const loading = ref(true)
const error = ref('')

const meta = computed(() => detail.value?.meta || null)
const share = computed(() => detail.value?.share || null)
/**
 * 市场入口画不画，由**这次响应**说了算，不看 state.features ——
 * 这一页没跑过 boot()，那份能力宣告是空的。看它的结果是把一个 404 的链接画给访客。
 */
const hasMarket = computed(() => Boolean(detail.value?.features?.market))

onMounted(async () => {
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
</script>

<template>
  <div class="share-page">
    <header class="sp-head">
      <a class="sp-brand" href="/" title="AgentPod">
        <span class="brand-mark"><AppIcon name="sparkle" :size="13" filled /></span>
        <span>AgentPod</span>
      </a>

      <template v-if="meta">
        <h1 :title="meta.title">{{ meta.title }}</h1>
        <span class="sp-meta">
          {{ kindLabel(meta) }} · 第 {{ meta.version }} 版 · {{ formatTime(meta.updatedAt) }}
        </span>
      </template>

      <div class="sp-right">
        <a v-if="hasMarket" class="ghost-btn" :href="MARKET_PATH">
          <AppIcon name="store" :size="14" />作品市场
        </a>
        <button
          type="button"
          class="icon-btn"
          :title="state.theme === 'dark' ? '浅色' : '深色'"
          @click="toggleTheme"
        >
          <AppIcon :name="state.theme === 'dark' ? 'sun' : 'moon'" :size="16" />
        </button>
      </div>
    </header>

    <main class="sp-body">
      <div v-if="loading" class="sp-empty"><span class="spinner" />正在打开…</div>

      <div v-else-if="error" class="sp-empty col">
        <div class="sp-logo"><AppIcon name="link-off" :size="24" /></div>
        <p class="sp-error">{{ error }}</p>
        <a class="primary-btn" href="/">去 AgentPod 做一份自己的</a>
      </div>

      <template v-else>
        <!--
          作者与来源写在正文上面而不是页脚：访客第一眼要判断的就是
          "这是谁做的、什么时候的东西"，而页脚在长页面上根本看不见。
        -->
        <div class="sp-by">
          <span class="sp-avatar"><AppIcon name="user" :size="13" /></span>
          由 <strong>{{ share.author }}</strong> 分享
          <span class="sp-dot">·</span>
          <AppIcon name="eye" :size="12" />{{ share.views || 0 }}
          <span v-if="share.market" class="sp-tag">已在作品市场</span>
        </div>
        <p v-if="share.summary" class="sp-summary">{{ share.summary }}</p>

        <ArtifactViewer roomy readonly :detail="detail" />
      </template>
    </main>
  </div>
</template>

<style scoped>
.share-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--background);
}

.sp-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 0 0 auto;
  height: var(--head-h);
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}
.sp-brand {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--foreground);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--brand-accent) 16%, transparent);
  color: var(--brand-accent);
}
.sp-head h1 {
  margin: 0 0 0 6px;
  overflow: hidden;
  font-size: 14.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sp-meta {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sp-right {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.sp-right .ghost-btn {
  text-decoration: none;
}

.sp-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
  width: min(1180px, 100%);
  margin: 0 auto;
  padding: 16px 20px 20px;
}

.sp-by {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  color: var(--muted-foreground);
  font-size: 12.5px;
}
.sp-by strong {
  color: var(--foreground);
  font-weight: 600;
}
.sp-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: var(--secondary);
}
.sp-dot {
  opacity: 0.5;
}
.sp-tag {
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--brand-accent) 14%, transparent);
  color: var(--brand-accent);
  font-size: 11px;
}
.sp-summary {
  margin: 0;
  flex: 0 0 auto;
  color: var(--foreground);
  font-size: 13px;
  line-height: 1.7;
}

.sp-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  color: var(--muted-foreground);
  font-size: 13px;
}
.sp-empty.col {
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
.sp-empty .primary-btn {
  text-decoration: none;
}

@media (max-width: 720px) {
  .sp-head h1 {
    max-width: 40vw;
  }
  .sp-meta {
    display: none;
  }
}
</style>
