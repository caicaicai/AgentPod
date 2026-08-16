<script setup>
import { computed, ref } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import ArtifactCard from '@/modules/artifacts/components/ArtifactCard.vue'
import PlanCard from './PlanCard.vue'
import ToolCard from './ToolCard.vue'
import { copyToClipboard } from '@/lib/debug-bundle.js'
import { formatClock } from '@/lib/format.js'
import { renderMarkdown } from '@/lib/markdown.js'
import { layoutBlocks } from '../tools.js'

const props = defineProps({
  turn: { type: Object, required: true },
})
const emit = defineEmits(['preview'])

const items = computed(() => layoutBlocks(props.turn.blocks))
const hasText = computed(() => props.turn.blocks.some((block) => block.type === 'text' && block.text))

/** 思考过程默认收起：它是给"想知道它为什么这么答"的人看的，不是正文 */
const thinkingOpen = ref(new Set())
function toggleThinking(key) {
  const next = new Set(thinkingOpen.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  thinkingOpen.value = next
}

const copied = ref(false)
async function copy() {
  const text = props.turn.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
  copied.value = await copyToClipboard(text)
  setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <article class="message-row assistant-row">
    <div class="assistant-head">
      <span class="assistant-avatar"><AppIcon name="sparkle" :size="12" filled /></span>
      <span class="assistant-name">智能助手</span>
      <span v-if="props.turn.meta" class="assistant-stats">{{ props.turn.meta }}</span>
    </div>

    <div class="assistant-body">
      <template v-for="item in items" :key="item.key">
        <div v-if="item.kind === 'thinking'" class="thinking">
          <button type="button" class="thinking-head" @click="toggleThinking(item.key)">
            <AppIcon :name="thinkingOpen.has(item.key) ? 'chevron-down' : 'chevron-right'" :size="13" />
            思考过程
          </button>
          <div v-if="thinkingOpen.has(item.key)" class="thinking-text">{{ item.block.text }}</div>
        </div>

        <!-- eslint-disable-next-line vue/no-v-html -- 内容经 renderMarkdown 先整体转义再变换，见 markdown.js -->
        <div v-else-if="item.kind === 'text'" class="md" v-html="renderMarkdown(item.block.text)" />

        <PlanCard v-else-if="item.kind === 'plan'" :plan="item.plan" />

        <ArtifactCard v-else-if="item.kind === 'artifact'" :card="item.card" />

        <ToolCard
          v-else-if="item.kind === 'tool'"
          :block="item.block"
          @preview="(url) => emit('preview', url)"
        />
      </template>

      <!--
        重试期间盖掉普通的等待提示：这十几秒里"正在思考…"是**假话**，
        真实情况是模型调用失败了、正在退避等待重发。
      -->
      <!--
        断线重连要排在最前面：这时候连"模型调用失败"都不成立 —— 我们根本
        不知道那边怎么样了，只知道自己这条连接断了。而服务端那一轮**还在跑**，
        所以不能显示成失败，那会让用户以为白花了一次。
      -->
      <div v-if="!props.turn.done && props.turn.reconnecting" class="waiting">
        <span class="spinner" />
        连接已断开，正在重连（第 {{ props.turn.reconnecting.attempt }}/{{ props.turn.reconnecting.max }} 次）…
        <span class="hint">这一轮仍在服务端继续，接回来就能看到</span>
      </div>
      <div v-else-if="!props.turn.done && props.turn.retry" class="waiting">
        <span class="spinner" />
        模型调用失败，{{ Math.round(props.turn.retry.delayMs / 1000) }} 秒后重试（第
        {{ props.turn.retry.attempt }}/{{ props.turn.retry.maxAttempts }} 次）…
      </div>
      <!--
        正在压缩上下文。排在"正在思考"之前，因为这段等待有具体的原因，
        而"正在思考…"会让十几秒的沉默看起来像是卡住了。

        overflow 与另外两种分开说：那意味着这条会话已经顶到上下文上限了，
        用户该知道的不只是"稍等"，而是"这条会话该收尾了"。
      -->
      <div v-else-if="!props.turn.done && props.turn.compacting" class="waiting">
        <span class="spinner" />
        <template v-if="props.turn.compacting.reason === 'overflow'">
          上下文已经满了，正在压缩后重试…
          <span class="hint">这条会话很长了，开一条新的会更快</span>
        </template>
        <template v-else>
          正在压缩上下文（把前面的对话折成摘要）…
          <span class="hint">要另外调一次模型，可能要十几秒</span>
        </template>
      </div>
      <div v-else-if="!props.turn.done && !props.turn.blocks.length" class="waiting">
        <span class="spinner" />正在思考…
      </div>
      <div v-else-if="!props.turn.done && !hasText" class="waiting">
        <span class="spinner" />正在生成回复…
      </div>

      <div v-if="props.turn.retriedCount" class="retry-note">
        本轮重试过 {{ props.turn.retriedCount }} 次（模型服务不稳定）
      </div>
      <!--
        压缩发生过就留一句。这不是提示"出了问题"，是在解释两件用户一定会注意到的事：
        这一轮为什么慢，以及**为什么模型对前面聊过的细节记不清了** —— 摘要是有损的。
        不写出来的话，后者会被归因成"这个模型变笨了"。
      -->
      <div v-if="props.turn.compactedCount" class="retry-note">
        本轮压缩过 {{ props.turn.compactedCount }} 次上下文 —— 更早的对话已折成摘要，细节可能丢失
      </div>
      <div v-if="props.turn.warning" class="notice warn">
        <AppIcon name="alert" :size="14" /><span>{{ props.turn.warning }}</span>
      </div>
      <div v-if="props.turn.error" class="notice error">
        <AppIcon name="alert" :size="14" />
        <span>
          {{ props.turn.error }}
          <em v-if="props.turn.requestId">requestId: {{ props.turn.requestId }}</em>
        </span>
      </div>
    </div>

    <div class="message-meta">
      <button type="button" class="msg-copy" :title="copied ? '已复制' : '复制回复'" @click="copy">
        <AppIcon :name="copied ? 'check' : 'copy'" :size="13" />
      </button>
      <span v-if="props.turn.timestamp" class="message-time">{{ formatClock(props.turn.timestamp) }}</span>
    </div>
  </article>
</template>

<style scoped>
.message-row {
  position: relative;
  padding-bottom: 20px;
}

.assistant-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
}
.assistant-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 6px;
  background: var(--brand-accent);
  color: #fff;
}
.assistant-name {
  color: var(--foreground);
  font-size: 13px;
  font-weight: 600;
}
.assistant-stats {
  color: var(--muted-foreground);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.assistant-body {
  min-width: 0;
  color: var(--foreground);
}

.thinking {
  margin: 8px 0;
  padding-left: 10px;
  border-left: 2px solid var(--border);
}
.thinking-head {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.thinking-head:hover {
  color: var(--foreground);
}
.thinking-text {
  margin-top: 4px;
  color: var(--muted-foreground);
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  color: var(--muted-foreground);
  font-size: 13.5px;
}
/* 重连提示里那句"这一轮仍在服务端继续" —— 比主句轻一档，它是安慰不是状态 */
.waiting .hint {
  opacity: 0.7;
  font-size: 12px;
}
.retry-note {
  margin-top: 6px;
  color: var(--muted-foreground);
  font-size: 12px;
}

.notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  line-height: 1.6;
}
.notice.warn {
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  color: var(--warning);
}
.notice.error {
  background: color-mix(in srgb, var(--destructive) 12%, transparent);
  color: var(--destructive);
}
.notice em {
  display: block;
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-style: normal;
  opacity: 0.85;
}

.message-meta {
  position: absolute;
  left: -2px;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 18px;
  color: var(--muted-foreground);
  font-size: 11px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.message-row:hover .message-meta,
.message-meta:focus-within {
  opacity: 1;
  pointer-events: auto;
}
@media (hover: none) {
  .message-meta {
    opacity: 1;
    pointer-events: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .message-meta {
    transition: none;
  }
}
.message-time {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.msg-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}
.msg-copy:hover {
  background: var(--secondary);
  color: var(--foreground);
}
</style>
