<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import AppIcon from './AppIcon.vue'
import ElementChip from './ElementChip.vue'
import FileChips from './FileChips.vue'
import { LARGE_PASTE_CHARS, MAX_FILES, readAll, textToAttachment } from '../lib/attachments.js'
import { currentProject, saveDraft, send, state, stop } from '../stores/app.js'

const emit = defineEmits(['preview', 'open-file'])

const textarea = ref(null)
const fileInput = ref(null)
const dragging = ref(false)
const busy = ref(false)
/** 拖拽会在子元素上不断触发 enter/leave，靠计数而不是布尔值才不会闪 */
let dragDepth = 0

const running = computed(() => Boolean(state.live))
const project = computed(() => currentProject())
const canSend = computed(() => Boolean(state.draft.trim() || state.attachments.length))

/**
 * chip 上那行说明。
 *
 * 刻意**不**把 id 摆出来：`a_b41df2cb075f` 对人没有任何意义，它是给模型认的，
 * 拼进正文里就够了。人要看的是"哪份作品的哪个元素"。
 */
const contextInfo = computed(() => {
  const context = state.composerContext
  if (!context) return ''
  return [`作品「${context.meta.title}」`, context.pick.selector].filter(Boolean).join(' · ')
})

/* ═══════════════ 高度自适应 ═══════════════ */

function resize() {
  const node = textarea.value
  if (!node) return
  node.style.height = 'auto'
  const capped = Math.min(node.scrollHeight, 200)
  node.style.height = `${capped}px`
  // 到顶之前不出滚动条：一个刚好装得下内容的输入框不该画一根没用的轨道
  node.style.overflowY = node.scrollHeight > 200 ? 'auto' : 'hidden'
}

onMounted(() => {
  resize()
  textarea.value?.focus()
})
// 发送后 draft 被清空、切会话后草稿被换掉，两种情况都要重新量一次高度
watch(() => state.draft, () => nextTick(resize))
watch(() => state.activeKey, () => nextTick(() => { resize(); textarea.value?.focus() }))

/* ═══════════════ 斜杠命令 ═══════════════ */

/**
 * 输入框里打 `/` 弹出的快捷指令。
 *
 * 它们**不是新增能力**，只是把已有能力说出口：用户不会凭空想到"可以让它记住我的偏好"
 * 或"可以说每天九点"。选中后插入的是一句自然语言，而不是什么特殊语法 ——
 * 所以用户可以接着改，模型看到的也只是普通的一句话。
 */
const SLASH_COMMANDS = [
  { key: '/记住', hint: '让助手记住一件事', text: '记住：' },
  { key: '/忘记', hint: '让助手忘掉一条记忆', text: '忘掉你记住的这条：' },
  { key: '/定时', hint: '建一个定时任务', text: '以后每天 9:00 帮我：' },
  { key: '/任务', hint: '看看我有哪些定时任务', text: '看看我现在有哪些定时任务，下次什么时候跑？' },
  { key: '/技能', hint: '打开技能面板', panel: 'skills' },
]

const slashItems = computed(() => {
  const value = state.draft
  // 只在输入框**以 / 开头**时弹：正文中间的斜杠（路径、日期）不该触发
  if (!value.startsWith('/') || value.includes('\n')) return []
  const filter = value.trim()
  return SLASH_COMMANDS.filter((command) => command.key.includes(filter))
})
const slashOpen = ref(true)

watch(() => state.draft, () => { slashOpen.value = true })

function applySlash(command) {
  slashOpen.value = false
  if (command.panel) {
    state.draft = ''
    state.panel = command.panel
    return
  }
  state.draft = command.text
  nextTick(() => {
    resize()
    const node = textarea.value
    node?.focus()
    // 光标落到末尾，用户接着往下写
    node?.setSelectionRange(node.value.length, node.value.length)
  })
}

/* ═══════════════ 附件 ═══════════════ */

async function addFiles(files) {
  if (!files.length || busy.value) return
  busy.value = true
  state.composerError = ''
  try {
    const { attachments, errors } = await readAll(files, { existing: state.attachments })
    if (attachments.length) state.attachments = [...state.attachments, ...attachments]
    if (errors.length) state.composerError = errors.join('；')
  } finally {
    busy.value = false
    saveDraft()
  }
}

function onPick(event) {
  const files = Array.from(event.target.files ?? [])
  event.target.value = '' // 同一个文件再选一次也要能触发 change
  addFiles(files)
}

function removeAttachment(file) {
  state.attachments = state.attachments.filter((item) => item.id !== file.id)
  saveDraft()
}

/**
 * 粘贴。
 *
 * 两件事：剪贴板里有文件（截图）就当附件收下；一大段纯文本也转成附件 ——
 * 贴两千行日志进输入框，输入框会撑成一堵墙，用户想在后面补一句"这报错什么意思"
 * 都找不到光标。转成附件之后输入框还是干净的，内容一个字没少。
 */
async function onPaste(event) {
  const data = event.clipboardData
  if (!data) return
  const files = Array.from(data.files ?? [])
  if (files.length) {
    event.preventDefault()
    await addFiles(files)
    return
  }
  const text = data.getData('text/plain')
  if (!text || text.length <= LARGE_PASTE_CHARS) return
  if (state.attachments.length >= MAX_FILES) return
  event.preventDefault()
  state.attachments = [
    ...state.attachments,
    textToAttachment(text, state.attachments.map((file) => file.name)),
  ]
  saveDraft()
}

function dragHasFiles(event) {
  const types = event.dataTransfer?.types
  return types ? Array.from(types).includes('Files') : false
}
function onDragEnter(event) {
  if (!dragHasFiles(event)) return
  event.preventDefault()
  dragDepth += 1
  dragging.value = true
}
function onDragOver(event) {
  if (!dragHasFiles(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}
function onDragLeave(event) {
  if (!dragHasFiles(event)) return
  event.preventDefault()
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}
async function onDrop(event) {
  if (!dragHasFiles(event)) return
  event.preventDefault()
  dragDepth = 0
  dragging.value = false
  await addFiles(Array.from(event.dataTransfer?.files ?? []))
}

/* ═══════════════ 键盘 ═══════════════ */

function onKeydown(event) {
  // 斜杠菜单开着时，Enter 选中第一项而不是发送 —— 否则 "/记住" 会被当成消息发出去
  if (slashOpen.value && slashItems.value.length && (event.key === 'Enter' || event.key === 'Tab') && !event.isComposing) {
    event.preventDefault()
    applySlash(slashItems.value[0])
    return
  }
  if (event.key === 'Escape' && slashOpen.value && slashItems.value.length) {
    slashOpen.value = false
    // 这里不 stopPropagation 之外还得挡住全局那层：否则一个 Esc 会顺手把面板也关了
    event.stopPropagation()
    return
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    send()
  }
}

function onInput() {
  resize()
  saveDraft()
}
</script>

<template>
  <div class="composer-wrap">
    <div
      class="composer"
      :class="{ dragging }"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <!-- 斜杠命令面板。位置在输入框上方，跟随输入实时过滤 -->
      <div v-if="slashOpen && slashItems.length" class="slash-menu">
        <button
          v-for="command in slashItems"
          :key="command.key"
          type="button"
          class="slash-item"
          @click="applySlash(command)"
        >
          <span class="slash-key">{{ command.key }}</span>
          <span class="slash-hint">{{ command.hint }}</span>
        </button>
      </div>

      <!--
        引用的元素排在附件之上：它决定"改哪儿"，比"带了什么文件"更该先看到。
      -->
      <ElementChip
        v-if="state.composerContext"
        :element="{ label: state.composerContext.pick.label, info: contextInfo, html: state.composerContext.pick.html }"
        removable
        @remove="state.composerContext = null"
      />

      <FileChips
        :files="state.attachments"
        removable
        @remove="removeAttachment"
        @preview="(url) => emit('preview', url)"
        @open="(file) => emit('open-file', file)"
      />

      <textarea
        ref="textarea"
        v-model="state.draft"
        rows="1"
        class="composer-input"
        :placeholder="state.composerContext
          ? '说说这一处要怎么改 —— 只有选中的那个元素会被改动'
          : '给智能助手发消息 —— Enter 发送，Shift+Enter 换行，输入 / 看可用指令，也可以直接把文件拖进来'"
        @input="onInput"
        @keydown="onKeydown"
        @paste="onPaste"
      />

      <p v-if="state.composerError" class="composer-error">{{ state.composerError }}</p>

      <div class="composer-toolbar">
        <div class="composer-left">
          <button
            type="button"
            class="icon-btn"
            :disabled="busy || state.attachments.length >= MAX_FILES"
            :title="state.attachments.length >= MAX_FILES ? `最多 ${MAX_FILES} 个附件` : '添加附件（也可以拖进来或直接粘贴）'"
            @click="fileInput?.click()"
          >
            <AppIcon name="paperclip" :size="17" />
          </button>
          <span v-if="busy" class="composer-note"><span class="spinner" />正在读取附件…</span>
          <!-- 输入框下面这行「当前在哪个项目里」。没有它，项目指令是隐形生效的 -->
          <span v-else-if="project" class="composer-scope" :title="project.instructions || ''">
            <AppIcon name="folder" :size="13" />{{ project.name }}
          </span>
        </div>

        <div class="composer-right">
          <span v-if="running" class="composer-note">正在执行，可随时停止（Esc）</span>
          <button v-if="running" type="button" class="stop-btn" title="停止" @click="stop">
            <AppIcon name="stop" :size="14" filled />
          </button>
          <button
            v-else
            type="button"
            class="send-btn"
            :disabled="!canSend"
            title="发送（Enter）"
            @click="send"
          >
            <AppIcon name="arrow-up" :size="17" />
          </button>
        </div>
      </div>

      <!-- 拖拽提示铺满整个输入区：拖到哪儿都行，别让人去找一个小小的投放框 -->
      <div v-if="dragging" class="drop-overlay">
        <AppIcon name="paperclip" :size="18" />
        <span>松手即可添加附件</span>
      </div>
    </div>

    <input ref="fileInput" type="file" class="file-input" multiple @change="onPick" />
  </div>
</template>

<style scoped>
.composer-wrap {
  width: min(var(--content-w), calc(100% - 32px));
  margin: 0 auto 18px;
}
.composer {
  position: relative;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 24px;
  background: var(--background);
  box-shadow:
    0 1px 2px color-mix(in srgb, var(--foreground) 8%, transparent),
    0 12px 28px color-mix(in srgb, var(--foreground) 7%, transparent);
  transition: border-color 0.12s ease;
}
.composer:focus-within {
  border-color: color-mix(in srgb, var(--brand-accent) 40%, var(--border));
}
.composer.dragging {
  border-color: var(--brand-accent);
}

.composer-input {
  width: 100%;
  min-height: 46px;
  max-height: 200px;
  padding: 3px 4px 8px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--foreground);
  font: inherit;
  font-size: 15px;
  line-height: 1.5;
  overflow-y: hidden;
  resize: none;
}
.composer-input::placeholder {
  color: var(--muted-foreground);
}

.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.composer-left,
.composer-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.composer-note,
.composer-scope {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.composer-error {
  margin: 6px 2px 8px;
  color: var(--destructive);
  font-size: 12px;
  line-height: 1.55;
}

.send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 50%;
  background: var(--foreground);
  color: var(--background);
  cursor: pointer;
  transition: opacity 0.12s ease;
}
.send-btn:hover:not(:disabled) {
  opacity: 0.88;
}
.send-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.stop-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--background);
  color: var(--foreground);
  cursor: pointer;
}
.stop-btn:hover {
  background: var(--secondary);
}

.slash-menu {
  display: flex;
  flex-direction: column;
  margin-bottom: 8px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--background);
  box-shadow: 0 10px 26px color-mix(in srgb, var(--foreground) 12%, transparent);
}
.slash-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.slash-item:hover,
.slash-item:first-child {
  background: var(--secondary);
}
.slash-key {
  flex: 0 0 auto;
  color: var(--foreground);
  font-size: 13px;
  font-weight: 600;
}
.slash-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  border: 1.5px dashed var(--brand-accent);
  border-radius: 24px;
  background: color-mix(in srgb, var(--background) 88%, var(--brand-accent));
  color: var(--brand-accent);
  font-size: 13.5px;
  font-weight: 500;
  /* 覆盖层自己不接鼠标事件，否则 dragleave 会在它出现的瞬间触发，闪个不停 */
  pointer-events: none;
}

.file-input {
  display: none;
}
</style>
