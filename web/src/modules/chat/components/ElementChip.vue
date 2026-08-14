<script setup>
import { computed, ref } from 'vue'

import AppIcon from '@/components/AppIcon.vue'

/**
 * 「引用了预览里的某个元素」的那枚 chip。
 *
 * 输入框上方和历史消息里共用一份：两处显示的是同一件事，各画一遍迟早长歪。
 *
 * ⚠️ 里面的字段来自沙箱文档的 postMessage（模型生成的页面可以伪造），
 * 所以**只用插值渲染**，Vue 会转义。绝不 v-html —— 那等于把预览沙箱那道防线
 * 从背后绕过来。
 */
const props = defineProps({
  element: { type: Object, required: true },
  /** 输入框里那枚可以撤掉；历史里那枚只是记录 */
  removable: { type: Boolean, default: false },
})
defineEmits(['remove'])

const open = ref(false)
/** 一行放不下的时候，原文片段折起来 —— 它是给模型看的，人只需要知道"选中了什么" */
const snippet = computed(() => String(props.element.html || '').trim())
</script>

<template>
  <div class="chip" :class="{ removable }">
    <span class="chip-head">
      <AppIcon name="crosshair" :size="13" class="chip-icon" />
      <code class="chip-label">{{ props.element.label }}</code>
      <span v-if="props.element.info" class="chip-info">{{ props.element.info }}</span>

      <button
        v-if="snippet"
        type="button"
        class="chip-toggle"
        :title="open ? '收起原文' : '看看选中的是哪一段'"
        @click="open = !open"
      >
        <AppIcon :name="open ? 'chevron-down' : 'chevron-right'" :size="12" />
      </button>
      <button v-if="removable" type="button" class="chip-x" title="不带这个元素了" @click="$emit('remove')">
        <AppIcon name="x" :size="12" />
      </button>
    </span>

    <pre v-if="open && snippet" class="chip-code">{{ snippet }}</pre>
  </div>
</template>

<style scoped>
.chip {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--brand-accent) 35%, var(--border));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--brand-accent) 8%, transparent);
}

.chip-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.chip-icon {
  flex: 0 0 auto;
  color: var(--brand-accent);
}
.chip-label {
  flex: 0 0 auto;
  color: var(--brand-accent);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 600;
}
.chip-info {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-toggle,
.chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  margin-left: auto;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}
.chip-toggle {
  margin-left: 0;
}
.chip-toggle:hover,
.chip-x:hover {
  background: color-mix(in srgb, var(--foreground) 8%, transparent);
  color: var(--foreground);
}

.chip-code {
  margin: 0;
  padding: 7px 9px;
  max-height: 160px;
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
