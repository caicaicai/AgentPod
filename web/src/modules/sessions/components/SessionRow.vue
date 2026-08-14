<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import { formatTime } from '@/lib/format.js'

const props = defineProps({
  session: { type: Object, required: true },
  active: { type: Boolean, default: false },
  /** 搜索命中正文时给一段上下文：只回标题的话，用户还得挨个点进去找那句话 */
  showSnippet: { type: Boolean, default: false },
})
const emit = defineEmits(['open', 'action'])

const menuOpen = ref(false)

/**
 * 四个操作收进一个菜单，而不是在行上摆四个图标。
 *
 * 侧栏只有 272px 宽，四个按钮压过来标题就只剩几个字 —— 而标题才是用户
 * 在这一行里真正要读的东西。
 */
function toggleMenu() {
  menuOpen.value = !menuOpen.value
}

function pick(action) {
  menuOpen.value = false
  emit('action', action, props.session)
}

// 点别处收起来。挂在 document 上，因为菜单外面的任何点击都该关掉它
function onDocClick() {
  menuOpen.value = false
}
watch(menuOpen, (open) => {
  if (open) setTimeout(() => document.addEventListener('click', onDocClick, { once: true }), 0)
})
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div class="session-row" :class="{ active: props.active, 'menu-open': menuOpen }">
    <button type="button" class="session" @click="emit('open', props.session.sessionKey)">
      <span class="title">
        <AppIcon v-if="props.session.pinned" name="pin" :size="12" class="pin-mark" />
        {{ props.session.title || '未命名会话' }}
      </span>
      <span class="meta">
        {{ formatTime(props.session.updatedAt) }}
        <template v-if="props.session.archived"> · 已归档</template>
      </span>
      <span
        v-if="props.showSnippet && props.session.matchedIn === 'content' && props.session.snippet"
        class="snippet"
      >{{ props.session.snippet }}</span>
    </button>

    <div class="session-menu" @click.stop>
      <button type="button" class="session-menu-btn" title="更多操作" @click="toggleMenu">
        <AppIcon name="more" :size="15" />
      </button>
      <div v-if="menuOpen" class="session-menu-popover">
        <button type="button" @click="pick('pin')">
          <AppIcon name="pin" :size="14" />{{ props.session.pinned ? '取消置顶' : '置顶' }}
        </button>
        <button type="button" @click="pick('rename')">
          <AppIcon name="pencil" :size="14" />重命名
        </button>
        <button type="button" @click="pick('archive')">
          <AppIcon name="archive" :size="14" />{{ props.session.archived ? '取消归档' : '归档' }}
        </button>
        <button type="button" class="danger" @click="pick('delete')">
          <AppIcon name="trash" :size="14" />删除
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-row {
  position: relative;
  border-radius: var(--radius-sm);
}
.session {
  display: block;
  width: 100%;
  padding: 7px 34px 7px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}
.session-row:hover .session {
  background: color-mix(in srgb, var(--foreground) 5%, transparent);
}
.session-row.active .session,
.session-row.menu-open .session {
  background: color-mix(in srgb, var(--foreground) 9%, transparent);
}

.title {
  display: flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  color: var(--foreground);
  font-size: 13.5px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-row.active .title {
  font-weight: 600;
}
.pin-mark {
  color: var(--muted-foreground);
}
.meta {
  display: block;
  color: var(--muted-foreground);
  font-size: 11.5px;
  line-height: 1.5;
}
.snippet {
  display: -webkit-box;
  margin-top: 3px;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: 11.5px;
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.session-menu {
  position: absolute;
  top: 6px;
  right: 5px;
}
.session-menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease, background 0.12s ease;
}
.session-row:hover .session-menu-btn,
.session-row.menu-open .session-menu-btn,
.session-menu-btn:focus-visible {
  opacity: 1;
}
.session-menu-btn:hover {
  background: color-mix(in srgb, var(--foreground) 10%, transparent);
  color: var(--foreground);
}

.session-menu-popover {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 40;
  min-width: 150px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--background);
  box-shadow: 0 10px 30px color-mix(in srgb, var(--foreground) 14%, transparent);
}
.session-menu-popover button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--foreground);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.session-menu-popover button:hover {
  background: var(--secondary);
}
.session-menu-popover button.danger {
  color: var(--destructive);
}
</style>
