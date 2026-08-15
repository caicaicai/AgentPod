<script setup>
/**
 * 登录 / 注册 / 激活，三屏共用一张卡片。
 *
 * ── 这三屏之间怎么走 ────────────────────────────────────────────────────
 *
 *   登录 ──(账号未激活)──→ 激活
 *   注册 ──(部署要求验证码)──→ 激活 ──(成功)──→ 直接进应用
 *
 * "从登录跳到激活"那一条是必须有的：注册完之后关掉页面、第二天回来直接登录的人
 * 一定存在。没有这条路，他会对着一个正确的密码反复重试，而错误提示说的是
 * "还没激活" —— 看得懂，却无处可去。
 *
 * ── 画不画注册、注册要不要邮箱，一律听服务端的 ──────────────────────────
 *
 * 都从 `/healthz` 的能力宣告里读（features.register / registerEmail /
 * registerVerifyEmail）。前端自己猜的话，配置一错位就会出现"注册页要求填邮箱、
 * 服务端根本不收"或者反过来"填完提交才被告知邮箱必填"。
 *
 * 这里读的是 `state.health`，**不是 `state.features`** —— 后者要等登录之后
 * 才填（见 stores/app.js 的 bootAfterLogin），而这张卡片正是登录之前那一屏。
 */
import { computed, onUnmounted, ref } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import { activateAccount, login, register, resendActivationCode, state } from '@/stores/app.js'

const features = computed(() => state.health?.features || {})
const canRegister = computed(() => Boolean(features.value.register))
const needEmail = computed(() => Boolean(features.value.registerEmail))
const verifyEmail = computed(() => Boolean(features.value.registerVerifyEmail))

/** login | register | activate */
const mode = ref('login')
const username = ref('')
const password = ref('')
const email = ref('')
const code = ref('')
const loading = ref(false)
/** 打过码的收件邮箱，服务端回的（`z*****@example.com`）。用来告诉用户"信发去哪儿了" */
const sentTo = ref('')
const notice = ref('')

/** 重发倒计时。服务端也有一道发信间隔闸，这里只是别让人白点 */
const cooldown = ref(0)
let cooldownTimer = 0

function startCooldown(seconds = 60) {
  cooldown.value = seconds
  clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1
    if (cooldown.value <= 0) clearInterval(cooldownTimer)
  }, 1000)
}

onUnmounted(() => clearInterval(cooldownTimer))

function switchMode(next) {
  mode.value = next
  state.loginError = ''
  notice.value = ''
  code.value = ''
}

/** 进入激活屏。用户名带过去 —— 他刚填过，没道理再问一遍 */
function goActivate({ email: masked = '', message = '' } = {}) {
  sentTo.value = masked
  notice.value = message
  mode.value = 'activate'
  state.loginError = ''
  code.value = ''
}

const submitLabel = computed(() => {
  if (loading.value) return { login: '登录中…', register: '提交中…', activate: '激活中…' }[mode.value]
  return { login: '登录', register: '注册', activate: '激活并登录' }[mode.value]
})

const canSubmit = computed(() => {
  if (loading.value || !username.value.trim()) return false
  if (mode.value === 'activate') return Boolean(code.value.trim())
  if (!password.value) return false
  if (mode.value === 'register' && needEmail.value && !email.value.trim()) return false
  return true
})

async function onSubmit() {
  if (!canSubmit.value) return
  loading.value = true
  try {
    const name = username.value.trim()
    if (mode.value === 'login') {
      const result = await login(name, password.value)
      // 密码对了，只是还没激活 —— 不是失败，是流程还差一步
      if (result?.needActivation) {
        goActivate({ email: result.email, message: '这个账号还没激活，填写邮箱收到的验证码即可完成' })
      }
    } else if (mode.value === 'register') {
      const result = await register(name, password.value, email.value.trim())
      if (result?.pendingActivation) {
        goActivate({ email: result.email, message: '验证码已发送到你的邮箱' })
        startCooldown()
      }
    } else {
      await activateAccount(name, code.value.trim())
    }
  } finally {
    loading.value = false
  }
}

async function onResend() {
  if (loading.value || cooldown.value > 0) return
  loading.value = true
  try {
    const result = await resendActivationCode(username.value.trim())
    if (result.ok) {
      notice.value = result.message
      startCooldown()
    }
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

      <!-- 注册没开的部署上不画这一排：那会让人点进一个必然被服务端拒绝的表单 -->
      <div v-if="canRegister && mode !== 'activate'" class="login-tabs">
        <button type="button" :class="{ active: mode === 'login' }" @click="switchMode('login')">登录</button>
        <button type="button" :class="{ active: mode === 'register' }" @click="switchMode('register')">注册</button>
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
          :disabled="loading || mode === 'activate'"
        />
      </div>

      <div v-if="mode !== 'activate'" class="login-field">
        <label for="login-pass">密码</label>
        <input
          id="login-pass"
          v-model="password"
          type="password"
          :autocomplete="mode === 'register' ? 'new-password' : 'current-password'"
          :placeholder="mode === 'register' ? '至少 8 位' : '请输入密码'"
          :disabled="loading"
        />
      </div>

      <div v-if="mode === 'register' && needEmail" class="login-field">
        <label for="login-email">邮箱</label>
        <input
          id="login-email"
          v-model="email"
          type="email"
          autocomplete="email"
          placeholder="用于接收验证码"
          :disabled="loading"
        />
        <p v-if="verifyEmail" class="login-hint">注册后会收到一封验证码邮件，验证通过账号才会激活。</p>
      </div>

      <div v-if="mode === 'activate'" class="login-field">
        <label for="login-code">验证码</label>
        <input
          id="login-code"
          v-model="code"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          placeholder="邮箱收到的验证码"
          :disabled="loading"
        />
        <p v-if="sentTo" class="login-hint">验证码已发送至 {{ sentTo }}</p>
      </div>

      <div v-if="notice" class="login-notice">{{ notice }}</div>
      <div v-if="state.loginError" class="login-error">{{ state.loginError }}</div>

      <button type="submit" class="login-btn" :disabled="!canSubmit">{{ submitLabel }}</button>

      <div v-if="mode === 'activate'" class="login-foot">
        <button type="button" class="login-link" :disabled="loading || cooldown > 0" @click="onResend">
          {{ cooldown > 0 ? `重新发送（${cooldown}s）` : '重新发送验证码' }}
        </button>
        <button type="button" class="login-link" @click="switchMode('login')">返回登录</button>
      </div>
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

.login-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 22px;
  padding: 3px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--foreground) 5%, transparent);
}
.login-tabs button {
  flex: 1;
  padding: 7px 0;
  border: 0;
  border-radius: calc(var(--radius-sm) - 2px);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 13.5px;
  cursor: pointer;
}
.login-tabs button.active {
  background: var(--background);
  color: var(--foreground);
  font-weight: 500;
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

.login-hint {
  margin: 7px 0 0;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.5;
}

.login-notice {
  margin-bottom: 14px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--brand-accent) 10%, transparent);
  color: var(--foreground);
  font-size: 13px;
  line-height: 1.5;
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

.login-foot {
  display: flex;
  justify-content: space-between;
  margin-top: 14px;
}
.login-link {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--brand-accent);
  font-size: 13px;
  cursor: pointer;
}
.login-link:disabled {
  color: var(--muted-foreground);
  cursor: not-allowed;
}
</style>
