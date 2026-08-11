<script setup>
import { ref, computed } from 'vue'
import SlotBar from '@/components/SlotBar.vue'
import StatusPill from '@/components/StatusPill.vue'
import NodeDrawer from '@/components/NodeDrawer.vue'
import { nodes, pools, canWrite, writeBlockedReason } from '@/store/cluster.js'
import { duration, explainReason } from '@/utils/format.js'

const keyword = ref('')
const poolFilter = ref('')
const onlyProblem = ref(false)
const selected = ref(null)

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return nodes.value.filter((n) => {
    if (poolFilter.value && n.pool !== poolFilter.value) return false
    if (onlyProblem.value && n.schedulable && !n.stale) return false
    if (!kw) return true
    return (
      n.nodeId.toLowerCase().includes(kw) ||
      (n.base || '').toLowerCase().includes(kw) ||
      (n.version || '').toLowerCase().includes(kw)
    )
  })
})

/** 选中的那个节点要跟着轮询更新，所以按 id 从最新快照里取，不存快照本身。 */
const selectedNode = computed(() =>
  selected.value ? nodes.value.find((n) => n.nodeId === selected.value) || null : null,
)

function statusOf(n) {
  if (n.draining) {
    return { level: 'warn', text: n.drainSource === 'admin' ? '运维摘除' : '节点停机中' }
  }
  if (!n.healthy) return { level: 'error', text: '不健康' }
  if (n.stale) return { level: 'warn', text: '心跳掉队' }
  if (!n.schedulable) return { level: 'error', text: explainReason(n.blockedBy) }
  return { level: 'ok', text: '可调度' }
}
</script>

<template>
  <div>
    <div class="toolbar">
      <input v-model="keyword" placeholder="搜索 nodeId / 地址 / 版本" class="search" />
      <select v-model="poolFilter">
        <option value="">全部资源池</option>
        <option v-for="p in pools" :key="p.pool" :value="p.pool">{{ p.pool }}</option>
      </select>
      <label class="check">
        <input type="checkbox" v-model="onlyProblem" />
        只看有问题的
      </label>
      <span class="faint count">{{ filtered.length }} / {{ nodes.length }}</span>
      <span v-if="!canWrite" class="faint readonly" :title="writeBlockedReason">写操作已禁用</span>
    </div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>节点</th>
            <th>资源池</th>
            <th style="width: 190px">槽位</th>
            <th>租约</th>
            <th>能力</th>
            <th>版本</th>
            <th>心跳</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="n in filtered" :key="n.nodeId" class="row" @click="selected = n.nodeId">
            <td>
              <div class="node-id mono">{{ n.nodeId }}</div>
              <div class="faint base mono">{{ n.base }}</div>
            </td>
            <td><code>{{ n.pool }}</code></td>
            <td><SlotBar :used="n.slots.used" :total="n.slots.total" :inactive="!n.schedulable" /></td>
            <td>{{ n.leases }}</td>
            <td class="caps">
              <span v-if="n.caps?.browser" class="cap" title="具备浏览器能力">浏览器</span>
              <span v-if="n.caps?.cgroup && n.caps.cgroup !== 'none'" class="cap">cgroup {{ n.caps.cgroup }}</span>
              <span v-if="n.caps?.cgroup === 'none'" class="cap danger" title="没有 cgroup，资源限制不生效">无 cgroup</span>
            </td>
            <td class="mono faint">{{ n.version || '—' }}</td>
            <td :class="{ stale: n.stale }">{{ duration(n.ageMs) }}</td>
            <td>
              <StatusPill v-bind="statusOf(n)" />
            </td>
          </tr>
          <tr v-if="!filtered.length">
            <td colspan="8" class="empty">没有匹配的节点。</td>
          </tr>
        </tbody>
      </table>
    </div>

    <NodeDrawer :node="selectedNode" @close="selected = null" />
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.search { width: 260px; }
.check { display: flex; align-items: center; gap: 5px; font-size: 13px; color: var(--text-muted); }
.count { margin-left: auto; font-size: 12.5px; }
.readonly { color: var(--warn); cursor: help; font-size: 12.5px; }

.row { cursor: pointer; }
.row:hover { background: var(--bg-sunken); }

.node-id { font-size: 13px; }
.base { font-size: 11.5px; }

.caps { display: flex; gap: 5px; flex-wrap: wrap; padding-top: 12px; }
.cap {
  font-size: 11.5px;
  background: var(--bg-sunken);
  color: var(--text-muted);
  border-radius: 3px;
  padding: 1px 6px;
  white-space: nowrap;
}
.cap.danger { background: var(--error-soft); color: var(--error); }

.stale { color: var(--warn); font-weight: 500; }
.empty { padding: 24px; text-align: center; color: var(--text-muted); }
</style>
