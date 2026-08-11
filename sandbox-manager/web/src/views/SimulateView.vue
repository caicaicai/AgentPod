<script setup>
import { ref, computed, onMounted } from 'vue'
import StatusPill from '@/components/StatusPill.vue'
import { api } from '@/api/client.js'
import { pools, config, toast } from '@/store/cluster.js'
import { explainReason } from '@/utils/format.js'

/**
 * 调度试算。
 *
 * 这个页面解决的是一个具体的排查困境：调用方拿到 503「沙盒池当前没有空闲槽位」
 * 时，为什么没有的原因只进了 manager 的日志（scheduler.pick 的 rejected），
 * 而且当时那一刻的快照过后就没了。这里跑的是**同一套挑选逻辑**，把每个节点
 * 被排除的原因摊开。
 *
 * 它有意**不签发票据** —— 否则一个本来只读的运维页面会变成绕过调用方鉴权
 * 拿沙盒执行权限的后门。
 */

const pool = ref('default')
const needBrowser = ref(false)
const limit = ref(3)
const result = ref(null)
const running = ref(false)

onMounted(() => {
  if (config.value?.config?.candidates) limit.value = config.value.config.candidates
})

async function run() {
  running.value = true
  try {
    result.value = await api.simulate({
      pool: pool.value,
      need: needBrowser.value ? { browser: true } : {},
      limit: Number(limit.value),
    })
  } catch (e) {
    result.value = null
    toast(`试算失败：${e.message}`, 'error')
  } finally {
    running.value = false
  }
}

const grouped = computed(() => {
  if (!result.value) return []
  const map = new Map()
  for (const r of result.value.rejected || []) {
    const why = r.why || 'unknown'
    if (!map.has(why)) map.set(why, [])
    map.get(why).push(r.nodeId)
  }
  return [...map.entries()]
    .map(([why, ids]) => ({ why, ids }))
    .sort((a, b) => b.ids.length - a.ids.length)
})

const verdict = computed(() => {
  if (!result.value) return null
  const n = result.value.candidates.length
  if (n === 0) return { level: 'error', text: '这次请求会拿到 503 no-capacity' }
  return { level: 'ok', text: `会返回 ${n} 个候选，调用方按顺序试到第一个接住的为止` }
})
</script>

<template>
  <div>
    <div class="card form">
      <div class="field">
        <label>资源池</label>
        <input v-model="pool" list="pool-options" placeholder="default" />
        <datalist id="pool-options">
          <option v-for="p in pools" :key="p.pool" :value="p.pool" />
        </datalist>
      </div>

      <div class="field">
        <label>能力要求</label>
        <label class="check">
          <input type="checkbox" v-model="needBrowser" />
          需要浏览器
        </label>
      </div>

      <div class="field">
        <label>候选数上限</label>
        <input type="number" v-model="limit" min="1" max="10" style="width: 72px" />
      </div>

      <button class="primary" :disabled="running" @click="run">
        {{ running ? '试算中…' : '试算' }}
      </button>
    </div>

    <p class="disclaimer faint">
      跑的是与 <code>POST /api/v1/sandbox/schedule</code> 完全相同的挑选逻辑，
      但<strong>不签发票据</strong>，不占用任何槽位，对线上无副作用。
    </p>

    <template v-if="result">
      <div class="verdict card" :class="verdict.level">
        <StatusPill :level="verdict.level" :text="verdict.level === 'ok' ? '有可用节点' : '无可用节点'" />
        <span>{{ verdict.text }}</span>
      </div>

      <section v-if="result.candidates.length">
        <h2 class="section-title">命中候选（按空闲槽位降序）</h2>
        <div class="card">
          <table>
            <thead>
              <tr><th style="width: 60px">顺序</th><th>节点</th><th>地址</th><th>空闲槽位</th></tr>
            </thead>
            <tbody>
              <tr v-for="c in result.candidates" :key="c.nodeId">
                <td><span class="rank">{{ c.rank }}</span></td>
                <td class="mono">{{ c.nodeId }}</td>
                <td class="mono faint">{{ c.base }}</td>
                <td>{{ c.free }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="grouped.length">
        <h2 class="section-title">被排除的节点（{{ result.rejected.length }}）</h2>
        <div class="card">
          <div v-for="g in grouped" :key="g.why" class="group">
            <div class="why">
              <strong>{{ explainReason(g.why) }}</strong>
              <span class="faint">{{ g.ids.length }} 个</span>
            </div>
            <div class="ids mono">{{ g.ids.join('、') }}</div>
          </div>
        </div>
      </section>

      <p v-if="!result.candidates.length && !grouped.length" class="card empty">
        集群里一个节点都没有 —— 不是被排除，是压根没注册上来。
      </p>
    </template>
  </div>
</template>

<style scoped>
.form {
  display: flex;
  align-items: flex-end;
  gap: 20px;
  padding: 16px;
  flex-wrap: wrap;
}
.field { display: flex; flex-direction: column; gap: 5px; }
.field > label:first-child { font-size: 12px; color: var(--text-muted); }
.check { display: flex; align-items: center; gap: 6px; font-size: 13px; height: 30px; }

.disclaimer { font-size: 12.5px; margin: 10px 2px 20px; }

.verdict {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  margin-bottom: 22px;
  font-size: 13.5px;
}
.verdict.error { border-color: var(--error); }

section { margin-bottom: 24px; }

.rank {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
}

.group { padding: 11px 16px; border-bottom: 1px solid var(--border); }
.group:last-child { border-bottom: none; }
.why { display: flex; gap: 8px; align-items: baseline; font-size: 13px; }
.ids { font-size: 12px; color: var(--text-muted); margin-top: 3px; word-break: break-all; }

.empty { padding: 24px; text-align: center; color: var(--text-muted); }
</style>
