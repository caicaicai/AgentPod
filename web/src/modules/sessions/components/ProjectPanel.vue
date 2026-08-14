<script setup>
import { ref, watchEffect } from 'vue'

import SidePanel from './SidePanel.vue'
import { closePanel, currentProject, deleteProject, saveProject } from '../stores/app.js'
import { askConfirm } from '../lib/dialog.js'

const form = ref({ name: '', description: '', instructions: '' })
const saving = ref(false)

// 面板一开就把当前项目灌进表单；切了项目也跟着换
watchEffect(() => {
  const project = currentProject()
  if (!project) return
  form.value = {
    name: project.name || '',
    description: project.description || '',
    instructions: project.instructions || '',
  }
})

async function onSave() {
  saving.value = true
  try {
    if (await saveProject({
      name: form.value.name.trim(),
      description: form.value.description.trim(),
      instructions: form.value.instructions,
    })) closePanel()
  } finally {
    saving.value = false
  }
}

async function onDelete() {
  const project = currentProject()
  if (!project) return
  // 说清楚"会话不会跟着删"：不说的话没人敢点，说错了更糟
  const ok = await askConfirm({
    title: `删除项目「${project.name}」`,
    message: '它下面的对话不会被删除，会退回「未分组」。\n项目指令与项目记忆会一并删除。',
    confirmText: '删除项目',
    danger: true,
  })
  if (ok) deleteProject()
}
</script>

<template>
  <SidePanel :title="`项目设置 · ${currentProject()?.name || ''}`">
    <p class="panel-note">
      项目指令会在<strong>该项目下每一轮对话</strong>进入系统提示，不用每次重新交代背景。
    </p>

    <label class="field">
      <span>项目名</span>
      <input v-model="form.name" type="text" />
    </label>

    <label class="field">
      <span>一句话说明</span>
      <input v-model="form.description" type="text" placeholder="可选" />
    </label>

    <label class="field grow">
      <span>项目指令</span>
      <textarea
        v-model="form.instructions"
        placeholder="例：&#10;这是结算中台的日常维护项目。&#10;回答涉及改动时请始终列出风险点与回滚方式。"
      />
    </label>

    <template #footer>
      <button type="button" class="primary-btn" :disabled="saving" @click="onSave">
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <span class="spacer" />
      <button type="button" class="ghost-btn danger" @click="onDelete">删除项目</button>
    </template>
  </SidePanel>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field.grow {
  flex: 1;
  min-height: 200px;
}
.field > span {
  color: var(--muted-foreground);
  font-size: 12px;
}
.field input,
.field textarea {
  width: 100%;
  padding: 8px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  outline: 0;
  background: var(--background);
  color: var(--foreground);
  font-size: 13px;
}
.field textarea {
  flex: 1;
  min-height: 180px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.65;
  resize: none;
}
.field input:focus,
.field textarea:focus {
  border-color: color-mix(in srgb, var(--brand-accent) 45%, var(--border));
}
.spacer {
  flex: 1;
}
</style>
