<script setup>
import { computed, ref, watch } from 'vue'

import AppIcon from './AppIcon.vue'
import SidePanel from './SidePanel.vue'
import { copyToClipboard } from '../lib/debug-bundle.js'
import { formatTime } from '../lib/format.js'
import {
  PREVIEW_SANDBOX, buildPreviewDoc, downloadText, kindIcon, kindLabel, needsFrame,
} from '../lib/artifact-view.js'
import {
  closeArtifactDetail, deleteArtifact, openArtifact, refreshArtifacts, setArtifactWidth, state,
  toggleArtifactFull,
} from '../stores/app.js'

/**
 * 作品面板。
 *
 * 两个层次共用一个抽屉：没打开具体某份时是清单，打开之后是正文。
 * 不做成两个面板，是因为"看完一个再看下一个"是最常见的动作，
 * 中间不该逼人先关掉再从对话里翻另一张卡片。
 */
const tab = ref('preview')
/** 源码页看的是哪个文件。作品是多文件的，这一格才是"读它"的主要入口 */
const activeFile = ref('')

const detail = computed(() => state.artifactDetail)
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
 * `token` 是为了丢掉过期的结果：编译一份大点的 Vue 作品要几百毫秒，
 * 这期间用户完全可能已经切到另一份作品上了 —— 不判一下就会看到上一份的画面。
 */
let token = 0
async function rebuildPreview() {
  if (!meta.value || !needsFrame(meta.value.kind)) {
    previewHtml.value = ''
    return
  }
  const mine = ++token
  previewing.value = true
  const result = await buildPreviewDoc({
    kind: meta.value.kind,
    files: files.value,
    entry: meta.value.entry,
    allowedOrigins: state.artifactPreview.allowedOrigins || [],
  })
  if (mine !== token) return
  previewHtml.value = result.html
  previewError.value = result.error
  previewing.value = false
}

watch(
  () => [meta.value?.id, detail.value?.version].join(':'),
  () => {
    // 换一份（或换一版）就回到预览页、回到入口文件：上一份看的是源码里的某个
    // 文件，不代表下一份也想看那儿，而"停在源码页"会让人以为新的这份没渲染出来
    tab.value = 'preview'
    activeFile.value = meta.value?.entry || ''
    rebuildPreview()
  },
  { immediate: true },
)

/* ═══════════════ 动作 ═══════════════ */

const copied = ref(false)
async function copySource() {
  copied.value = await copyToClipboard(current.value?.content || '')
  setTimeout(() => { copied.value = false }, 1500)
}

function save() {
  if (!current.value) return
  downloadText({ content: current.value.content, fileName: current.value.path.split('/').pop() })
}

function onDelete() {
  if (!window.confirm(`删除作品「${meta.value.title}」？所有版本都会一起删掉，不可恢复。`)) return
  deleteArtifact(meta.value.id)
}

const kb = (bytes) => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`)
</script>

<template>
  <SidePanel
    :title="meta ? meta.title : '作品'"
    :xwide="!state.artifactFull"
    :full="state.artifactFull"
    resizable
    :width="state.artifactWidth"
    @update:width="setArtifactWidth"
  >
    <template #head-actions>
      <button
        v-if="meta"
        type="button"
        class="icon-btn"
        title="回到作品清单"
        @click="closeArtifactDetail"
      >
        <AppIcon name="panel-open" :size="16" />
      </button>
      <button v-else type="button" class="icon-btn" title="刷新" @click="refreshArtifacts">
        <AppIcon name="refresh" :size="15" />
      </button>
      <button
        type="button"
        class="icon-btn"
        :title="state.artifactFull ? '退出全屏（保留这个选择）' : '铺满窗口（保留这个选择）'"
        @click="toggleArtifactFull"
      >
        <AppIcon :name="state.artifactFull ? 'shrink' : 'expand'" :size="16" />
      </button>
    </template>

    <!-- ── 清单 ── -->
    <template v-if="!meta">
      <p v-if="state.artifactNote" class="note warn">{{ state.artifactNote }}</p>
      <p v-else class="note">
        助手做出来的成品会存在这里：网页、Vue 组件、文档、图和成段的代码。
        想改就直接说「把标题改成…」，它会在原来那份上出新版本。
      </p>

      <div v-if="!state.artifacts.length" class="empty">这条对话还没有作品。</div>
      <button
        v-for="item in state.artifacts"
        :key="item.id"
        type="button"
        class="list-row"
        @click="openArtifact(item.id)"
      >
        <AppIcon :name="kindIcon(item.kind)" :size="15" class="row-icon" />
        <span class="row-main">
          <span class="row-title">{{ item.title }}</span>
          <span class="row-meta">
            {{ kindLabel(item) }} · 第 {{ item.version }} 版 · {{ formatTime(item.updatedAt) }}
          </span>
        </span>
        <AppIcon name="chevron-right" :size="14" class="row-caret" />
      </button>
    </template>

    <!-- ── 正文 ── -->
    <template v-else>
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
            <option
              v-for="entry in meta.versions"
              :key="entry.n"
              :value="entry.n"
              :disabled="entry.pruned"
            >
              第 {{ entry.n }} 版{{ entry.pruned ? '（已清理）' : '' }}
            </option>
          </select>
          <AppIcon name="chevron-down" :size="12" class="select-caret" />
        </div>
      </div>

      <p v-if="isOldVersion" class="note warn">
        你正在看第 {{ detail.version }} 版，最新的是第 {{ meta.version }} 版。
      </p>
      <p v-if="state.artifactNote" class="note warn">{{ state.artifactNote }}</p>
      <!--
        预览构建失败（Vue 编译不过、mermaid 语法错）要在**面板里**说一句。
        沙箱内那份错误页用户看得到，但它在 iframe 里，复制不出来也搜不到。
      -->
      <p v-if="previewError && tab === 'preview'" class="note warn">{{ previewError }}</p>

      <div v-if="state.artifactLoading || (previewing && tab === 'preview')" class="empty">
        <span class="spinner" />{{ previewing ? '正在渲染…' : '载入中…' }}
      </div>

      <!--
        ⚠️ 预览必须走这个 iframe，而且 sandbox 里**绝不能出现 allow-same-origin**。
        内容是模型生成的，而模型的输入里有邮件和网页 —— 谁能往里塞脚本，
        取决于谁能给这个用户发东西。理由与另一道防线（文档内 CSP）见
        web/src/lib/artifact-view.js 的文件头。
      -->
      <iframe
        v-else-if="tab === 'preview' && needsFrame(meta.kind)"
        :key="`${meta.id}-${detail.version}`"
        class="preview-frame"
        :sandbox="PREVIEW_SANDBOX"
        :srcdoc="previewHtml"
        title="作品预览"
        referrerpolicy="no-referrer"
      />

      <template v-else>
        <!-- 多文件才画文件条：单文件作品画一排只有一个格子的标签是噪音 -->
        <div v-if="files.length > 1" class="filebar">
          <button
            v-for="file in files"
            :key="file.path"
            type="button"
            class="filechip"
            :class="{ on: current && file.path === current.path }"
            :title="`${file.path} · ${kb(file.bytes)}`"
            @click="activeFile = file.path"
          >
            {{ file.path }}
            <span v-if="file.path === meta.entry" class="entry-dot" title="入口文件">●</span>
          </button>
        </div>
        <pre class="source">{{ current ? current.content : '' }}</pre>
      </template>
    </template>

    <template v-if="meta" #footer>
      <button type="button" class="ghost-btn" @click="copySource">
        <AppIcon :name="copied ? 'check' : 'copy'" :size="14" />{{ copied ? '已复制' : '复制源码' }}
      </button>
      <button type="button" class="ghost-btn" :title="current ? current.path : ''" @click="save">
        <AppIcon name="arrow-up" :size="14" class="down" />下载
      </button>
      <span class="spacer" />
      <button type="button" class="ghost-btn danger" @click="onDelete">
        <AppIcon name="trash" :size="14" />删除
      </button>
    </template>
  </SidePanel>
</template>

<style scoped>
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

.list-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.list-row:hover {
  background: var(--secondary);
  border-color: color-mix(in srgb, var(--brand-accent) 32%, var(--border));
}
.row-icon {
  color: var(--brand-accent);
}
.row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.row-title {
  overflow: hidden;
  color: var(--foreground);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-meta {
  color: var(--muted-foreground);
  font-size: 11.5px;
}
.row-caret {
  color: var(--muted-foreground);
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
  margin-left: auto;
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

/* 文件多起来之后要能换行看全，而不是挤成一条横向滚动的缝 */
.filebar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  flex: 0 0 auto;
}
.filechip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: 11.5px;
  cursor: pointer;
}
.filechip:hover {
  background: var(--secondary);
  color: var(--foreground);
}
.filechip.on {
  border-color: color-mix(in srgb, var(--brand-accent) 45%, var(--border));
  background: color-mix(in srgb, var(--brand-accent) 10%, transparent);
  color: var(--foreground);
}
.entry-dot {
  color: var(--brand-accent);
  font-size: 8px;
}

/*
  预览区把剩下的高度全吃掉：作品多半是整页的东西，给它一个 300px 的小窗
  等于让人在一条缝里翻页。
*/
.preview-frame {
  flex: 1;
  min-height: 320px;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  /* 生成的页面基本都假设自己在白底上，跟着深色主题走会出现白字白底 */
  background: #fff;
}

.source {
  flex: 1;
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

.spacer {
  flex: 1;
}
/* 下载没有专门的图标，把"上传"那个箭头转过来用 */
.down {
  transform: rotate(180deg);
}
</style>
