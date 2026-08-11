<script setup>
import SidePanel from './SidePanel.vue'
import { closePanel, state } from '../stores/app.js'

/** 点一条技能 → 填进输入框。用户接着补一句"要做什么"，模型就知道该用哪个 */
function useSkill(skill) {
  const name = skill.displayName || skill.name
  state.draft = state.draft
    ? `${state.draft.trimEnd()}\n用「${name}」来做：`
    : `用「${name}」来做：`
  closePanel()
}
</script>

<template>
  <SidePanel title="技能">
    <p class="panel-note" :class="{ warn: state.skillsNoteWarn }">{{ state.skillsNote }}</p>

    <div v-if="!state.skills.length" class="empty">空</div>

    <div v-else class="skill-list">
      <button
        v-for="skill in state.skills"
        :key="skill.name"
        type="button"
        class="skill-card"
        @click="useSkill(skill)"
      >
        <span class="skill-name">
          <span v-if="skill.emoji" class="emoji">{{ skill.emoji }}</span>
          {{ skill.displayName || skill.name }}
          <!-- 中文展示名旁边补一行英文 name：它才是唯一标识，用户跟模型沟通时要用它 -->
          <code v-if="skill.displayName && skill.displayName !== skill.name">{{ skill.name }}</code>
          <span v-if="skill.scope === 'personal'" class="tag">我的</span>
        </span>
        <span class="skill-desc">{{ skill.description || '' }}</span>
      </button>
    </div>
  </SidePanel>
</template>

<style scoped>
.skill-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.skill-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--background);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}
.skill-card:hover {
  border-color: color-mix(in srgb, var(--brand-accent) 40%, var(--border));
  background: color-mix(in srgb, var(--brand-accent) 5%, var(--background));
}
.skill-name {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  color: var(--foreground);
  font-size: 13.5px;
  font-weight: 600;
}
.emoji {
  font-size: 14px;
}
.skill-name code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--secondary);
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 400;
}
.tag {
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--brand-accent) 14%, transparent);
  color: var(--brand-accent);
  font-size: 10.5px;
  font-weight: 500;
}
.skill-desc {
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.6;
}
.empty {
  padding: 20px 0;
  color: var(--muted-foreground);
  font-size: 12.5px;
  text-align: center;
}
</style>
