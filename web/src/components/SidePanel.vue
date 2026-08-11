<script setup>
import AppIcon from './AppIcon.vue'
import { closePanel } from '../stores/app.js'

/**
 * 右侧抽屉的外壳。技能 / 记忆 / 定时任务 / 项目 / 调试信息共用。
 *
 * 抽屉留在布局流里（挤压正文）而不是浮在上面：这些面板都是"边看对话边改"的东西 ——
 * 记忆面板尤其如此，用户常常是看到助手记错了才来改。盖住对话就等于让人凭记忆操作。
 */
defineProps({
  title: { type: String, required: true },
  wide: { type: Boolean, default: false },
})
</script>

<template>
  <aside class="side-panel" :class="{ wide }">
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

.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 10px 10px 10px 16px;
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
  .side-panel.wide {
    position: absolute;
    inset: 0 0 0 auto;
    z-index: 30;
    width: min(420px, 100%);
    flex-basis: auto;
    box-shadow: -12px 0 40px color-mix(in srgb, var(--foreground) 16%, transparent);
  }
}
</style>
