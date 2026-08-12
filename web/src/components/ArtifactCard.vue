<script setup>
import { computed } from 'vue'

import AppIcon from './AppIcon.vue'
import { kindIcon, kindLabel } from '../lib/artifact-view.js'
import { openArtifact, state } from '../stores/app.js'

/**
 * 对话里的作品卡片。
 *
 * 它替代的是那堵贴在气泡里的代码墙：这里只留标题、类型和版本，正文在右边的面板里。
 * 点一下就是"打开"——这也是唯一的入口，所以整张卡都是按钮，而不是角落里一个小链接。
 */
const props = defineProps({
  card: { type: Object, required: true },
})

const icon = computed(() => kindIcon(props.card.kind))
const kind = computed(() => kindLabel(props.card))
/** 多文件时把文件数写出来：那是「它拆了模块」这件事在对话里唯一的痕迹 */
const fileNote = computed(() => {
  const count = props.card.files?.length || 0
  return count > 1 ? `${count} 个文件` : ''
})
const isUpdate = computed(() => props.card.action === 'update' || props.card.action === 'write')
const opened = computed(() => state.artifactDetail?.meta?.id === props.card.id && state.panel === 'artifact')
</script>

<template>
  <button
    type="button"
    class="artifact-card"
    :class="{ pending: props.card.pending, opened }"
    :disabled="props.card.pending"
    @click="openArtifact(props.card.id, props.card.version)"
  >
    <span class="art-icon">
      <span v-if="props.card.pending" class="spinner" />
      <AppIcon v-else :name="icon" :size="17" />
    </span>

    <span class="art-main">
      <span class="art-title">{{ props.card.title }}</span>
      <span class="art-meta">
        {{ kind }}
        <template v-if="props.card.version">· 第 {{ props.card.version }} 版</template>
        <template v-if="fileNote">· {{ fileNote }}</template>
        <template v-if="isUpdate">· 已更新</template>
      </span>
    </span>

    <span class="art-open">
      {{ props.card.pending ? '生成中' : opened ? '查看中' : '打开' }}
      <AppIcon v-if="!props.card.pending" name="chevron-right" :size="14" />
    </span>
  </button>
</template>

<style scoped>
.artifact-card {
  display: flex;
  align-items: center;
  gap: 11px;
  width: 100%;
  margin: 10px 0;
  padding: 12px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--secondary) 42%, var(--background));
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}
.artifact-card:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--brand-accent) 45%, var(--border));
  background: color-mix(in srgb, var(--brand-accent) 6%, var(--background));
}
.artifact-card.opened {
  border-color: color-mix(in srgb, var(--brand-accent) 55%, var(--border));
}
.artifact-card.pending {
  cursor: default;
}

.art-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--brand-accent) 14%, transparent);
  color: var(--brand-accent);
}

.art-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}
.art-title {
  overflow: hidden;
  color: var(--foreground);
  font-size: 13.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.art-meta {
  color: var(--muted-foreground);
  font-size: 11.5px;
}

.art-open {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  color: var(--muted-foreground);
  font-size: 12px;
}
</style>
