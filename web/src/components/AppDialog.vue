<script setup>
import { nextTick, ref, watch } from 'vue'

import AppIcon from './AppIcon.vue'
import { cancelDialog, confirmDialog, dialog } from '@/lib/dialog.js'

/**
 * 询问框：取代 window.prompt / window.confirm。
 *
 * 一个实例挂在 App 根上，谁要问就调 askText / askConfirm（见 lib/dialog.js）。
 * 挂一个而不是每个用到的地方挂一个：同一时刻只可能有一个问题在问，
 * 而多实例意味着"两个弹框叠在一起"这种状态真的存在得了。
 */
const input = ref(null)

/**
 * 打开时把焦点送进输入框，并**选中已有内容**。
 *
 * 重命名是这里最常见的用法：进来就选中，想改名的人直接打字覆盖，
 * 想微调的人按一下右箭头 —— 两种都不用先动鼠标。
 */
watch(() => dialog.open, (open) => {
  if (!open || dialog.kind !== 'text') return
  nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
})

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    cancelDialog()
    return
  }
  // 多行输入这里用不上，Enter 直接确认
  if (event.key === 'Enter') {
    event.preventDefault()
    confirmDialog()
  }
}
</script>

<template>
  <div v-if="dialog.open" class="mask" @click.self="cancelDialog" @keydown="onKeydown">
    <section class="dialog" role="dialog" aria-modal="true" :aria-label="dialog.title">
      <header>
        <h2>{{ dialog.title }}</h2>
        <button type="button" class="icon-btn" title="取消（Esc）" @click="cancelDialog">
          <AppIcon name="x" :size="15" />
        </button>
      </header>

      <div class="body">
        <p v-if="dialog.message" class="message">{{ dialog.message }}</p>

        <label v-if="dialog.kind === 'text'" class="field">
          <span v-if="dialog.label">{{ dialog.label }}</span>
          <input
            ref="input"
            v-model="dialog.value"
            type="text"
            :placeholder="dialog.placeholder"
            @keydown="onKeydown"
            @input="dialog.error = ''"
          />
          <span v-if="dialog.error" class="error">{{ dialog.error }}</span>
        </label>
      </div>

      <footer>
        <button type="button" class="ghost-btn" @click="cancelDialog">取消</button>
        <button
          type="button"
          class="primary-btn"
          :class="{ danger: dialog.danger }"
          @click="confirmDialog"
        >{{ dialog.confirmText }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--foreground) 32%, transparent);
}

.dialog {
  display: flex;
  flex-direction: column;
  width: min(420px, 100%);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--background);
  box-shadow: 0 24px 60px color-mix(in srgb, var(--foreground) 24%, transparent);
}

header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 10px 12px 18px;
}
header h2 {
  flex: 1;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.body {
  padding: 0 18px 4px;
}
.message {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}
.field span {
  color: var(--muted-foreground);
  font-size: 12.5px;
}
.field input {
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-size: 14px;
}
.field input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--brand-accent) 50%, var(--border));
}
.error {
  color: var(--destructive);
  font-size: 12px;
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 18px 16px;
}
.primary-btn.danger {
  background: var(--destructive);
  color: #fff;
}
</style>
