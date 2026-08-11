<script setup>
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], required: true },
  hint: { type: String, default: '' },
  level: { type: String, default: '' }, // ok | warn | error
})
</script>

<template>
  <div class="card stat">
    <div class="label">{{ label }}</div>
    <div class="value" :class="level">{{ value }}</div>
    <div v-if="hint" class="hint faint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.stat { padding: 14px 16px; }
.label { font-size: 12px; color: var(--text-muted); }
.value { font-size: 26px; font-weight: 600; line-height: 1.3; margin-top: 2px; }
.value.ok { color: var(--ok); }
.value.warn { color: var(--warn); }
.value.error { color: var(--error); }
.hint { font-size: 12px; }
</style>
