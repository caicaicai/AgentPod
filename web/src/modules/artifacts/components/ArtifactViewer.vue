<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import AppIcon from './AppIcon.vue'
import ShareBox from './ShareBox.vue'
import { copyToClipboard } from '../lib/debug-bundle.js'
import {
  PREVIEW_SANDBOX, buildPreviewDoc, downloadText, needsFrame, supportsInspect,
} from '../lib/artifact-view.js'
import { detectLanguage, tokenize } from '../lib/highlight.js'
import {
  askAboutElement, clearPick, deleteArtifact, openArtifact, setPick, setPicking, state,
} from '../stores/app.js'
import { askConfirm } from '../lib/dialog.js'

/**
 * 一份作品的正文视图：预览 / 源码 / 版本 / 下载 / 删除。
 *
 * 单独抽出来是因为它有**三个宿主**：对话右边的抽屉、作品库的整页，
 * 以及分享出去之后访客看到的那一页。各写一份的话，"预览异步、切版本、
 * 按文件读源码"这些逻辑就要维护三遍 —— 而它们恰恰是这个功能里最容易出错的部分
 * （见下面那段关于过期结果的说明）。
 *
 * 前两个宿主读全局状态，第三个不能：**访客那一页没有登录态，也就没有 store 里的
 * 那份 artifactDetail**。所以正文可以由 `detail` 传进来，传了就以它为准。
 */
const props = defineProps({
  /** 铺满整页时留白更大、预览更高。抽屉里则要紧凑 */
  roomy: { type: Boolean, default: false },
  /**
   * 外部传进来的正文（`{ meta, version, files }`）。不传则读全局状态。
   * 分享页走这一条 —— 它拿的是免登录接口的结果，跟 store 没有关系。
   */
  detail: { type: Object, default: null },
  /**
   * 只读：藏掉删除、元素拾取、分享这些**作者才有的**动作。
   *
   * 不是"藏起来就安全了"——服务端那几条接口本来就只认登录态里的 username。
   * 藏它是因为给访客画一个点了必然失败的删除按钮，是在骗人。
   */
  readonly: { type: Boolean, default: false },
  /** 只读宿主自己管加载态（store 那份 artifactLoading 与它无关） */
  loading: { type: Boolean, default: false },
})

const tab = ref('preview')
/** 源码页看的是哪个文件。作品是多文件的，这一格才是"读它"的主要入口 */
const activeFile = ref('')

const detail = computed(() => props.detail || state.artifactDetail)
const busy = computed(() => (props.readonly ? props.loading : state.artifactLoading))
const meta = computed(() => detail.value?.meta || null)
const files = computed(() => detail.value?.files || [])
const current = computed(
  () => files.value.find((file) => file.path === activeFile.value) || files.value[0] || null,
)
/** 看的是不是最新版。旧版本要明确说出来，否则用户会以为模型的修改没生效 */
const isOldVersion = computed(() => Boolean(meta.value) && detail.value.version !== meta.value.version)

/* ═══════════════ 预览 ═══════════════ */

const previewHtml = ref('')
const previewError = ref('')
const previewing = ref(false)

/**
 * 预览是**异步**的：Vue 作品要现编译，mermaid 要现渲染，两者的依赖都是按需加载的
 * （加起来好几 MB，不该让没用到的人也付这个首屏成本）。
 *
 * `previewSeq` 是为了丢掉过期的结果：编译一份大点的 Vue 作品要几百毫秒，
 * 这期间用户完全可能已经切到另一份作品上了 —— 不判一下就会看到上一份的画面。
 *
 * 它原来叫 `token`，被隔离契约的静态检查当成"模块级凭据缓存"一直告警
 * （规则按变量名匹配 token/cookie/credential）。那是误报，但**改名比加豁免好**：
 * 在一个满是鉴权 token 的代码库里，管一个自增计数器叫 token 本来就会让人读错。
 * 而一条长期红着的告警会把真正的新违规盖掉。
 */
let previewSeq = 0
async function rebuildPreview() {
  if (!meta.value || !needsFrame(meta.value.kind)) {
    previewHtml.value = ''
    return
  }
  const mine = ++previewSeq
  previewing.value = true
  const result = await buildPreviewDoc({
    kind: meta.value.kind,
    files: files.value,
    entry: meta.value.entry,
    allowedOrigins: state.artifactPreview.allowedOrigins || [],
  })
  if (mine !== previewSeq) return
  previewHtml.value = result.html
  previewError.value = result.error
  previewing.value = false
}

watch(
  () => [meta.value?.id, detail.value?.version].join(':'),
  () => {
    // 换一份（或换一版）就回到预览页、回到入口文件：上一份看的是源码里的某个
    // 文件，不代表下一份也想看那儿，而"停在源码页"会让人以为新的这份没渲染出来
    tab.value = needsFrame(meta.value?.kind) ? 'preview' : 'source'
    activeFile.value = meta.value?.entry || ''
    rebuildPreview()
  },
  { immediate: true },
)

/* ═══════════════ 动作 ═══════════════ */

/** 分享面板开着没有。作品换了就收起来 —— 那块面板说的是上一份的事 */
const shareOpen = ref(false)
const isShared = computed(() => Boolean(meta.value?.share?.token))
watch(() => meta.value?.id, () => { shareOpen.value = false })

const copied = ref(false)
async function copySource() {
  copied.value = await copyToClipboard(current.value?.content || '')
  setTimeout(() => { copied.value = false }, 1500)
}

function save() {
  if (!current.value) return
  downloadText({ content: current.value.content, fileName: current.value.path.split('/').pop() })
}

async function onDelete() {
  const ok = await askConfirm({
    title: '删除作品',
    message: `「${meta.value.title}」的所有版本都会一起删掉，此操作不可恢复。`,
    confirmText: '删除',
    danger: true,
  })
  if (ok) deleteArtifact(meta.value.id)
}

const kb = (bytes) => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`)

/**
 * 按目录分组：根目录的文件排在最前，其余目录按字母序。
 *
 * 分组而不是平铺整条路径，是因为作品拆模块之后目录名会高度重复
 * （`components/` 下四五个文件），平铺出来一列全是同一个前缀，
 * 真正要认的文件名反而被挤到看不见。
 */
/**
 * 当前文件的高亮片段。
 *
 * 产出的是**片段数组**而不是 HTML 字符串，模板里用插值渲染成 span ——
 * 全程没有一处 v-html。源码是模型生成的，那条"父页面只经手字符串"的规矩
 * 在这儿同样成立（见 lib/highlight.js 开头）。
 */
const highlighted = computed(() => {
  if (!current.value) return []
  return tokenize(current.value.content, detectLanguage(current.value.path, meta.value?.language))
})

const fileGroups = computed(() => {
  const groups = new Map()
  for (const file of files.value) {
    const cut = file.path.lastIndexOf('/')
    const dir = cut < 0 ? '' : file.path.slice(0, cut)
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir).push({ ...file, name: cut < 0 ? file.path : file.path.slice(cut + 1) })
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([dir, list]) => ({ dir, files: list.sort((x, y) => x.name.localeCompare(y.name)) }))
})

/* ═══════════════ 元素拾取 ═══════════════ */

const frame = ref(null)
const note = ref(null)
/** 悬浮卡里那句"要怎么改" —— 留在组件里，它是一次性的，不值得进全局状态 */
const pickNote = ref('')
const canInspect = computed(
  () => !props.readonly && Boolean(meta.value) && supportsInspect(meta.value.kind) && tab.value === 'preview',
)

function togglePicking() {
  const next = !state.artifactPicking
  setPicking(next)
  frame.value?.contentWindow?.postMessage({ __ap: 'inspect', on: next }, '*')
}

/**
 * 沙箱报上来的选中结果。
 *
 * ⚠️ **来源校验只能比对 `event.source`，不能比 origin。** 这个 iframe 是不透明源，
 * 它的 origin 就是字符串 "null" —— 任何一个别的 sandbox 页面也能报出同样的 origin，
 * 拿它当判据等于没判。而 contentWindow 是身份，伪造不了。
 *
 * 校验通过也只说明"这条消息确实来自这个预览"，**不说明内容可信** ——
 * 那份文档是模型生成的，可以自己伪造一条 picked。所以内容一律当字符串用：
 * 截断在 setPick 里，展示走模板插值（Vue 会转义），绝不 innerHTML。
 */
function onPreviewMessage(event) {
  /**
   * ⚠️ 只读宿主（分享页）**整条不接**，而不是"接了但不显示"。
   *
   * 分享把威胁模型挪动了一格：以前这份文档只有作者自己会打开，注入是意外；
   * 现在任何人都能把一条链接发给别人，注入是**故意**的。而拾取器这条通道上，
   * 沙箱能主动往父页面推一条消息 —— 不拦的话，一份精心写的作品可以让访客那边
   * 弹出一张**长得像我们自己界面**的卡片，上面的文字由攻击者决定
   * （内容会被转义，所以不是 XSS，是冒充）。
   *
   * 访客那一页本来就没有"让助手改这里"可用，这条通道对他没有任何用处，
   * 所以最干净的处置是：根本不听。
   */
  if (props.readonly) return
  if (!frame.value || event.source !== frame.value.contentWindow) return
  if (event.data?.__ap !== 'picked') return
  setPick(event.data)
  pickNote.value = ''
  // 选完光标直接落进输入框：下一步一定是说"要怎么改"
  nextTick(() => note.value?.focus())
}

function confirmPick() {
  askAboutElement(pickNote.value)
  pickNote.value = ''
}

function onNoteKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') confirmPick()
  if (event.key === 'Escape') clearPick()
}

onMounted(() => window.addEventListener('message', onPreviewMessage))
onBeforeUnmount(() => {
  window.removeEventListener('message', onPreviewMessage)
  clearPick()
})

// 换作品、换版本、切到源码页：选中状态和拾取模式都得清掉，
// 否则会拿着上一份作品里的元素去问这一份
watch(() => [meta.value?.id, detail.value?.version, tab.value].join(':'), clearPick)
</script>

<template>
  <div v-if="meta" class="viewer" :class="{ roomy: props.roomy }">
    <div class="toolbar">
      <div class="tabs">
        <button
          v-if="needsFrame(meta.kind)"
          type="button"
          :class="{ on: tab === 'preview' }"
          @click="tab = 'preview'"
        >预览</button>
        <button type="button" :class="{ on: tab === 'source' }" @click="tab = 'source'">
          源码<span v-if="files.length > 1" class="count">{{ files.length }}</span>
        </button>
      </div>

      <div v-if="meta.versions.length > 1" class="select-wrap">
        <select
          :value="detail.version"
          title="切换版本"
          @change="openArtifact(meta.id, Number($event.target.value))"
        >
          <option v-for="entry in meta.versions" :key="entry.n" :value="entry.n" :disabled="entry.pruned">
            第 {{ entry.n }} 版{{ entry.pruned ? '（已清理）' : '' }}
          </option>
        </select>
        <AppIcon name="chevron-down" :size="12" class="select-caret" />
      </div>

      <div class="acts">
        <button
          v-if="canInspect"
          type="button"
          class="icon-btn"
          :class="{ on: state.artifactPicking }"
          :title="state.artifactPicking ? '取消选择' : '在预览里点一个元素，让助手只改那一处'"
          @click="togglePicking"
        >
          <AppIcon name="crosshair" :size="15" />
        </button>
        <button type="button" class="icon-btn" :title="copied ? '已复制' : '复制当前文件源码'" @click="copySource">
          <AppIcon :name="copied ? 'check' : 'copy'" :size="15" />
        </button>
        <button type="button" class="icon-btn" :title="`下载 ${current ? current.path : ''}`" @click="save">
          <AppIcon name="arrow-up" :size="15" class="down" />
        </button>
        <!--
          分享按钮**带状态**：已经分享出去的作品，这个图标是亮的。
          没有这一点，作者过两天再打开就完全不记得自己有没有发过链接出去 ——
          而"我以为我没分享"是这个功能唯一真正要命的失误。
        -->
        <button
          v-if="!props.readonly && state.features.artifactShare"
          type="button"
          class="icon-btn"
          :class="{ on: isShared }"
          :title="isShared ? '已生成分享链接，点开可复制或撤销' : '生成一条谁都能打开的链接'"
          @click="shareOpen = !shareOpen"
        >
          <AppIcon name="link" :size="15" />
        </button>
        <button v-if="!props.readonly" type="button" class="icon-btn danger" title="删除这份作品" @click="onDelete">
          <AppIcon name="trash" :size="15" />
        </button>
      </div>
    </div>

    <ShareBox v-if="shareOpen && !props.readonly" :meta="meta" @close="shareOpen = false" />

    <p v-if="isOldVersion" class="note warn">
      你正在看第 {{ detail.version }} 版，最新的是第 {{ meta.version }} 版。
    </p>
    <!--
      预览构建失败（Vue 编译不过、mermaid 语法错）要在**外面**也说一句。
      沙箱内那份错误页用户看得到，但它在 iframe 里，复制不出来也搜不到。
    -->
    <p v-if="previewError && tab === 'preview'" class="note warn">{{ previewError }}</p>

    <!--
      ⚠️ 这三支必须是**连着的一条 v-if 链**，中间不能插别的带 v-if 的元素。
      插断过一次，代价是：iframe 变成在 previewHtml 还是空串时就挂载，
      而之后改 srcdoc 不会让它重新导航 —— 表现是"打开一片空白，切到源码再切回来才有"。
      所以拾取相关的浮层都放在 .preview-wrap **里面**，不参与这条链。
    -->
    <div v-if="busy || (previewing && tab === 'preview')" class="empty">
      <span class="spinner" />{{ previewing ? '正在渲染…' : '载入中…' }}
    </div>

    <div v-else-if="tab === 'preview' && needsFrame(meta.kind)" class="preview-wrap">
      <!--
        ⚠️ 预览必须走这个 iframe，而且 sandbox 里**绝不能出现 allow-same-origin**。
        内容是模型生成的，而模型的输入里有邮件和网页 —— 谁能往里塞脚本，
        取决于谁能给这个用户发东西。理由与另一道防线（文档内 CSP）见
        web/src/lib/artifact-view.js 的文件头。
      -->
      <iframe
        ref="frame"
        :key="`${meta.id}-${detail.version}`"
        class="preview-frame"
        :sandbox="PREVIEW_SANDBOX"
        :srcdoc="previewHtml"
        title="作品预览"
        referrerpolicy="no-referrer"
      />

      <div v-if="state.artifactPicking" class="pick-hint">
        <AppIcon name="crosshair" :size="13" />在预览里点一个元素
        <button type="button" @click="togglePicking">取消</button>
      </div>

      <!--
        选中之后就地弹一张小卡，**不离开预览**。
        从前是直接跳回对话、把提示词塞进输入框 —— 预览被关掉、人被甩到另一个页面，
        而他本来正盯着那个元素看。改这一处的全过程都该发生在看得见它的地方。

        卡片里的字段来自沙箱文档的 postMessage（模型生成的页面可以伪造），
        所以只用插值渲染，Vue 会转义。绝不 v-html。
      -->
      <div v-if="state.artifactPick" class="pick-pop">
        <div class="pop-head">
          <code>{{ state.artifactPick.label }}</code>
          <span v-if="state.artifactPick.text" class="pop-text">{{ state.artifactPick.text }}</span>
          <button type="button" class="chip-x" title="取消" @click="clearPick">
            <AppIcon name="x" :size="12" />
          </button>
        </div>
        <code class="pop-path">{{ state.artifactPick.selector }}</code>
        <textarea
          ref="note"
          v-model="pickNote"
          rows="2"
          placeholder="这一处要怎么改？（留空则只把它带到输入框）"
          @keydown="onNoteKeydown"
        />
        <div class="pop-foot">
          <span class="pop-hint">⌘/Ctrl + Enter</span>
          <button type="button" class="primary-btn" :disabled="Boolean(state.live)" @click="confirmPick">
            <AppIcon name="sparkle" :size="13" filled />让助手改这里
          </button>
        </div>
      </div>
    </div>

    <template v-else>
      <!--
        多文件才画文件栏：单文件作品画一列只有一行的清单是噪音。
        按目录分组而不是把整条路径塞进一个标签 —— `components/Chart.vue` 那种
        路径挤成一排之后，一眼看过去全是重复的目录名，反而认不出文件。
      -->
      <div class="source-wrap">
        <nav v-if="files.length > 1" class="filelist">
          <template v-for="group in fileGroups" :key="group.dir">
            <div v-if="group.dir" class="dir">{{ group.dir }}</div>
            <button
              v-for="file in group.files"
              :key="file.path"
              type="button"
              class="filerow"
              :class="{ on: current && file.path === current.path, nested: Boolean(group.dir) }"
              :title="`${file.path} · ${kb(file.bytes)}`"
              @click="activeFile = file.path"
            >
              <span class="filename">{{ file.name }}</span>
              <span v-if="file.path === meta.entry" class="entry-tag">入口</span>
              <span class="filesize">{{ kb(file.bytes) }}</span>
            </button>
          </template>
        </nav>
        <pre class="source"><code><span
          v-for="(token, index) in highlighted"
          :key="index"
          :class="token.t && `tk-${token.t}`"
        >{{ token.text }}</span></code></pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
}

.note {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.6;
}
.note.warn {
  color: var(--warning);
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 34px 0;
  color: var(--muted-foreground);
  font-size: 13px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--secondary);
}
.tabs button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 13px;
  border: 0;
  border-radius: calc(var(--radius-sm) - 2px);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12.5px;
  cursor: pointer;
}
.tabs button.on {
  background: var(--background);
  color: var(--foreground);
  font-weight: 500;
}
.count {
  padding: 0 5px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--foreground) 10%, transparent);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.select-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.select-wrap select {
  padding: 5px 22px 5px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12px;
  cursor: pointer;
  appearance: none;
}
.select-caret {
  position: absolute;
  right: 6px;
  color: var(--muted-foreground);
  pointer-events: none;
}

.acts {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}
.icon-btn.danger:hover {
  color: var(--destructive);
}
.icon-btn.on {
  background: color-mix(in srgb, var(--brand-accent) 16%, transparent);
  color: var(--brand-accent);
}

/* 预览容器：浮层都定位在它里面，而不是插进上面那条 v-if 链 */
.preview-wrap {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 320px;
}

.pick-hint {
  position: absolute;
  top: 10px;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px 6px 11px;
  border-radius: 999px;
  background: var(--brand-accent);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
  transform: translateX(-50%);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--foreground) 25%, transparent);
}
.pick-hint button {
  padding: 1px 8px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
  color: #fff;
  font-size: 11.5px;
  cursor: pointer;
}
.pick-hint button:hover {
  background: rgba(255, 255, 255, 0.34);
}

/*
  选中之后的小卡：**压在预览上**，不把人带走。
  放右下角是因为大多数页面的重点在左上，盖住那儿最碍事。
*/
.pick-pop {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 7px;
  width: min(340px, calc(100% - 24px));
  padding: 10px 11px;
  border: 1px solid color-mix(in srgb, var(--brand-accent) 40%, var(--border));
  border-radius: var(--radius-md);
  background: var(--background);
  box-shadow: 0 12px 34px color-mix(in srgb, var(--foreground) 26%, transparent);
}
.pop-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.pop-head code {
  flex: 0 0 auto;
  color: var(--brand-accent);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
}
.pop-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pop-path {
  overflow: hidden;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pick-pop textarea {
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-size: 12.5px;
  line-height: 1.55;
  resize: vertical;
}
.pick-pop textarea:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--brand-accent) 50%, var(--border));
}
.pop-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pop-hint {
  margin-right: auto;
  color: var(--muted-foreground);
  font-size: 11px;
}
.pop-foot .primary-btn {
  padding: 6px 11px;
  font-size: 12.5px;
}
.chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
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

/*
  预览区把剩下的高度全吃掉：作品多半是整页的东西，给它一个 300px 的小窗
  等于让人在一条缝里翻页。
*/
.preview-frame {
  flex: 1;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  /* 生成的页面基本都假设自己在白底上，跟着深色主题走会出现白字白底 */
  background: #fff;
}
.viewer.roomy .preview-wrap {
  min-height: 480px;
}

/*
  源码页：左边一列文件，右边正文。

  ⚠️ 这一套样式在把详情视图从 ArtifactPanel 抽成 ArtifactViewer 时**漏掉了** ——
  于是那排文件按钮退化成浏览器默认样式挤在一起。抽组件时样式跟着走，
  这件事没有任何机制保证，只能靠看。
*/
.source-wrap {
  display: flex;
  gap: 10px;
  flex: 1;
  min-height: 0;
}

.filelist {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 0 0 auto;
  width: 176px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--secondary) 34%, var(--background));
  overflow-y: auto;
}

/* 目录名是分组标签，不是可点的东西 —— 做小、做淡，别跟文件抢 */
.dir {
  padding: 8px 8px 4px;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.02em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dir:not(:first-child) {
  margin-top: 4px;
  border-top: 1px solid var(--border);
}

.filerow {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}
.filerow.nested {
  padding-left: 14px;
}
.filerow:hover {
  background: color-mix(in srgb, var(--foreground) 6%, transparent);
  color: var(--foreground);
}
.filerow.on {
  background: color-mix(in srgb, var(--brand-accent) 14%, transparent);
  color: var(--foreground);
  font-weight: 500;
}
.filename {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-tag {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--brand-accent) 18%, transparent);
  color: var(--brand-accent);
  font-family: var(--app-font);
  font-size: 10px;
}
/* 体积平时不抢眼，选中或悬停时才显出来 —— 它是"顺便看一眼"的信息 */
.filesize {
  flex: 0 0 auto;
  color: var(--muted-foreground);
  font-size: 10px;
  opacity: 0;
}
.filerow:hover .filesize,
.filerow.on .filesize {
  opacity: 0.75;
}

/* 窄的时候（手机、抽屉被拖得很窄）横过来放，别把正文挤没 */
@media (max-width: 620px) {
  .source-wrap {
    flex-direction: column;
  }
  .filelist {
    flex-direction: row;
    width: auto;
    max-height: 96px;
    flex-wrap: wrap;
  }
  .dir {
    display: none;
  }
  .filerow.nested {
    padding-left: 8px;
  }
}

/*
  配色跟着主题走：作品的源码页和界面其余部分在同一块屏幕上，
  硬塞一套编辑器主题（深色底）会让它在浅色界面里像贴了张膏药。
*/
.tk-com {
  color: color-mix(in srgb, var(--muted-foreground) 85%, transparent);
  font-style: italic;
}
.tk-str {
  color: var(--hl-str);
}
.tk-num {
  color: var(--hl-num);
}
.tk-word {
  color: var(--hl-key);
  font-weight: 500;
}
.tk-fn {
  color: var(--hl-fn);
}
.tk-tag {
  color: var(--hl-key);
}
.tk-attr {
  color: var(--hl-fn);
}
.tk-punc {
  color: var(--muted-foreground);
}

.source {
  flex: 1;
  min-width: 0;
  min-height: 0;
  margin: 0;
  padding: 12px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  overflow: auto;
  white-space: pre;
}
</style>
