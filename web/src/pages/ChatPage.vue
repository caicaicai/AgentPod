<script setup>
import { computed, nextTick, ref, watch } from 'vue'

import AppIcon from './AppIcon.vue'
import AssistantMessage from './AssistantMessage.vue'
import ChatComposer from './ChatComposer.vue'
import FilePreview from './FilePreview.vue'
import UserMessage from './UserMessage.vue'
import { buildDebugBundle, copyToClipboard } from '../lib/debug-bundle.js'
import { getRecentEvents, getStreamTrace } from '../lib/api.js'
import {
  clearActiveSession, currentSession, hideBanner, setModel, state, threadTitle, togglePanel,
} from '../stores/app.js'
import { askConfirm } from '../lib/dialog.js'

const scroller = ref(null)
const previewFile = ref(null)
const copiedDebug = ref(false)

const turns = computed(() => (state.live ? [...state.turns, state.live] : state.turns))

const HERO_SAMPLES = [
  { icon: 'book', title: '总结最近会议', prompt: '帮我总结本周的会议纪要，按项目分组列出结论和待办。' },
  { icon: 'file', title: '梳理今天的邮件', prompt: '帮我梳理一下今天的邮件，哪些需要我处理？' },
  { icon: 'terminal', title: '跑个命令看看', prompt: '在沙盒里执行 `uname -a` 和 `python3 -V`，把结果告诉我。' },
]

/* ═══════════════ 滚动跟随 ═══════════════ */

/** 只有用户本来就贴着底部时才自动跟随，否则不打断他往上翻历史 */
function pinnedToBottom() {
  const node = scroller.value
  if (!node) return true
  return node.scrollHeight - node.scrollTop - node.clientHeight < 80
}

function scrollToBottom() {
  const node = scroller.value
  if (node) node.scrollTop = node.scrollHeight
}

/**
 * 流式期间内容一直在长。这里在 DOM 更新**之前**记下"当时是不是贴着底"，
 * 更新之后再决定要不要跟 —— 顺序反了的话，新内容一进来高度就变了，
 * 任何时候量出来都像是"用户已经不在底部了"，于是永远不跟随。
 */
watch(
  () => [turns.value.length, state.live?.blocks.length, JSON.stringify(state.live?.blocks.map((b) => b.text?.length ?? b.status))],
  () => {
    const pinned = pinnedToBottom()
    nextTick(() => { if (pinned) scrollToBottom() })
  },
)
// 换会话就直接落到底：那是"回到上次聊到哪儿"的位置
watch(() => state.activeKey, () => nextTick(scrollToBottom))
watch(() => state.loadingSession, (loading) => { if (!loading) nextTick(scrollToBottom) })

/* ═══════════════ 顶栏动作 ═══════════════ */

/**
 * 攒一份调试信息并复制走。
 *
 * 内容与"里面绝不放什么"见 debug-bundle.js 开头。这里只管三件事：
 * 把界面上的状态交出去、复制、以及**复制不了时别让按钮哑掉**。
 */
async function copyDebug() {
  const text = buildDebugBundle({
    health: state.health,
    turns: state.turns,
    live: state.live,
    events: getRecentEvents(),
    // 每帧的到达时刻。"卡顿"类反馈只有靠它才能分开"上游在憋"和"帧到了没画出来"
    streamTrace: getStreamTrace(),
    sessionKey: state.activeKey,
    modelId: state.modelId,
    skills: state.skills,
    skillsUsable: state.skillsUsable,
  })

  if (await copyToClipboard(text)) {
    copiedDebug.value = true
    setTimeout(() => { copiedDebug.value = false }, 2000)
    return
  }

  // http 下 navigator.clipboard 不存在，execCommand 也可能被策略挡掉 ——
  // 摊开让人手动复制，总好过点了没反应。
  state.debugText = text
  state.debugNote = '浏览器不让脚本写剪贴板（http 页面常见）。全选下面的内容手动复制：'
  state.panel = 'debug'
}

async function onClear() {
  const ok = await askConfirm({
    title: '清空会话',
    message: '当前会话的全部历史都会被删掉，此操作不可恢复。',
    confirmText: '清空',
    danger: true,
  })
  if (ok) await clearActiveSession()
}

function useSample(sample) {
  state.draft = sample.prompt
}
</script>

<template>
  <main class="thread">
    <header class="thread-head">
      <button
        v-if="state.sidebarCollapsed"
        type="button"
        class="icon-btn"
        title="展开会话列表"
        @click="state.sidebarCollapsed = false"
      >
        <AppIcon name="panel-open" :size="17" />
      </button>

      <h1 class="thread-title">{{ threadTitle() }}</h1>

      <div class="thread-actions">
        <!--
          有作品才出现这个按钮。作品是"这次对话产出了东西"的信号，
          常驻一个永远是 0 的入口只会让人以为功能坏了。
        -->
        <button
          v-if="state.features.artifacts && state.artifacts.length"
          type="button"
          class="ghost-btn"
          :class="{ on: state.panel === 'artifact' }"
          title="本次对话产出的作品"
          @click="togglePanel('artifact')"
        >
          <AppIcon name="app-window" :size="14" />
          作品 {{ state.artifacts.length }}
        </button>

        <div v-if="state.models.length" class="select-wrap">
          <select :value="state.modelId" title="选择模型" @change="setModel($event.target.value)">
            <!--
              有管理员起的名字就显示名字（LLM_MODE=db 那条路上才有），否则显示模型 id。
              `title` 里始终是 id：换模型排查问题时要报的是 id，不是"生产 Claude"。
            -->
            <option v-for="model in state.models" :key="model.id" :value="model.id" :title="model.id">
              {{ model.name || model.id }}
            </option>
          </select>
          <AppIcon name="chevron-down" :size="13" class="select-caret" />
        </div>

        <button
          type="button"
          class="ghost-btn"
          title="复制本次会话的调试信息（环境、对话、工具调用、失败请求），用于排查问题。不含任何凭据"
          @click="copyDebug"
        >
          <AppIcon :name="copiedDebug ? 'check' : 'copy'" :size="14" />
          {{ copiedDebug ? '已复制' : '调试信息' }}
        </button>

        <button
          type="button"
          class="ghost-btn"
          :disabled="!currentSession()"
          title="删除当前会话的全部历史"
          @click="onClear"
        >
          <AppIcon name="trash" :size="14" />清空
        </button>
      </div>
    </header>

    <div v-if="state.banner" class="banner">
      <AppIcon name="alert" :size="15" />
      <span>{{ state.banner }}</span>
      <button type="button" class="chip-x" title="关闭" @click="hideBanner">
        <AppIcon name="x" :size="13" />
      </button>
    </div>

    <div ref="scroller" class="messages">
      <div v-if="state.loadingSession" class="loading-hint">
        <span class="spinner" />正在载入这条会话…
      </div>

      <div v-else-if="!turns.length" class="hero">
        <div class="hero-logo"><AppIcon name="sparkle" :size="26" filled /></div>
        <h2>有什么可以帮你？</h2>
        <p>会话、技能与沙盒执行都在服务端，换台设备打开还是这些对话。</p>
        <div class="hero-grid">
          <button
            v-for="sample in HERO_SAMPLES"
            :key="sample.title"
            type="button"
            class="hero-card"
            @click="useSample(sample)"
          >
            <span class="hero-card-head"><AppIcon :name="sample.icon" :size="15" />{{ sample.title }}</span>
            <span class="hero-card-body">{{ sample.prompt }}</span>
          </button>
        </div>
      </div>

      <div v-else class="messages-inner">
        <template v-for="(turn, index) in turns" :key="index">
          <UserMessage
            v-if="turn.role === 'user'"
            :turn="turn"
            @preview="state.lightbox = $event"
            @open-file="previewFile = $event"
          />
          <AssistantMessage v-else :turn="turn" @preview="state.lightbox = $event" />
        </template>
      </div>
    </div>

    <ChatComposer @preview="state.lightbox = $event" @open-file="previewFile = $event" />

    <FilePreview v-if="previewFile" :file="previewFile" @close="previewFile = null" />
  </main>
</template>

<style scoped>
.thread {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: var(--background);
}

.thread-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  /* 高度走 --head-h，与右侧抽屉的头部共用，两条底线才对得上（见 tokens.css） */
  height: var(--head-h);
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}
.thread-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: 14.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.thread-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
}

.select-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.select-wrap select {
  max-width: 220px;
  padding: 6px 24px 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 13px;
  cursor: pointer;
  appearance: none;
}
.select-wrap select:hover {
  background: var(--secondary);
  color: var(--foreground);
}
.select-caret {
  position: absolute;
  right: 7px;
  color: var(--muted-foreground);
  pointer-events: none;
}

/* 面板开着时按钮保持高亮，否则看不出这个抽屉是谁打开的 */
.ghost-btn.on {
  border-color: color-mix(in srgb, var(--brand-accent) 45%, var(--border));
  color: var(--brand-accent);
}

.banner {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 0 0 auto;
  padding: 9px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--warning) 30%, var(--border));
  background: color-mix(in srgb, var(--warning) 12%, var(--background));
  color: var(--warning);
  font-size: 13px;
}
.banner span {
  flex: 1;
  min-width: 0;
}

.messages {
  flex: 1;
  min-height: 0;
  padding: 20px 0 8px;
  overflow-y: auto;
  overflow-x: hidden;
  /* 流式追加内容时不要让浏览器把滚动"锚"回原位，我们自己管跟随 */
  overflow-anchor: none;
}
.messages-inner {
  width: min(var(--content-w), calc(100% - 32px));
  margin: 0 auto;
}

.loading-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 60px 0;
  color: var(--muted-foreground);
  font-size: 13.5px;
}

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: min(var(--content-w), calc(100% - 32px));
  margin: 0 auto;
  padding: clamp(32px, 12vh, 120px) 0 24px;
  text-align: center;
}
.hero-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  margin-bottom: 16px;
  border-radius: 16px;
  background: var(--brand-accent);
  color: #fff;
}
.hero h2 {
  margin: 0 0 8px;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.hero p {
  margin: 0 0 26px;
  max-width: 460px;
  color: var(--muted-foreground);
  font-size: 13.5px;
  line-height: 1.65;
}
.hero-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
  width: 100%;
}
.hero-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 13px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.hero-card:hover {
  background: var(--secondary);
  border-color: color-mix(in srgb, var(--brand-accent) 32%, var(--border));
}
.hero-card-head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--foreground);
  font-size: 13.5px;
  font-weight: 600;
}
.hero-card-body {
  display: -webkit-box;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.6;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

@media (max-width: 760px) {
  .thread-head {
    padding: 0 12px;
  }
  /* 窄屏先砍这两个：模型名和调试按钮都是"知道要用才会用"的东西，
     而标题和清空是每次都要看到的 */
  .thread-actions .select-wrap {
    display: none;
  }
}
</style>
