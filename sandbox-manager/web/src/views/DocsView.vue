<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { marked } from 'marked'
// ?raw：文档以源文件形式打进包里。这样**页面渲染的和下载的是同一份内容** ——
// 分成两份迟早会漂移，而接口文档漂移比没有文档更糟。
import source from '@/docs/sandbox-api.md?raw'

const FILE_NAME = 'sandbox-api.md'

const container = ref(null)
const activeId = ref('')

marked.setOptions({ gfm: true, breaks: false })

/** 给标题补 id，锚点和目录都要用。 */
function slug(text, seen) {
  const base = String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section'
  const count = (seen.get(base) || 0) + 1
  seen.set(base, count)
  return count > 1 ? `${base}-${count}` : base
}

const headings = ref([])

const html = computed(() => {
  const seen = new Map()
  const toc = []
  const renderer = new marked.Renderer()
  const original = renderer.heading.bind(renderer)

  renderer.heading = function heading(token) {
    const text = this.parser.parseInline(token.tokens)
    const id = slug(token.text, seen)
    if (token.depth <= 3) toc.push({ id, text: token.text, depth: token.depth })
    return `<h${token.depth} id="${id}">${text}</h${token.depth}>`
  }

  const out = marked.parse(source, { renderer })
  headings.value = toc
  return out
})

/**
 * 下载。用 Blob 而不是给一个指向源文件的链接：源文件在生产构建里被打进 JS，
 * 没有独立的可下载 URL。
 */
function download() {
  const blob = new Blob([source], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = FILE_NAME
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 不撤销会一直占着内存，直到页面关闭
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const copied = ref(false)
async function copySource() {
  try {
    await navigator.clipboard.writeText(source)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1800)
  } catch {
    // 剪贴板在非安全上下文（http）下不可用，这时下载是唯一出路，不必报错打断
    download()
  }
}

let observer = null
onMounted(() => {
  // 目录高亮跟随滚动。用 IntersectionObserver 而不是 scroll 事件：
  // 后者在长文档上每帧都要算一遍所有标题的位置。
  observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting)
      if (visible.length) activeId.value = visible[0].target.id
    },
    { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
  )
  requestAnimationFrame(() => {
    container.value?.querySelectorAll('h1[id],h2[id],h3[id]').forEach((el) => observer.observe(el))
  })
})
onBeforeUnmount(() => observer?.disconnect())

function jump(id) {
  const el = container.value?.querySelector(`#${CSS.escape(id)}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const sizeKb = (new Blob([source]).size / 1024).toFixed(1)
</script>

<template>
  <div class="docs">
    <aside class="toc">
      <div class="toc-head">
        <span class="section-title" style="margin: 0">目录</span>
        <span class="faint size">{{ sizeKb }} KB</span>
      </div>
      <nav>
        <a
          v-for="h in headings"
          :key="h.id"
          :class="['lvl-' + h.depth, { active: activeId === h.id }]"
          href="javascript:void(0)"
          @click="jump(h.id)"
        >{{ h.text }}</a>
      </nav>
      <div class="actions">
        <button class="primary" @click="download">下载 Markdown</button>
        <button @click="copySource">{{ copied ? '已复制' : '复制全文' }}</button>
      </div>
    </aside>

    <article ref="container" class="card body" v-html="html" />
  </div>
</template>

<style scoped>
.docs {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
@media (max-width: 900px) {
  .docs { grid-template-columns: 1fr; }
  .toc { position: static !important; }
}

.toc {
  position: sticky;
  top: 68px;
  max-height: calc(100vh - 96px);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.toc-head { display: flex; align-items: baseline; justify-content: space-between; }
.size { font-size: 11.5px; }

.toc nav {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
}
.toc a {
  color: var(--text-muted);
  font-size: 12.5px;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  border-left: 2px solid transparent;
  line-height: 1.45;
}
.toc a:hover { background: var(--bg-sunken); text-decoration: none; }
.toc a.active { color: var(--accent); border-left-color: var(--accent); background: var(--accent-soft); }
.toc a.lvl-1 { font-weight: 600; color: var(--text); }
.toc a.lvl-3 { padding-left: 20px; font-size: 12px; }

.actions { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 4px; }

.body { padding: 28px 34px 48px; overflow-x: auto; }
</style>

<style>
/* 非 scoped：v-html 生成的节点带不上 scoped 属性 */
.docs .body > :first-child { margin-top: 0; }

.docs .body h1 { font-size: 24px; margin: 0 0 8px; }
.docs .body h2 {
  font-size: 18px;
  margin: 36px 0 12px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--border);
}
.docs .body h3 { font-size: 15px; margin: 26px 0 8px; }
.docs .body h4 { font-size: 13.5px; margin: 20px 0 6px; color: var(--text-muted); }

.docs .body p, .docs .body li { line-height: 1.75; }
.docs .body ul, .docs .body ol { padding-left: 22px; }
.docs .body li { margin: 3px 0; }

.docs .body code {
  background: var(--bg-sunken);
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 0.88em;
  font-family: var(--mono);
}
.docs .body pre {
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  overflow-x: auto;
  line-height: 1.6;
}
.docs .body pre code { background: none; padding: 0; font-size: 12.5px; }

.docs .body table {
  margin: 14px 0;
  font-size: 13px;
  display: block;
  overflow-x: auto;
  max-width: 100%;
}
.docs .body th, .docs .body td { white-space: normal; }
.docs .body th { background: var(--bg-sunken); }
.docs .body td code { white-space: nowrap; }

.docs .body blockquote {
  margin: 14px 0;
  padding: 10px 14px;
  border-left: 3px solid var(--warn);
  background: var(--warn-soft);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--text);
}
.docs .body blockquote p { margin: 4px 0; font-size: 13px; }

.docs .body hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
</style>
