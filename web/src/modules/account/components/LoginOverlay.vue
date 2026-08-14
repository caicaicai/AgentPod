<script setup>
import { ref } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import { login, state } from '@/stores/app.js'

const username = ref('')
const password = ref('')
const loading = ref(false)

async function onSubmit() {
  if (loading.value) return
  const u = username.value.trim()
  const p = password.value
  if (!u || !p) return
  loading.value = true
  try {
    await login(u, p)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-overlay">
    <form class="login-card" @submit.prevent="onSubmit">
      <div class="login-brand">
        <span class="brand-mark"><AppIcon name="sparkle" :size="18" filled /></span>
        <span class="brand-name">AgentPod</span>
      </div>

      <div class="login-field">
        <label for="login-user">用户名</label>
        <input
          id="login-user"
          v-model="username"
          type="text"
          autocomplete="username"
          autofocus
          placeholder="请输入用户名"
          :disabled="loading"
        />
      </div>

      <div class="login-field">
        <label for="login-pass">密码</label>
        <input
          id="login-pass"
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="请输入密码"
          :disabled="loading"
        />
      </div>

      <div v-if="state.loginError" class="login-error">{{ state.loginError }}</div>

      <button type="submit" class="login-btn" :disabled="loading || !username.trim() || !password">
        {{ loading ? '登录中…' : '登录' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--background);
}

.login-card {
  width: 100%;
  max-width: 380px;
  padding: 40px 36px 36px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--background);
  box-shadow: 0 8px 32px color-mix(in srgb, var(--foreground) 8%, transparent);
}

.login-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 32px;
  font-size: 18px;
  font-weight: 600;
  color: var(--foreground);
}
.login-brand .brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--brand-accent);
  color: #fff;
}

.login-field {
  margin-bottom: 18px;
}
.login-field label {
  display: block;
  margin-bottom: 6px;
  color: var(--foreground);
  font-size: 13.5px;
  font-weight: 500;
}
.login-field input {
  width: 100%;
  padding: 10px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-size: 14px;
  outline: 0;
  transition: border-color 0.15s ease;
  box-sizing: border-box;
}
.login-field input::placeholder {
  color: var(--muted-foreground);
}
.login-field input:focus {
  border-color: var(--brand-accent);
}
.login-field input:disabled {
  opacity: 0.6;
}

.login-error {
  margin-bottom: 14px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--destructive) 10%, transparent);
  color: var(--destructive);
  font-size: 13px;
  line-height: 1.5;
}

.login-btn {
  width: 100%;
  padding: 11px 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--brand-accent);
  color: #fff;
  font-size: 14.5px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s ease;
}
.login-btn:hover:not(:disabled) {
  opacity: 0.9;
}
.login-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
