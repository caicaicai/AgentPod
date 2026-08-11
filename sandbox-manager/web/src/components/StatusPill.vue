<script setup>
defineProps({
  level: { type: String, default: 'neutral' }, // ok | warn | error | neutral
  text: { type: String, required: true },
})
</script>

<template>
  <span class="pill" :class="level">{{ text }}</span>
</template>

<style scoped>
.pill {
  display: inline-block;
  font-size: 12px;
  line-height: 1.5;
  padding: 1px 8px;
  border-radius: 10px;
  background: var(--neutral-soft);
  color: var(--text-muted);
  white-space: nowrap;
}
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.error { background: var(--error-soft); color: var(--error); }
</style>
