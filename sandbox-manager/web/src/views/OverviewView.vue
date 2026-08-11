<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import StatCard from '@/components/StatCard.vue'
import SlotBar from '@/components/SlotBar.vue'
import StatusPill from '@/components/StatusPill.vue'
import { summary, pools, nodes, config, utilization } from '@/store/cluster.js'
import { percent, duration, explainReason } from '@/utils/format.js'

const router = useRouter()

const utilLevel = computed(() => {
  if (utilization.value >= 0.95) return 'error'
  if (utilization.value >= 0.85) return 'warn'
  return ''
})

/**
 * 需要人看一眼的东西，按"会不会导致请求失败"排序。
 *
 * 这一段是这个页面存在的理由：没有它，运维要在节点表、配置页、调度日志
 * 之间来回跳才能拼出"现在有没有问题"。
 */
const attention = computed(() => {
  const items = []
  const s = summary.value
  if (!s) return items

  for (const c of config.value?.checks || []) {
    if (!c.ok) items.push({ level: c.level, title: '配置自检未通过', detail: c.message, to: '/config' })
  }

  if (s.nodes === 0) {
    items.push({ level: 'error', title: '集群内没有任何节点', detail: '节点未注册，或 SANDBOX_ENV 前缀与节点侧不一致', to: '/config' })
  } else if (s.schedulable === 0) {
    items.push({ level: 'error', title: '没有可调度的节点', detail: '所有调度请求都会拿到 503 no-capacity', to: '/simulate' })
  }

  const stale = nodes.value.filter((n) => n.stale)
  if (stale.length) {
    items.push({
      level: 'warn',
      title: `${stale.length} 个节点心跳掉队`,
      detail: `${stale.map((n) => n.nodeId).join('、')} —— 明细键过期后会直接从集群里消失`,
      to: '/nodes',
    })
  }

  const drained = nodes.value.filter((n) => n.draining && n.drainSource === 'admin')
  if (drained.length) {
    items.push({
      level: 'warn',
      title: `${drained.length} 个节点处于运维摘除状态`,
      detail: `${drained.map((n) => `${n.nodeId}（${n.drain?.by || '未知'}）`).join('、')} —— 摘除标记不会自动过期`,
      to: '/nodes',
    })
  }

  const unhealthy = nodes.value.filter((n) => !n.healthy)
  if (unhealthy.length) {
    items.push({
      level: 'error',
      title: `${unhealthy.length} 个节点自报不健康`,
      detail: unhealthy.map((n) => n.nodeId).join('、'),
      to: '/nodes',
    })
  }

  if (utilization.value >= 0.9 && s.slotsTotal > 0) {
    items.push({
      level: 'warn',
      title: `槽位水位 ${percent(utilization.value)}`,
      detail: '接近满载，调用方会开始撞 429 并轮转候选',
      to: '/nodes',
    })
  }

  const order = { error: 0, warn: 1, info: 2 }
  return items.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3))
})

/** 每个节点当前被什么挡住 —— 汇总一遍，比在表里一行行找快。 */
const blockers = computed(() => {
  const counts = {}
  for (const n of nodes.value) {
    if (n.schedulable) continue
    const why = n.blockedBy || 'unknown'
    counts[why] = (counts[why] || 0) + 1
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
})
</script>

<template>
  <div v-if="summary">
    <div class="stats">
      <StatCard label="节点" :value="summary.nodes" :hint="`${summary.schedulable} 个可调度`"
        :level="summary.schedulable === 0 ? 'error' : ''" />
      <StatCard label="槽位水位" :value="percent(utilization)"
        :hint="`${summary.slotsUsed} / ${summary.slotsTotal}`" :level="utilLevel" />
      <StatCard label="活跃租约" :value="summary.leases" hint="正在执行的沙盒会话" />
      <StatCard label="摘除中" :value="summary.draining"
        :hint="summary.draining ? '不再接新请求，已有租约跑完为止' : '无'"
        :level="summary.draining ? 'warn' : ''" />
      <StatCard label="心跳掉队" :value="summary.stale"
        :hint="summary.stale ? '超过 2× 心跳间隔' : '全部正常'"
        :level="summary.stale ? 'warn' : ''" />
    </div>

    <section v-if="attention.length" class="attention">
      <h2 class="section-title">需要注意</h2>
      <div class="card">
        <div v-for="(item, i) in attention" :key="i" class="item" :class="item.level"
          role="button" tabindex="0" @click="router.push(item.to)" @keyup.enter="router.push(item.to)">
          <StatusPill :level="item.level" :text="item.level === 'error' ? '错误' : '注意'" />
          <div class="body">
            <div class="title">{{ item.title }}</div>
            <div class="detail muted">{{ item.detail }}</div>
          </div>
          <span class="faint arrow">→</span>
        </div>
      </div>
    </section>

    <section v-else class="attention">
      <h2 class="section-title">需要注意</h2>
      <div class="card empty">集群状态正常，没有需要处理的问题。</div>
    </section>

    <section>
      <h2 class="section-title">资源池</h2>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>资源池</th>
              <th>节点</th>
              <th>可调度</th>
              <th style="width: 220px">槽位</th>
              <th>租约</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in pools" :key="p.pool">
              <td><code>{{ p.pool }}</code></td>
              <td>{{ p.nodes }}</td>
              <td>{{ p.schedulable }}</td>
              <td><SlotBar :used="p.slotsUsed" :total="p.slotsTotal" /></td>
              <td>{{ p.leases }}</td>
              <td>
                <StatusPill v-if="p.schedulable === 0" level="error" text="无可用节点" />
                <StatusPill v-else-if="p.slotsTotal && p.slotsUsed / p.slotsTotal >= 0.9" level="warn" text="接近满载" />
                <StatusPill v-else level="ok" text="正常" />
              </td>
            </tr>
            <tr v-if="!pools.length">
              <td colspan="6" class="empty">没有任何资源池 —— 集群里还没有节点注册上来。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="blockers.length">
      <h2 class="section-title">不可调度节点的原因分布</h2>
      <div class="card blockers">
        <div v-for="[why, count] in blockers" :key="why" class="blocker">
          <span class="count">{{ count }}</span>
          <span class="why">{{ explainReason(why) }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}

section { margin-bottom: 24px; }

.item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.item:last-child { border-bottom: none; }
.item:hover { background: var(--bg-sunken); }
.item .body { flex: 1; min-width: 0; }
.item .title { font-weight: 500; }
.item .detail { font-size: 12.5px; margin-top: 1px; }
.item .arrow { align-self: center; }

.empty { padding: 20px 16px; color: var(--text-muted); text-align: center; }

.blockers { display: flex; flex-wrap: wrap; gap: 10px; padding: 14px 16px; }
.blocker {
  display: flex;
  align-items: baseline;
  gap: 6px;
  background: var(--bg-sunken);
  border-radius: var(--radius-sm);
  padding: 5px 11px;
}
.blocker .count { font-weight: 600; font-size: 15px; }
.blocker .why { font-size: 12.5px; color: var(--text-muted); }
</style>
