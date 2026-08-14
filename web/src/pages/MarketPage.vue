<script setup>
import { computed, onMounted } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import { formatTime } from '@/lib/format.js'
import { KIND_META, kindIcon } from '@/modules/artifacts/artifact-view.js'
import { shareUrl } from '@/lib/route.js'
import { closeMarket, refreshMarket, state, toggleTheme } from '@/stores/app.js'

/**
 * 作品市场：所有**显式发布**出来的作品。
 *
 * ── 一个组件，两个宿主 ──────────────────────────────────────────────────
 *
 * 应用内（侧栏点进来）和独立页 `/market`（免登录）画的是同一份东西，
 * 走的也是同一条免鉴权接口 —— 于是不会出现"登录之后广场上反而少了几条"
 * 这种谁也解释不清的差异。
 *
 * 差别只在外壳：独立页要自己画顶栏（没有侧栏可依托），应用内则留一个返回对话的入口。
 *
 * ── 为什么点开是新标签页 ────────────────────────────────────────────────
 *
 * 市场里的每一条都是**别人的**作品，它已经有一个自己的地址（`/s/<token>`）。
 * 在应用内就地展开的话，地址栏还停在当前对话上 —— 用户想把它转给同事时
 * 复制到的是自己的会话地址。让它走真实链接，复制粘贴才是对的。
 */
const props = defineProps({
  /** 独立页（/market）。自带顶栏，不假设有登录态 */
  standalone: { type: Boolean, default: false },
})

/** 只画**真的有作品**的那几类。永远空着的筛选项是噪音，还会让人以为功能坏了 */
const kinds = computed(() => {
  const used = new Set(state.marketItems.map((item) => item.kind))
  return Object.keys(KIND_META).filter((kind) => used.has(kind))
})

onMounted(() => {
  // 应用内是由 openMarket() 带着刷新进来的；独立页没人替它取，得自己来
  if (props.standalone) refreshMarket()
})

/**
 * 搜索走服务端（市场是跨用户的，本地手里只有已经取回来的那一页）。
 * 没做防抖：这个列表最多两百条，一次查询就是几十个小文件读，
 * 真到了需要防抖的规模，该换的是分页而不是在前端拖时间。
 */
function onSearch() {
  refreshMarket()
}

/** 再点一次选中的那一类就是取消 —— 与作品库那排筛选一致 */
function pick(kind) {
  state.marketKind = state.marketKind === kind ? '' : kind
  refreshMarket()
}

function pickAll() {
  if (!state.marketKind) return
  state.marketKind = ''
  refreshMarket()
}
</script>

<template>
  <main class="market" :class="{ standalone: props.standalone }">
    <header class="mk-head">
      <template v-if="props.standalone">
        <a class="mk-brand" href="/" title="AgentPod">
          <span class="brand-mark"><AppIcon name="sparkle" :size="13" filled /></span>
          <span>AgentPod</span>
        </a>
      </template>
      <template v-else>
        <button
          v-if="state.sidebarCollapsed"
          type="button"
          class="icon-btn"
          title="展开会话列表"
          @click="state.sidebarCollapsed = false"
        >
          <AppIcon name="panel-open" :size="17" />
        </button>
        <button type="button" class="ghost-btn" title="回到对话" @click="closeMarket">
          <AppIcon name="chevron-right" :size="14" class="back" />对话
        </button>
      </template>

      <h1>作品市场</h1>
      <span v-if="state.marketItems.length" class="head-count">共 {{ state.marketItems.length }} 份</span>

      <div class="head-right">
        <div class="search">
          <AppIcon name="search" :size="14" />
          <input
            v-model="state.marketSearch"
            type="search"
            placeholder="搜标题、简介或作者"
            @keydown.enter="onSearch"
            @search="onSearch"
          />
        </div>
        <button type="button" class="icon-btn" title="刷新" @click="refreshMarket">
          <AppIcon name="refresh" :size="16" />
        </button>
        <button
          v-if="props.standalone"
          type="button"
          class="icon-btn"
          :title="state.theme === 'dark' ? '浅色' : '深色'"
          @click="toggleTheme"
        >
          <AppIcon :name="state.theme === 'dark' ? 'sun' : 'moon'" :size="16" />
        </button>
      </div>
    </header>

    <section class="mk-body">
      <p v-if="state.marketNote" class="note warn">{{ state.marketNote }}</p>

      <div v-if="kinds.length > 1" class="filters">
        <button type="button" :class="{ on: !state.marketKind }" @click="pickAll">全部</button>
        <button
          v-for="kind in kinds"
          :key="kind"
          type="button"
          :class="{ on: state.marketKind === kind }"
          @click="pick(kind)"
        >
          <AppIcon :name="kindIcon(kind)" :size="13" />{{ KIND_META[kind].label }}
        </button>
      </div>

      <div v-if="state.marketLoading && !state.marketItems.length" class="empty">
        <span class="spinner" />正在加载…
      </div>

      <div v-else-if="state.marketItems.length" class="grid">
        <!--
          用 <a> 而不是带 click 的 <article>：这是一条真实的地址，
          中键、右键"在新标签页打开"、复制链接地址都该照常能用。
        -->
        <a
          v-for="item in state.marketItems"
          :key="item.token"
          class="card"
          :href="shareUrl(item.token)"
          target="_blank"
          rel="noopener"
        >
          <div class="card-top">
            <span class="card-icon"><AppIcon :name="kindIcon(item.kind)" :size="16" /></span>
            <span class="card-kind">{{ item.kind === 'code' && item.language ? item.language : KIND_META[item.kind]?.label || item.kind }}</span>
            <span class="card-time">{{ formatTime(item.marketAt || item.updatedAt) }}</span>
          </div>
          <h3>{{ item.title }}</h3>
          <p v-if="item.summary" class="card-summary">{{ item.summary }}</p>
          <p class="card-meta">
            <span class="by"><AppIcon name="user" :size="11" />{{ item.author }}</span>
            <span class="dot">·</span>{{ item.fileCount }} 个文件
            <span class="views"><AppIcon name="eye" :size="11" />{{ item.views }}</span>
          </p>
        </a>
      </div>

      <!--
        空状态要讲清"这里的东西是怎么来的"。
        市场是**别人主动发布**的结果，没有任何按钮能让当前这个人把它填满 ——
        不说的话，空广场看起来就像是功能坏了。
      -->
      <div v-else class="guide">
        <div class="guide-logo"><AppIcon name="store" :size="26" /></div>
        <h2>{{ state.marketSearch || state.marketKind ? '没有匹配的作品' : '市场上还没有作品' }}</h2>
        <p class="guide-lead">
          市场里是大家<strong>主动发布</strong>出来的成品：网页、Vue 组件、文档、图。
          想让自己的作品出现在这儿，打开那份作品 → 分享 → 勾上「发布到作品市场」。
        </p>
        <a v-if="props.standalone" class="primary-btn" href="/">去做一份自己的</a>
      </div>
    </section>
  </main>
</template>

<style scoped>
.market {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--background);
}
.market.standalone {
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}

.mk-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  height: var(--head-h);
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}
.mk-head h1 {
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
}
.mk-brand {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-right: 4px;
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
  width: 180px;
  border: 0;
  background: transparent;
  color: var(--foreground);
  font-size: 12.5px;
  outline: none;
}

.mk-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
  min-height: 0;
  width: min(1180px, 100%);
  margin: 0 auto;
  padding: 18px 20px;
  overflow-y: auto;
}

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 0 0 auto;
}
.filters button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12.5px;
  cursor: pointer;
}
.filters button:hover {
  background: var(--secondary);
  color: var(--foreground);
}
.filters button.on {
  border-color: color-mix(in srgb, var(--brand-accent) 45%, var(--border));
  background: color-mix(in srgb, var(--brand-accent) 10%, transparent);
  color: var(--foreground);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
  gap: 12px;
  align-content: start;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 13px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--secondary) 34%, var(--background));
  color: inherit;
  text-decoration: none;
  transition: border-color 0.12s ease, transform 0.12s ease;
}
.card:hover {
  border-color: color-mix(in srgb, var(--brand-accent) 45%, var(--border));
  transform: translateY(-1px);
}
@media (prefers-reduced-motion: reduce) {
  .card {
    transition: none;
  }
  .card:hover {
    transform: none;
  }
}
.card-top {
  display: flex;
  align-items: center;
  gap: 7px;
}
.card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--brand-accent) 14%, transparent);
  color: var(--brand-accent);
}
.card-kind {
  color: var(--muted-foreground);
  font-size: 11.5px;
}
.card-time {
  margin-left: auto;
  color: var(--muted-foreground);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.card h3 {
  margin: 0;
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-summary {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 12px;
  line-height: 1.6;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.card-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  color: var(--muted-foreground);
  font-size: 11.5px;
}
.by,
.views {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.views {
  margin-left: auto;
}
.dot {
  opacity: 0.5;
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 0;
  color: var(--muted-foreground);
  font-size: 13px;
}

.note.warn {
  margin: 0;
  color: var(--warning);
  font-size: 12.5px;
}

.guide {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(620px, 100%);
  margin: 0 auto;
  padding: clamp(20px, 8vh, 70px) 0 30px;
  text-align: center;
}
.guide-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 54px;
  margin-bottom: 14px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--brand-accent) 14%, transparent);
  color: var(--brand-accent);
}
.guide h2 {
  margin: 0 0 10px;
  font-size: 20px;
  font-weight: 600;
}
.guide-lead {
  margin: 0 0 18px;
  color: var(--muted-foreground);
  font-size: 13.5px;
  line-height: 1.75;
}
.guide-lead strong {
  color: var(--foreground);
  font-weight: 600;
}
.guide .primary-btn {
  text-decoration: none;
}

@media (max-width: 760px) {
  .search input {
    width: 110px;
  }
}
</style>
