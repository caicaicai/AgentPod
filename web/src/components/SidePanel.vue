<script setup>
import { ref } from 'vue'

import AppIcon from './AppIcon.vue'
import { closePanel } from '../stores/app.js'

/**
 * 右侧抽屉的外壳。技能 / 记忆 / 定时任务 / 项目 / 调试信息 / 作品共用。
 *
 * 抽屉留在布局流里（挤压正文）而不是浮在上面：这些面板都是"边看对话边改"的东西 ——
 * 记忆面板尤其如此，用户常常是看到助手记错了才来改。盖住对话就等于让人凭记忆操作。
 */
const props = defineProps({
  title: { type: String, required: true },
  wide: { type: Boolean, default: false },
  /** 更宽的一档。作品面板要在里面预览整页网页，460px 只够看个轮廓 */
  xwide: { type: Boolean, default: false },
  /**
   * 铺满整个布局（盖住会话列表和对话）。
   *
   * 抽屉再宽也是妥协：作品常常是给别人看的整页东西，"挤在右边一条里预览"
   * 和"真的看一眼成品"是两种需求，宽度调不出一个同时满足的值 —— 所以给开关，
   * 再给下面那条可拖的边。
   */
  full: { type: Boolean, default: false },
  /** 左边缘给一条可拖的分隔条 */
  resizable: { type: Boolean, default: false },
  /** 用户拖出来的宽度（像素）。0 = 用默认档位 */
  width: { type: Number, default: 0 },
})
const emit = defineEmits(['update:width'])

const panel = ref(null)
const dragging = ref(false)

/** 太窄了看不成东西，太宽了对话只剩一条缝 —— 两头都兜住 */
function clamp(px) {
  return Math.round(Math.min(Math.max(px, 360), window.innerWidth - 320))
}

/**
 * 拖动改宽度。
 *
 * `setPointerCapture` 不是可选的：面板里嵌着预览用的 iframe，指针一旦划到它上面，
 * 后续事件就都进了那个文档，外面收不到 —— 表现是"拖到一半突然不跟手了"。
 * 捕获之后事件始终回到这条分隔条上。另外拖动期间给 iframe 关掉命中测试，
 * 免得页面里的 :hover / 拖拽逻辑跟着乱动。
 */
function startDrag(event) {
  if (props.full) return
  /**
   * ⚠️ 必须**当场**把元素存下来。`event.currentTarget` 只在事件派发期间有值，
   * 处理函数一返回就变成 null —— 留到 stop 里再取，那几个 removeEventListener
   * 会当场抛错，而现象是"松手之后面板还在跟着鼠标跑"。
   */
  const handle = event.currentTarget
  dragging.value = true
  handle.setPointerCapture(event.pointerId)

  const move = (moveEvent) => {
    const right = panel.value?.getBoundingClientRect().right ?? window.innerWidth
    emit('update:width', clamp(right - moveEvent.clientX))
  }
  const stop = () => {
    dragging.value = false
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', stop)
    handle.removeEventListener('pointercancel', stop)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', stop)
  handle.addEventListener('pointercancel', stop)
}

/** 双击复位到默认档位。拖歪了之后，"我要回到原来那个宽度"没有别的办法表达 */
function resetWidth() {
  emit('update:width', 0)
}
</script>

<template>
  <aside
    ref="panel"
    class="side-panel"
    :class="{ wide, xwide, full, dragging }"
    :style="width && !full ? { '--panel-custom-w': `${width}px` } : null"
  >
    <!--
      分隔条画在面板**内部**的左边缘（负 margin 挪出去一半），而不是在布局里
      单独占一列：占一列的话，面板一关它就没了位置，还得为"面板不在时别画它"
      再加一处判断。
    -->
    <div
      v-if="resizable && !full"
      class="resizer"
      title="拖动调整宽度（双击复位）"
      @pointerdown="startDrag"
      @dblclick="resetWidth"
    />

    <header class="panel-head">
      <h2>{{ title }}</h2>
      <slot name="head-actions" />
      <button type="button" class="icon-btn" title="关闭（Esc）" @click="closePanel">
        <AppIcon name="x" :size="16" />
      </button>
    </header>
    <div class="panel-body">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="panel-foot">
      <slot name="footer" />
    </footer>
  </aside>
</template>

<style scoped>
.side-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: var(--panel-w);
  flex: 0 0 var(--panel-w);
  border-left: 1px solid var(--border);
  background: color-mix(in srgb, var(--secondary) 30%, var(--background));
}
.side-panel.wide {
  width: 460px;
  flex-basis: 460px;
}
/*
  作品面板的默认档。上限用 vw 兜住：屏幕不宽时，抽屉再宽就把对话挤没了。

  用户拖过之后走 `--panel-custom-w`（由内联样式给），默认值就是这个表达式 ——
  **不用内联 width**，因为那样会盖过下面 ≤900px 的媒体查询，把窄屏的浮层
  布局一起改坏。变量只在这条规则里生效，媒体查询直接写 width，各管各的。
*/
.side-panel.xwide {
  width: var(--panel-custom-w, min(960px, 56vw));
  flex-basis: var(--panel-custom-w, min(960px, 56vw));
}

/*
  分隔条。命中区域比看得见的那条宽（12px），否则要瞄准 1px 的边框才拖得动。
*/
.resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -6px;
  z-index: 10;
  width: 12px;
  cursor: col-resize;
  touch-action: none;
}
.resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 5px;
  width: 2px;
  background: transparent;
  transition: background 0.12s ease;
}
.resizer:hover::after,
.side-panel.dragging .resizer::after {
  background: var(--brand-accent);
}

/*
  拖动期间关掉 iframe 的命中测试。
  指针捕获已经保证事件不会丢，这一条挡的是另一件事：指针划过预览页面时，
  那个页面自己的 :hover / 拖拽逻辑会跟着乱动。
*/
.side-panel.dragging :deep(iframe) {
  pointer-events: none;
}
.side-panel.dragging {
  user-select: none;
}

/*
  全屏：盖在整个布局上（.layout 是 position: relative）。
  不用 position: fixed —— 那会脱离布局容器，在嵌进别的页面时跑到窗口边上去。
*/
.side-panel.full {
  position: absolute;
  inset: 0;
  z-index: 40;
  width: 100%;
  flex-basis: auto;
  border-left: 0;
  background: var(--background);
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  /*
    与对话区顶栏共用 --head-h。这两条底线是并排的，差几个像素一眼就看得出来，
    而"各自 padding 10px"并不能保证它们一样高 —— 高度实际由里面装了什么控件决定。
  */
  height: var(--head-h);
  padding: 0 10px 0 16px;
  border-bottom: 1px solid var(--border);
}
.panel-head h2 {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
  padding: 14px 16px;
  overflow-y: auto;
}

.panel-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 11px 16px;
  border-top: 1px solid var(--border);
}

/*
  窄屏下抽屉改成盖在正文上的全宽层：480px 的屏幕再挤出一个 400px 的面板，
  剩给对话的就只有一条缝了。
*/
@media (max-width: 900px) {
  .side-panel,
  .side-panel.wide,
  .side-panel.xwide {
    position: absolute;
    inset: 0 0 0 auto;
    z-index: 30;
    width: min(420px, 100%);
    flex-basis: auto;
    box-shadow: -12px 0 40px color-mix(in srgb, var(--foreground) 16%, transparent);
  }
}
</style>
