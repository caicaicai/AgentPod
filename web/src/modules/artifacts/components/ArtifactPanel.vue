<script setup>
import { computed } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import ArtifactViewer from './ArtifactViewer.vue'
import SidePanel from '@/components/SidePanel.vue'
import { formatTime } from '@/lib/format.js'
import { kindIcon, kindLabel } from '../artifact-view.js'
import {
  closeArtifactDetail, openArtifact, openLibrary, refreshArtifacts, setArtifactWidth, state,
  toggleArtifactFull,
} from '@/stores/app.js'

/**
 * 对话右边的作品抽屉：**只看当前这条会话的产出**。
 *
 * 跨会话的那份在作品库（pages/ArtifactsPage.vue）。两者分工不同，
 * 所以这里刻意不做搜索和筛选 —— 一条会话里通常就一两份，搜索框是噪音；
 * 真要翻历史，头上那个按钮直接去库里。
 *
 * 正文视图由 ArtifactViewer 提供，与作品库共用同一份实现。
 */
const detail = computed(() => state.artifactDetail)
const meta = computed(() => detail.value?.meta || null)
</script>

<template>
  <SidePanel
    :title="meta ? meta.title : '本次对话的作品'"
    :xwide="!state.artifactFull"
    :full="state.artifactFull"
    resizable
    :width="state.artifactWidth"
    @update:width="setArtifactWidth"
  >
    <template #head-actions>
      <button v-if="meta" type="button" class="icon-btn" title="回到本次对话的作品列表" @click="closeArtifactDetail">
        <AppIcon name="panel-open" :size="16" />
      </button>
      <button v-else type="button" class="icon-btn" title="刷新" @click="refreshArtifacts">
        <AppIcon name="refresh" :size="15" />
      </button>
      <button
        type="button"
        class="icon-btn"
        :title="state.artifactFull ? '退出全屏' : '铺满窗口看（关掉抽屉就恢复）'"
        @click="toggleArtifactFull"
      >
        <AppIcon :name="state.artifactFull ? 'shrink' : 'expand'" :size="16" />
      </button>
    </template>

    <!-- ── 本会话的清单 ── -->
    <template v-if="!meta">
      <p v-if="state.artifactNote" class="note warn">{{ state.artifactNote }}</p>

      <div v-if="!state.artifacts.length" class="empty">这条对话还没有作品。</div>
      <button
        v-for="item in state.artifacts"
        :key="item.id"
        type="button"
        class="list-row"
        @click="openArtifact(item.id)"
      >
        <AppIcon :name="kindIcon(item.kind)" :size="15" class="row-icon" />
        <span class="row-main">
          <span class="row-title">{{ item.title }}</span>
          <span class="row-meta">
            {{ kindLabel(item) }} · 第 {{ item.version }} 版 · {{ formatTime(item.updatedAt) }}
          </span>
        </span>
        <AppIcon name="chevron-right" :size="14" class="row-caret" />
      </button>

      <!-- 通往独立入口。没有它，用户会以为作品只存在于"当前这条对话"里 -->
      <button type="button" class="to-library" @click="openLibrary">
        <AppIcon name="app-window" :size="14" />查看全部作品
      </button>
    </template>

    <!-- ── 正文 ── -->
    <ArtifactViewer v-else />
  </SidePanel>
</template>

<style scoped>
.note {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.6;
}
.note.warn {
  color: var(--warning);
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 30px 0;
  color: var(--muted-foreground);
  font-size: 13px;
}

.list-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.list-row:hover {
  background: var(--secondary);
  border-color: color-mix(in srgb, var(--brand-accent) 32%, var(--border));
}
.row-icon {
  color: var(--brand-accent);
}
.row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.row-title {
  overflow: hidden;
  color: var(--foreground);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-meta {
  color: var(--muted-foreground);
  font-size: 11.5px;
}
.row-caret {
  color: var(--muted-foreground);
}

.to-library {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: auto;
  padding: 8px 0;
  border: 0;
  border-top: 1px solid var(--border);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12.5px;
  cursor: pointer;
}
.to-library:hover {
  color: var(--foreground);
}
</style>
