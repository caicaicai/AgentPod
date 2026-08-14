<script setup>
import { onMounted, ref } from 'vue'

import AppIcon from './AppIcon.vue'
import { formatBytes } from '../lib/attachments.js'

/**
 * 文本附件的内容预览。
 *
 * 存在的理由：粘贴过来的那一大段被折成了一个 chip，用户在按下发送之前
 * 没有别的办法确认"我贴进去的到底是不是那一段"。
 *
 * 用原生 <dialog>：Esc 关闭、背景遮罩、焦点圈定都是白送的。
 */
const props = defineProps({
  file: { type: Object, required: true },
})
const emit = defineEmits(['close'])

const dialog = ref(null)
onMounted(() => dialog.value?.showModal())
</script>

<template>
  <dialog ref="dialog" class="preview-dialog" @close="emit('close')" @cancel="emit('close')">
    <header>
      <AppIcon name="file" :size="15" />
      <span class="name">{{ props.file.name }}</span>
      <small>{{ formatBytes(props.file.size) }}</small>
      <button type="button" class="icon-btn" title="关闭" @click="dialog?.close()">
        <AppIcon name="x" :size="16" />
      </button>
    </header>
    <textarea readonly :value="props.file.text" />
  </dialog>
</template>

<style scoped>
.preview-dialog {
  width: min(720px, calc(100vw - 32px));
  max-height: min(76vh, 640px);
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--background);
  color: var(--foreground);
  overflow: hidden;
}
.preview-dialog::backdrop {
  background: rgb(0 0 0 / 45%);
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 10px 11px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--muted-foreground);
  font-size: 12.5px;
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--foreground);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
textarea {
  display: block;
  width: 100%;
  height: min(60vh, 520px);
  padding: 12px 14px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--foreground);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  resize: none;
}
</style>
