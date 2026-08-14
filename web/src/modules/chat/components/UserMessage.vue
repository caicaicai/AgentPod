<script setup>
import AppIcon from './AppIcon.vue'
import ElementChip from './ElementChip.vue'
import FileChips from './FileChips.vue'
import { copyToClipboard } from '../lib/debug-bundle.js'
import { formatClock } from '../lib/format.js'
import { ref } from 'vue'

const props = defineProps({
  turn: { type: Object, required: true },
})
const emit = defineEmits(['preview', 'open-file'])

const copied = ref(false)
async function copy() {
  copied.value = await copyToClipboard(props.turn.text || '')
  setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <div class="message-row user-row">
    <div class="bubble-wrap">
      <div class="user-bubble">
        <ElementChip v-if="props.turn.element" :element="props.turn.element" class="user-element" />
        <div v-if="props.turn.text" class="user-text">{{ props.turn.text }}</div>
        <FileChips
          :files="props.turn.files || []"
          @preview="(url) => emit('preview', url)"
          @open="(file) => emit('open-file', file)"
        />
        <!--
          `images` 是从历史里数出来的张数：会话存的是 pi 的 content part，
          不留原始文件名，所以刷新之后只剩个数量。有总比让附件凭空消失强。
        -->
        <div v-if="props.turn.images" class="image-note">（含 {{ props.turn.images }} 张图片）</div>
      </div>
      <div class="message-meta">
        <button type="button" class="msg-copy" :title="copied ? '已复制' : '复制'" @click="copy">
          <AppIcon :name="copied ? 'check' : 'copy'" :size="13" />
        </button>
        <span v-if="props.turn.timestamp" class="message-time">{{ formatClock(props.turn.timestamp) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-row {
  position: relative;
  /* 底部这条通道是给悬停时才出现的时间/复制留的：它出现时不会把下面的内容顶开，
     消失时也不会留一块空洞。同时它就是消息之间的呼吸感。 */
  padding-bottom: 20px;
}
.user-row {
  display: flex;
  justify-content: flex-end;
}
.bubble-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: min(76%, 640px);
}
.user-bubble {
  padding: 10px 14px;
  border-radius: 18px;
  background: color-mix(in srgb, var(--secondary) 76%, var(--background));
  color: var(--foreground);
  font-size: 15px;
  line-height: 1.55;
}
.user-element {
  margin-bottom: 8px;
  /* 气泡是主色底，chip 自己那层浅色底在上面会糊成一片，压深一点 */
  background: color-mix(in srgb, var(--background) 22%, transparent);
  border-color: color-mix(in srgb, var(--background) 35%, transparent);
}

.user-text {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.image-note {
  margin-top: 6px;
  color: var(--muted-foreground);
  font-size: 12px;
}

.message-meta {
  position: absolute;
  right: 2px;
  bottom: -18px;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 18px;
  color: var(--muted-foreground);
  font-size: 11px;
  opacity: 0;
  /* 用 pointer-events 而不是 visibility 关掉交互：按钮仍然可以被键盘聚焦，
     :focus-within 会把整条footer显示出来 —— 这是键盘用户唯一的入口 */
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.message-row:hover .message-meta,
.message-meta:focus-within {
  opacity: 1;
  pointer-events: auto;
}
/* 触屏没有 hover，也没法聚焦一个 pointer-events:none 的按钮 —— 那里就常驻显示 */
@media (hover: none) {
  .message-meta {
    opacity: 1;
    pointer-events: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .message-meta {
    transition: none;
  }
}
.message-time {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.msg-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}
.msg-copy:hover {
  background: var(--secondary);
  color: var(--foreground);
}
</style>
