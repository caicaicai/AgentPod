<script setup>
import { onMounted, ref } from 'vue'

import SidePanel from './SidePanel.vue'
import { state } from '../stores/app.js'

/**
 * 调试信息的兜底展示。
 *
 * 线上跑在 http:// 内网域名下，那里 navigator.clipboard 根本不存在（非安全上下文），
 * execCommand 那条老路也可能被浏览器策略挡掉 —— 两条都不行时把文本摊开让人手动复制，
 * 总好过按钮点了没反应。
 */
const area = ref(null)
onMounted(() => {
  area.value?.focus()
  area.value?.select()
})
</script>

<template>
  <SidePanel title="调试信息" wide>
    <p class="panel-note warn">{{ state.debugNote }}</p>
    <textarea ref="area" class="debug-text" readonly :value="state.debugText" />
  </SidePanel>
</template>

<style scoped>
.debug-text {
  flex: 1;
  min-height: 320px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  outline: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  resize: none;
}
</style>
