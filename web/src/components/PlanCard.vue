<script setup>
import { computed } from 'vue'

import AppIcon from './AppIcon.vue'

const props = defineProps({
  plan: { type: Object, required: true },
})

const tasks = computed(() => (props.plan.tasks || []).filter((task) => task?.content))
const completed = computed(() => tasks.value.filter((task) => task.status === 'completed').length)

function statusOf(task) {
  return ['pending', 'in_progress', 'completed'].includes(task.status) ? task.status : 'pending'
}
</script>

<template>
  <div class="plan-card">
    <div class="plan-head">
      <AppIcon name="tasks" :size="14" />
      <span class="plan-title">{{ props.plan.title || '任务清单' }}</span>
      <span class="plan-progress">{{ completed }}/{{ tasks.length }}</span>
    </div>
    <div v-for="(task, index) in tasks" :key="index" class="plan-task" :class="statusOf(task)">
      <span class="mark">
        <AppIcon v-if="statusOf(task) === 'completed'" name="check" :size="12" />
        <span v-else-if="statusOf(task) === 'in_progress'" class="dot" />
        <span v-else class="ring" />
      </span>
      <span class="task-text">{{ task.content }}</span>
    </div>
  </div>
</template>

<style scoped>
.plan-card {
  margin: 10px 0;
  padding: 10px 12px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--secondary) 42%, var(--background));
}
.plan-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 8px;
  color: var(--muted-foreground);
  font-size: 12px;
}
.plan-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--foreground);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-progress {
  font-variant-numeric: tabular-nums;
}

.plan-task {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 3px 0;
  font-size: 13.5px;
  line-height: 1.55;
}
.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 21px;
  flex: 0 0 16px;
  color: var(--muted-foreground);
}
.ring {
  width: 9px;
  height: 9px;
  border: 1.5px solid currentcolor;
  border-radius: 50%;
  opacity: 0.55;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--brand-accent);
  /* 正在做的那一条要能一眼扫到 —— 清单的用处就在于"现在轮到哪一步" */
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand-accent) 22%, transparent);
}
.plan-task.completed .task-text {
  color: var(--muted-foreground);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--muted-foreground) 55%, transparent);
}
.plan-task.completed .mark {
  color: var(--success);
}
.plan-task.in_progress .task-text {
  color: var(--foreground);
  font-weight: 500;
}
.plan-task.pending .task-text {
  color: var(--muted-foreground);
}
</style>
