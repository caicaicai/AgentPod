<script setup>
import { computed, ref } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import SidePanel from '@/components/SidePanel.vue'
import { formatDateTime } from '@/lib/format.js'
import { changePassword, state } from '@/stores/app.js'

/**
 * 我的账号：看看自己是谁，以及改密码。
 *
 * ── 为什么改密码要填两遍新的 ────────────────────────────────────────────
 *
 * 输入框是掩码的，打错一个字自己看不见。而改密码这件事的失败方式很特别：
 * **当场没有任何反应，下次登录才发现进不去** —— 那时候已经没人能靠"回想刚才
 * 打了什么"救回来了（只能找管理员重置）。两遍一致是这里唯一的防线。
 *
 * ── 为什么还要旧密码 ────────────────────────────────────────────────────
 *
 * 服务端要求（见 http/server.js 的 /v1/auth/password）。理由是：令牌可能是从
 * 别人电脑上、从一次共享屏幕里拿到的；只凭令牌就能改密，等于把"临时借用"
 * 变成"永久接管"，而真正的主人连登录都做不到了。
 */
const form = ref({ oldPassword: '', newPassword: '', confirm: '' })

const mismatch = computed(
  () => Boolean(form.value.confirm) && form.value.newPassword !== form.value.confirm,
)
const canSubmit = computed(() => Boolean(
  form.value.oldPassword && form.value.newPassword && form.value.confirm && !mismatch.value,
))

async function onSubmit() {
  if (!canSubmit.value) return
  const ok = await changePassword(form.value.oldPassword, form.value.newPassword)
  if (ok) form.value = { oldPassword: '', newPassword: '', confirm: '' }
}
</script>

<template>
  <SidePanel title="我的账号">
    <div class="account">
      <dl class="who">
        <div>
          <dt>用户名</dt>
          <dd>{{ state.account?.username || '—' }}</dd>
        </div>
        <div>
          <dt>角色</dt>
          <dd>
            <span v-if="state.account?.role === 'admin'" class="tag admin">管理员</span>
            <span v-else>普通用户</span>
          </dd>
        </div>
        <div v-if="state.account?.createdAt">
          <dt>创建于</dt>
          <dd>{{ formatDateTime(state.account.createdAt) }}</dd>
        </div>
      </dl>

      <form class="form" @submit.prevent="onSubmit">
        <h3>修改密码</h3>
        <label>
          <span>当前密码</span>
          <input v-model="form.oldPassword" type="password" autocomplete="current-password" />
        </label>
        <label>
          <span>新密码</span>
          <input v-model="form.newPassword" type="password" placeholder="至少 8 位" autocomplete="new-password" />
        </label>
        <label>
          <span>再输一遍</span>
          <input v-model="form.confirm" type="password" autocomplete="new-password" />
        </label>
        <p v-if="mismatch" class="note warn">两次输入的新密码不一样</p>

        <button type="submit" class="primary-btn" :disabled="!canSubmit || state.accountBusy">
          <AppIcon name="check" :size="14" />{{ state.accountBusy ? '正在提交…' : '更新密码' }}
        </button>
      </form>

      <p v-if="state.accountNote" class="note" :class="{ warn: state.accountNoteWarn }">
        {{ state.accountNote }}
      </p>
    </div>
  </SidePanel>
</template>

<style scoped>
.account {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.who {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 12px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--secondary) 34%, var(--background));
}
.who > div {
  display: flex;
  gap: 10px;
  font-size: 12.5px;
}
.who dt {
  flex: 0 0 60px;
  color: var(--muted-foreground);
}
.who dd {
  margin: 0;
}
.tag.admin {
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--brand-accent) 16%, transparent);
  color: var(--brand-accent);
  font-size: 11px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.form h3 {
  margin: 0 0 2px;
  font-size: 13px;
  font-weight: 600;
}
.form label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: var(--muted-foreground);
}
.form input {
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-size: 13px;
}
.form input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--brand-accent) 50%, var(--border));
}
.form .primary-btn {
  align-self: flex-start;
  margin-top: 2px;
}

.note {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.65;
}
.note.warn {
  color: var(--warning);
}
</style>
