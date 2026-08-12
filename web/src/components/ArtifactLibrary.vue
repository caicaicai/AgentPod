<script setup>
import { computed } from 'vue'

import AppIcon from './AppIcon.vue'
import ArtifactViewer from './ArtifactViewer.vue'
import { formatTime } from '../lib/format.js'
import {
  ARTIFACT_STARTERS, KIND_META, filterArtifacts, kindIcon, kindLabel,
} from '../lib/artifact-view.js'
import {
  closeArtifactDetail, closeLibrary, openArtifact, openArtifactSession, refreshLibrary,
  startArtifactFrom, state,
} from '../stores/app.js'

/**
 * 作品库：跨会话的独立页面。
 *
 * 与对话右边那个抽屉的分工：抽屉是"边聊边看这一轮的产出"，库是"我做过的东西都在这"。
 * 后者跟当前聊到哪儿没有关系，所以它占整个主区域，而不是挤在对话旁边。
 */
const detail = computed(() => state.artifactDetail)

const shown = computed(() => filterArtifacts(state.libraryArtifacts, {
  q: state.librarySearch,
  kind: state.libraryKind,
}))

/** 只画**真的有作品**的那几类。永远灰着的筛选项是噪音，还会让人以为功能坏了 */
const kinds = computed(() => {
  const used = new Set(state.libraryArtifacts.map((item) => item.kind))
  return Object.keys(KIND_META).filter((kind) => used.has(kind))
})

const fileCount = (item) => (item.versions.find((version) => version.n === item.version)?.files || []).length

/** 会话标题。查不到就不显示 —— 归档/别的项目下的会话可能不在当前列表里 */
const sessionTitle = (sessionKey) => state.sessions.find((item) => item.sessionKey === sessionKey)?.title || ''
</script>

<template>
  <main class="library">
    <header class="lib-head">
      <button type="button" class="icon-btn" title="回到对话" @click="closeLibrary">
        <AppIcon name="panel-open" :size="17" />
      </button>
      <h1>作品</h1>
      <span v-if="state.libraryArtifacts.length" class="head-count">
        共 {{ state.libraryArtifacts.length }} 份
      </span>

      <div class="head-right">
        <div v-if="state.libraryArtifacts.length" class="search">
          <AppIcon name="search" :size="14" />
          <input v-model="state.librarySearch" type="search" placeholder="搜标题或文件名" />
        </div>
        <button type="button" class="icon-btn" title="刷新" @click="refreshLibrary">
          <AppIcon name="refresh" :size="16" />
        </button>
      </div>
    </header>

    <!-- ── 打开了某一份：整页看 ── -->
    <section v-if="detail" class="detail">
      <div class="detail-head">
        <button type="button" class="ghost-btn" @click="closeArtifactDetail">
          <AppIcon name="chevron-right" :size="14" class="back" />返回列表
        </button>
        <h2>{{ detail.meta.title }}</h2>
        <span class="detail-meta">{{ kindLabel(detail.meta) }} · 第 {{ detail.meta.version }} 版</span>
        <button
          v-if="detail.meta.sessionKey"
          type="button"
          class="ghost-btn"
          title="回到产出它的那条对话，接着让助手改"
          @click="openArtifactSession(detail.meta.sessionKey)"
        >
          <AppIcon name="sparkle" :size="14" />继续改它
        </button>
      </div>
      <ArtifactViewer roomy />
    </section>

    <!-- ── 列表 ── -->
    <section v-else class="body">
      <p v-if="state.artifactNote" class="note warn">{{ state.artifactNote }}</p>

      <div v-if="kinds.length > 1" class="filters">
        <button type="button" :class="{ on: !state.libraryKind }" @click="state.libraryKind = ''">全部</button>
        <button
          v-for="kind in kinds"
          :key="kind"
          type="button"
          :class="{ on: state.libraryKind === kind }"
          @click="state.libraryKind = kind"
        >
          <AppIcon :name="kindIcon(kind)" :size="13" />{{ KIND_META[kind].label }}
        </button>
      </div>

      <div v-if="state.libraryLoading && !state.libraryArtifacts.length" class="empty">
        <span class="spinner" />正在加载…
      </div>

      <div v-else-if="state.libraryArtifacts.length" class="grid">
        <article v-for="item in shown" :key="item.id" class="card" @click="openArtifact(item.id)">
          <div class="card-top">
            <span class="card-icon"><AppIcon :name="kindIcon(item.kind)" :size="16" /></span>
            <span class="card-kind">{{ kindLabel(item) }}</span>
            <span class="card-time">{{ formatTime(item.updatedAt) }}</span>
          </div>
          <h3>{{ item.title }}</h3>
          <p class="card-meta">
            第 {{ item.version }} 版 · {{ fileCount(item) }} 个文件
            <template v-if="sessionTitle(item.sessionKey)"> · 来自「{{ sessionTitle(item.sessionKey) }}」</template>
          </p>
        </article>

        <p v-if="!shown.length" class="empty">没有匹配的作品。</p>
      </div>

      <!--
        ── 空状态就是创建指引 ──
        作品是模型产出的，**没有「新建」按钮**。用户对着一个空列表的本能是找那个按钮，
        找不到就会得出"这功能没做好"的结论。所以这里必须把"它是怎么来的"讲清楚，
        并且给几句能直接点的话术。
      -->
      <div v-else class="guide">
        <div class="guide-logo"><AppIcon name="app-window" :size="26" /></div>
        <h2>还没有作品</h2>
        <p class="guide-lead">
          作品是助手做出来的**成品**：网页、Vue 组件、文档、图、成段的代码。
          它不贴在对话里，而是单独存成一组文件，可以预览、切版本、下载，
          后续想改就在那条对话里接着说，助手会在原来那份上出新版本。
        </p>
        <p class="guide-lead subtle">
          没有「新建」按钮 —— 直接在对话里提要求就行。下面几句可以直接用：
        </p>

        <div class="starters">
          <button
            v-for="item in ARTIFACT_STARTERS"
            :key="item.title"
            type="button"
            class="starter"
            @click="startArtifactFrom(item.prompt)"
          >
            <span class="starter-head">
              <AppIcon :name="kindIcon(item.kind)" :size="15" />{{ item.title }}
              <span class="starter-kind">{{ KIND_META[item.kind].label }}</span>
            </span>
            <span class="starter-body">{{ item.prompt }}</span>
          </button>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
.library {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--background);
}

.lib-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  /* 与对话顶栏共用高度：两块并排时底线要对得上，见 tokens.css */
  height: var(--head-h);
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}
.lib-head h1 {
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
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
  font-size: 12.5px;
  outline: none;
}

.body,
.detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
  min-height: 0;
  padding: 18px 20px;
  overflow-y: auto;
}
.detail {
  overflow: hidden; /* 详情页里由预览自己滚，页面不跟着长 */
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}
.detail-head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.detail-meta {
  flex: 1;
  color: var(--muted-foreground);
  font-size: 12px;
}
.back {
  transform: rotate(180deg);
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
  cursor: pointer;
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
.card-meta {
  margin: 0;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  width: min(720px, 100%);
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
  margin: 0 0 14px;
  max-width: 560px;
  color: var(--muted-foreground);
  font-size: 13.5px;
  line-height: 1.75;
}
.guide-lead.subtle {
  margin-bottom: 18px;
  font-size: 13px;
}

.starters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 10px;
  width: 100%;
}
.starter {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 13px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.starter:hover {
  background: var(--secondary);
  border-color: color-mix(in srgb, var(--brand-accent) 32%, var(--border));
}
.starter-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--foreground);
  font-size: 13.5px;
  font-weight: 600;
}
.starter-kind {
  margin-left: auto;
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--foreground) 8%, transparent);
  color: var(--muted-foreground);
  font-size: 10.5px;
  font-weight: 400;
}
.starter-body {
  display: -webkit-box;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.65;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

@media (max-width: 760px) {
  .search input {
    width: 110px;
  }
}
</style>
