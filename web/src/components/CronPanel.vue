<script setup>
import { computed, ref } from 'vue'

import AppIcon from './AppIcon.vue'
import SidePanel from './SidePanel.vue'
import { cronAction, createCron, state } from '../stores/app.js'
import { describeSchedule, formatDateTime, formatTime } from '../lib/format.js'

const FIRE_STATUS_TEXT = {
  ok: '成功', error: '失败', needs_reauth: '缺登录态', disabled: '已自动停用',
}

const creating = ref(false)
const form = ref({ title: '', task: '', preset: '0 9 * * *', expr: '', sessionMode: 'new' })
const custom = computed(() => form.value.preset === 'custom')

function lastFire(cron) {
  return cron.fireLog?.length ? cron.fireLog[cron.fireLog.length - 1] : null
}

async function onCreate() {
  const task = form.value.task.trim()
  if (!task) {
    state.cronNote = '请填写「到点执行什么」'
    state.cronNoteWarn = true
    return
  }
  const ok = await createCron({
    title: form.value.title.trim(),
    task,
    schedule: {
      cron: custom.value ? form.value.expr.trim() : form.value.preset,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    },
    sessionMode: form.value.sessionMode,
  })
  if (ok) {
    form.value.title = ''
    form.value.task = ''
    creating.value = false
  }
}

function onDelete(cron) {
  if (!window.confirm(`删除定时任务「${cron.title || '(未命名)'}」？`)) return
  cronAction(cron, 'delete')
}
</script>

<template>
  <SidePanel title="定时任务" wide>
    <p class="panel-note" :class="{ warn: state.cronNoteWarn }">{{ state.cronNote }}</p>

    <div v-if="!state.crons.length" class="empty">
      还没有定时任务。也可以直接在对话里说「以后每天九点帮我…」
    </div>

    <div v-else class="cron-list">
      <div v-for="cron in state.crons" :key="cron.id" class="cron-card" :class="{ off: !cron.enabled }">
        <div class="cron-head">
          <span class="cron-title">{{ cron.title || '(未命名)' }}</span>
          <span class="cron-when">{{ describeSchedule(cron.schedule) }}</span>
        </div>
        <div class="cron-task">{{ cron.task || '' }}</div>
        <div class="cron-next">
          <AppIcon name="clock" :size="12" />
          {{ cron.enabled && cron.nextFireAt ? `下次：${formatDateTime(cron.nextFireAt)}` : '已停用' }}
        </div>
        <div v-if="lastFire(cron)" class="cron-last" :class="`is-${lastFire(cron).status}`">
          上次：{{ formatTime(lastFire(cron).firedAt) }}
          {{ FIRE_STATUS_TEXT[lastFire(cron).status] || lastFire(cron).status }}
          <template v-if="lastFire(cron).note"> · {{ lastFire(cron).note }}</template>
        </div>
        <div v-else class="cron-last">还没触发过</div>

        <div class="cron-actions">
          <button type="button" class="ghost-btn" @click="cronAction(cron, 'toggle')">
            {{ cron.enabled ? '停用' : '启用' }}
          </button>
          <button type="button" class="ghost-btn" @click="cronAction(cron, 'run')">
            <AppIcon name="play" :size="12" filled />立即执行
          </button>
          <button type="button" class="ghost-btn danger" @click="onDelete(cron)">删除</button>
        </div>
      </div>
    </div>

    <div class="cron-new">
      <button type="button" class="new-toggle" @click="creating = !creating">
        <AppIcon :name="creating ? 'chevron-down' : 'chevron-right'" :size="14" />新建定时任务
      </button>

      <div v-if="creating" class="new-form">
        <label class="field">
          <span>任务名</span>
          <input v-model="form.title" type="text" placeholder="每日告警汇总" />
        </label>
        <label class="field">
          <span>到点执行什么</span>
          <textarea v-model="form.task" rows="3" placeholder="触发时没有本次对话的上下文，请把背景和目标写全" />
        </label>
        <label class="field">
          <span>什么时候</span>
          <select v-model="form.preset">
            <option value="0 9 * * *">每天 9:00</option>
            <option value="30 9 * * 1-5">工作日 9:30</option>
            <option value="0 18 * * 5">每周五 18:00</option>
            <option value="0 9 1 * *">每月 1 号 9:00</option>
            <option value="custom">自定义 cron…</option>
          </select>
        </label>
        <label v-if="custom" class="field">
          <span>cron 表达式（分 时 日 月 星期）</span>
          <input v-model="form.expr" type="text" placeholder="30 9 * * 1-5" />
        </label>
        <label class="field">
          <span>会话方式</span>
          <select v-model="form.sessionMode">
            <option value="new">每次新会话（推荐）</option>
            <option value="shared">共用一条会话（需要连续上下文时）</option>
          </select>
        </label>
        <button type="button" class="primary-btn" @click="onCreate">创建</button>
      </div>
    </div>
  </SidePanel>
</template>

<style scoped>
.cron-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cron-card {
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--background);
}
.cron-card.off {
  opacity: 0.62;
}
.cron-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.cron-title {
  min-width: 0;
  overflow: hidden;
  color: var(--foreground);
  font-size: 13.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cron-when {
  flex: 0 0 auto;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.cron-task {
  margin: 6px 0;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
}
.cron-next,
.cron-last {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--muted-foreground);
  font-size: 11.5px;
  line-height: 1.8;
}
.cron-last.is-error,
.cron-last.is-needs_reauth,
.cron-last.is-disabled {
  color: var(--destructive);
}
.cron-last.is-ok {
  color: var(--success);
}
.cron-actions {
  display: flex;
  gap: 6px;
  margin-top: 9px;
}

.cron-new {
  margin-top: 4px;
}
.new-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 10px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 13px;
  cursor: pointer;
}
.new-toggle:hover {
  border-color: color-mix(in srgb, var(--brand-accent) 40%, var(--border));
  color: var(--foreground);
}
.new-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--background);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field > span {
  color: var(--muted-foreground);
  font-size: 12px;
}
.field input,
.field textarea,
.field select {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  outline: 0;
  background: var(--background);
  color: var(--foreground);
  font-size: 13px;
}
.field textarea {
  line-height: 1.6;
  resize: vertical;
}
.field input:focus,
.field textarea:focus {
  border-color: color-mix(in srgb, var(--brand-accent) 45%, var(--border));
}
.empty {
  padding: 18px 0;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.7;
  text-align: center;
}
</style>
