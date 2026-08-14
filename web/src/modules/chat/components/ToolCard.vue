<script setup>
import { computed, ref } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import { TOOL_ICONS, TOOL_LABELS, TOOL_STATUS_TEXT, toolBrief } from '../tools.js'

const props = defineProps({
  block: { type: Object, required: true },
})
const emit = defineEmits(['preview'])

const open = ref(false)

const label = computed(() => TOOL_LABELS[props.block.toolName] || props.block.toolName)
const icon = computed(() => TOOL_ICONS[props.block.toolName] || 'terminal')
const brief = computed(() => toolBrief(props.block.toolName, props.block.args))
const running = computed(() => props.block.status === 'running')
const argsText = computed(() => {
  try {
    return JSON.stringify(props.block.args ?? {}, null, 2)
  } catch {
    return String(props.block.args)
  }
})
</script>

<template>
  <div class="tool-card" :class="`is-${props.block.status}`">
    <button type="button" class="tool-head" @click="open = !open">
      <span class="spinner" v-if="running" />
      <AppIcon v-else :name="icon" :size="14" class="tool-icon" />
      <span class="tool-name">{{ label }}</span>
      <span class="tool-brief">{{ brief }}</span>
      <span class="tool-status">{{ TOOL_STATUS_TEXT[props.block.status] || '' }}</span>
      <AppIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="14" class="tool-caret" />
    </button>

    <div v-if="open" class="tool-body">
      <h4>参数</h4>
      <pre>{{ argsText }}</pre>
      <template v-if="!running">
        <h4>结果</h4>
        <pre>{{ props.block.preview || '（无输出）' }}</pre>
        <p v-if="props.block.previewTruncated" class="truncated-note">
          已截断，原长 {{ props.block.resultLength }} 字符
        </p>
      </template>
    </div>

    <!--
      图片画在卡片**外面**，而且不受折叠状态影响。
      卡片默认是收起来的 —— 图放进去等于没画：用户说"帮我截个图"，结果还得先
      展开一个叫"浏览器"的折叠块才能看到。截图本来就是给人看的，它该像正文一样
      直接出现在对话里。
    -->
    <div v-if="props.block.images?.length" class="tool-images">
      <img
        v-for="(img, index) in props.block.images"
        :key="index"
        class="tool-image"
        :src="`data:${img.mimeType};base64,${img.data}`"
        alt="工具返回的截图"
        loading="lazy"
        @click="emit('preview', `data:${img.mimeType};base64,${img.data}`)"
      />
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  margin: 8px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--secondary) 42%, var(--background));
  overflow: hidden;
}
.tool-card.is-error {
  border-color: color-mix(in srgb, var(--destructive) 40%, var(--border));
}
.tool-card.is-running {
  border-color: color-mix(in srgb, var(--brand-accent) 40%, var(--border));
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.tool-head:hover {
  background: color-mix(in srgb, var(--foreground) 4%, transparent);
}
.tool-icon {
  color: var(--muted-foreground);
}
.tool-name {
  flex: 0 0 auto;
  color: var(--foreground);
  font-weight: 500;
}
.tool-brief {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-status {
  flex: 0 0 auto;
  font-size: 11.5px;
}
.tool-card.is-error .tool-status {
  color: var(--destructive);
}
.tool-card.is-aborted .tool-status {
  color: var(--warning);
}
.tool-caret {
  flex: 0 0 auto;
  color: var(--muted-foreground);
}

.tool-body {
  padding: 2px 10px 10px;
  border-top: 1px solid var(--border);
}
.tool-body h4 {
  margin: 10px 0 5px;
  color: var(--muted-foreground);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.tool-body pre {
  margin: 0;
  padding: 9px 10px;
  max-height: 340px;
  border-radius: var(--radius-sm);
  background: var(--background);
  border: 1px solid var(--border);
  color: var(--foreground);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.truncated-note {
  margin: 6px 0 0;
  color: var(--muted-foreground);
  font-size: 11.5px;
}

.tool-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--border);
}
.tool-image {
  max-width: min(360px, 100%);
  max-height: 300px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: zoom-in;
}
</style>
