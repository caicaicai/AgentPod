<script setup>
import { ref } from 'vue'
import { login, ApiError } from '@/api/client.js'
import { onLogin } from '@/store/cluster.js'

const username = ref('')
const password = ref('')
const errorMsg = ref('')
const submitting = ref(false)

async function handleSubmit() {
  errorMsg.value = ''
  if (!username.value || !password.value) {
    errorMsg.value = '请输入用户名和密码'
    return
  }
  submitting.value = true
  try {
    await login(username.value, password.value)
    onLogin()
  } catch (e) {
    errorMsg.value = e instanceof ApiError ? e.message : '登录失败，请重试'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="overlay">
    <form class="login-card card" @submit.prevent="handleSubmit">
      <h2>沙盒集群管理台</h2>
      <p class="muted">请登录以继续</p>

      <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>

      <label>
        <span class="label-text">用户名</span>
        <input
          v-model="username"
          type="text"
          autocomplete="username"
          autofocus
          :disabled="submitting"
        />
      </label>

      <label>
        <span class="label-text">密码</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          :disabled="submitting"
        />
      </label>

      <button type="submit" class="primary" :disabled="submitting">
        {{ submitting ? '登录中…' : '登录' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}

.login-card {
  width: 360px;
  padding: 36px 32px 28px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.login-card h2 {
  margin: 0;
  font-size: 20px;
  text-align: center;
}

.login-card .muted {
  text-align: center;
  margin: -8px 0 4px;
  font-size: 13px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.label-text {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
}

.login-card input {
  padding: 8px 10px;
}

.error-msg {
  background: var(--error-soft);
  color: var(--error);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  text-align: center;
}

.login-card button.primary {
  margin-top: 4px;
  padding: 9px 0;
  font-size: 14px;
}
</style>
