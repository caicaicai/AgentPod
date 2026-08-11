<script setup>
import { computed } from 'vue'

const props = defineProps({
  used: { type: Number, required: true },
  total: { type: Number, required: true },
  /** 摘除中的节点即使有空位也不会被调度，用条纹和它区分开 */
  inactive: { type: Boolean, default: false },
})

const ratio = computed(() => (props.total > 0 ? Math.min(1, props.used / props.total) : 0))
const level = computed(() => {
  if (props.inactive) return 'inactive'
  if (ratio.value >= 1) return 'full'
  if (ratio.value >= 0.85) return 'high'
  return 'normal'
})
</script>

<template>
  <div class="wrap" :title="`${used} / ${total} 槽位`">
    <div class="track">
      <div class="fill" :class="level" :style="{ width: `${ratio * 100}%` }" />
    </div>
    <span class="label mono">{{ used }}/{{ total }}</span>
  </div>
</template>

<style scoped>
.wrap { display: flex; align-items: center; gap: 8px; min-width: 120px; }
.track {
  flex: 1;
  height: 6px;
  background: var(--bg-sunken);
  border-radius: 3px;
  overflow: hidden;
}
.fill { height: 100%; border-radius: 3px; transition: width 0.3s ease; }
.fill.normal { background: var(--accent); }
.fill.high { background: var(--warn); }
.fill.full { background: var(--error); }
.fill.inactive {
  background: repeating-linear-gradient(
    45deg,
    var(--text-faint) 0 4px,
    transparent 4px 8px
  );
}
.label { font-size: 11.5px; color: var(--text-muted); white-space: nowrap; }
</style>
