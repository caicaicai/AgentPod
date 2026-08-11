<script setup>
import { toasts } from '@/store/cluster.js'
</script>

<template>
  <div class="host">
    <TransitionGroup name="toast">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.level">{{ t.message }}</div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.host {
  position: fixed;
  right: 20px;
  bottom: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 100;
  pointer-events: none;
}
.toast {
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--text-faint);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  padding: 9px 14px;
  font-size: 13px;
  max-width: 420px;
}
.toast.ok { border-left-color: var(--ok); }
.toast.error { border-left-color: var(--error); }
.toast.warn { border-left-color: var(--warn); }

.toast-enter-active, .toast-leave-active { transition: all 0.2s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(16px); }
</style>
