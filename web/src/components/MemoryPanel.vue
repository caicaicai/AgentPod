<script setup>
import { ref } from 'vue'

import SidePanel from './SidePanel.vue'
import { loadMemory, saveMemory, setMemoryScope, state } from '../stores/app.js'

const saving = ref(false)

async function onSave() {
  saving.value = true
  try {
    await saveMemory()
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SidePanel title="长期记忆">
    <div class="tabs">
      <button
        type="button"
        :class="{ active: state.memoryScope === 'personal' }"
        @click="setMemoryScope('personal')"
      >个人</button>
      <button
        v-if="state.projectId"
        type="button"
        :class="{ active: state.memoryScope === 'project' }"
        @click="setMemoryScope('project')"
      >当前项目</button>
    </div>

    <p class="panel-note" :class="{ warn: state.memoryNoteWarn }">{{ state.memoryNote }}</p>

    <textarea
      v-model="state.memoryDraft"
      class="memory-text"
      placeholder="一条事实一行，以「- 」开头。例：&#10;- 偏好简短直接的回答"
    />

    <template #footer>
      <button type="button" class="primary-btn" :disabled="saving" @click="onSave">
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <!-- force=true：点「重新加载」就是明确要求丢掉本地改动，别再替他护着 -->
      <button type="button" class="ghost-btn" @click="loadMemory(true)">重新加载</button>
    </template>
  </SidePanel>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: var(--radius-sm);
  background: var(--secondary);
}
.tabs button {
  flex: 1;
  padding: 5px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12.5px;
  cursor: pointer;
}
.tabs button.active {
  background: var(--background);
  color: var(--foreground);
  font-weight: 500;
}

.memory-text {
  flex: 1;
  min-height: 260px;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  outline: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.65;
  resize: none;
}
.memory-text:focus {
  border-color: color-mix(in srgb, var(--brand-accent) 45%, var(--border));
}
</style>
