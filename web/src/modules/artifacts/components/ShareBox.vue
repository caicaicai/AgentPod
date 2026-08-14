<script setup>
import { computed, ref, watch } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import { copyToClipboard } from '@/lib/debug-bundle.js'
import { shareUrl } from '@/lib/route.js'
import { askConfirm } from '@/lib/dialog.js'
import {
  setArtifactMarket, shareArtifact, state, unshareArtifact,
} from '@/stores/app.js'

/**
 * 分享面板：把一份作品变成一条链接，以及决定要不要把它挂到市场上。
 *
 * ── 为什么是两步，而不是一个开关 ────────────────────────────────────────
 *
 * "私发一条链接给同事"和"我愿意让所有人看见"，中间隔着一个人的意愿。
 * 合成一个开关的话，前者会静悄悄地变成后者 —— 而用户直到某天在广场上
 * 刷到自己那份还没做完的东西，才知道发生过什么。
 *
 * 所以这块面板刻意分成上下两段：上面是链接（点了就有），下面是市场
 * （**默认关着**，要单独勾）。两段之间有一条分隔线，不是装饰。
 */
const props = defineProps({
  meta: { type: Object, required: true },
})
defineEmits(['close'])

const share = computed(() => props.meta?.share || null)
const url = computed(() => (share.value ? shareUrl(share.value.token) : ''))

const copied = ref(false)
async function copy() {
  copied.value = await copyToClipboard(url.value)
  setTimeout(() => { copied.value = false }, 1600)
}

/**
 * 简介是本地草稿，**不随打字往服务端写**。
 *
 * 每敲一个字发一次 PATCH 的话，网络一慢就会出现"后发的先到"，
 * 于是输入框里的字和存下来的对不上 —— 而用户完全不知道自己该怎么补救。
 * 所以是显式保存：失焦或按回车时提交一次。
 */
const summary = ref('')
watch(share, (next) => { summary.value = next?.summary || '' }, { immediate: true })
const summaryDirty = computed(() => summary.value.trim() !== (share.value?.summary || ''))

async function onShare() {
  await shareArtifact(props.meta.id)
}

async function onToggleMarket(event) {
  const market = event.target.checked
  const ok = await setArtifactMarket(props.meta.id, { market, summary: summary.value })
  // 服务端拒了（比如市场关掉了）就把勾拨回去 —— 让一个没生效的勾停在选中态，
  // 等于告诉用户"已经发布了"
  if (!ok) event.target.checked = !market
}

function saveSummary() {
  if (!summaryDirty.value || !share.value?.market) return
  setArtifactMarket(props.meta.id, { summary: summary.value })
}

async function onUnshare() {
  const ok = await askConfirm({
    title: '撤销分享',
    message: '已经发出去的链接会立刻失效，别人再打开只会看到"链接不存在"。重新分享会得到一条新的地址。',
    confirmText: '撤销',
    danger: true,
  })
  if (ok) await unshareArtifact(props.meta.id)
}
</script>

<template>
  <section class="sharebox">
    <header class="sb-head">
      <AppIcon name="link" :size="14" />
      <h3>分享</h3>
      <button type="button" class="chip-x" title="收起" @click="$emit('close')">
        <AppIcon name="x" :size="12" />
      </button>
    </header>

    <!-- ── 还没分享：一句说清代价，一个按钮 ── -->
    <template v-if="!share">
      <p class="sb-lead">
        生成一条链接，<strong>任何拿到它的人都不需要登录</strong>就能打开这份作品，
        看到的始终是最新版。链接可以随时撤销。
      </p>
      <button type="button" class="primary-btn" :disabled="state.shareBusy" @click="onShare">
        <AppIcon name="link" :size="14" />{{ state.shareBusy ? '正在生成…' : '生成分享链接' }}
      </button>
    </template>

    <template v-else>
      <div class="sb-url">
        <input :value="url" readonly spellcheck="false" @focus="$event.target.select()" />
        <button type="button" class="primary-btn" :title="copied ? '已复制' : '复制链接'" @click="copy">
          <AppIcon :name="copied ? 'check' : 'copy'" :size="13" />{{ copied ? '已复制' : '复制' }}
        </button>
      </div>
      <p class="sb-stat">
        <AppIcon name="eye" :size="12" />已被打开 {{ share.views || 0 }} 次
        <a :href="url" target="_blank" rel="noopener">预览访客看到的样子</a>
      </p>

      <!-- ── 第二段：上不上广场，是另一个决定 ── -->
      <div v-if="state.features.artifactMarket" class="sb-market">
        <label class="sb-check">
          <input type="checkbox" :checked="share.market" :disabled="state.shareBusy" @change="onToggleMarket" />
          <span>
            发布到作品市场
            <em>所有人都能在广场上翻到它，不只是拿到链接的人。</em>
          </span>
        </label>
        <template v-if="share.market">
          <input
            v-model="summary"
            class="sb-summary"
            type="text"
            maxlength="140"
            placeholder="一句话简介，会显示在市场的卡片上"
            @blur="saveSummary"
            @keydown.enter="saveSummary"
          />
          <span v-if="summaryDirty" class="sb-hint">回车或点别处保存</span>
        </template>
      </div>

      <button type="button" class="sb-revoke" :disabled="state.shareBusy" @click="onUnshare">
        <AppIcon name="link-off" :size="13" />撤销分享，让链接失效
      </button>
    </template>

    <p v-if="state.shareNote" class="sb-note">{{ state.shareNote }}</p>
  </section>
</template>

<style scoped>
.sharebox {
  display: flex;
  flex-direction: column;
  gap: 9px;
  flex: 0 0 auto;
  padding: 12px 13px;
  border: 1px solid color-mix(in srgb, var(--brand-accent) 34%, var(--border));
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--brand-accent) 5%, var(--background));
}

.sb-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--brand-accent);
}
.sb-head h3 {
  margin: 0;
  color: var(--foreground);
  font-size: 13px;
  font-weight: 600;
}
.chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: auto;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}
.chip-x:hover {
  background: var(--secondary);
  color: var(--foreground);
}

.sb-lead {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.7;
}
.sb-lead strong {
  color: var(--foreground);
  font-weight: 600;
}

.sharebox .primary-btn {
  align-self: flex-start;
  padding: 6px 12px;
  font-size: 12.5px;
}

.sb-url {
  display: flex;
  gap: 6px;
}
.sb-url input {
  flex: 1;
  min-width: 0;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.sb-url .primary-btn {
  align-self: auto;
  flex: 0 0 auto;
}

.sb-stat {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--muted-foreground);
  font-size: 11.5px;
}
.sb-stat a {
  margin-left: auto;
  color: var(--brand-accent);
}

/* 分隔线不是装饰：上面是"给谁看"，下面是"要不要公开"，两个决定 */
.sb-market {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-top: 9px;
  border-top: 1px solid var(--border);
}
.sb-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12.5px;
  cursor: pointer;
}
.sb-check input {
  margin-top: 2px;
  flex: 0 0 auto;
  accent-color: var(--brand-accent);
}
.sb-check em {
  display: block;
  margin-top: 2px;
  color: var(--muted-foreground);
  font-size: 11.5px;
  font-style: normal;
  line-height: 1.6;
}

.sb-summary {
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-size: 12.5px;
}
.sb-summary:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--brand-accent) 50%, var(--border));
}
.sb-hint {
  color: var(--muted-foreground);
  font-size: 11px;
}

.sb-revoke {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 4px 0;
  border: 0;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12px;
  cursor: pointer;
}
.sb-revoke:hover {
  color: var(--destructive);
}

.sb-note {
  margin: 0;
  color: var(--warning);
  font-size: 12px;
}
</style>
