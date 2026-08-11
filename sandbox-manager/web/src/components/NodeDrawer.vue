<script setup>
import { ref, watch, computed, onBeforeUnmount } from 'vue'
import StatusPill from './StatusPill.vue'
import SlotBar from './SlotBar.vue'
import { api } from '@/api/client.js'
import { canWrite, writeBlockedReason, config, refresh, toast } from '@/store/cluster.js'
import { duration, explainReason } from '@/utils/format.js'

/** 字节数 → 人能读的。占用表里 outputBytes 动辄几 MB，裸数字看不出量级。 */
function bytes(n) {
  if (n === null || n === undefined) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const props = defineProps({ node: { type: Object, default: null } })
const emit = defineEmits(['close'])

const reason = ref('')
const busy = ref(false)
/** 待确认的危险操作：null | 'evict' | `kill:<leaseId>` */
const confirming = ref(null)

// ── 槽位占用 ──
// 单独查、单独刷：它不在 /nodes 里（占用是秒级变化的详情，不该塞进每 10 秒
// 全集群广播的那份数据），所以抽屉打开时才拉，关掉就停。
const occupancy = ref(null)
const occupancyError = ref('')
const occupancyLoading = ref(false)
let occupancyTimer = null

async function loadOccupancy(nodeId) {
  if (!nodeId) return
  occupancyLoading.value = true
  try {
    occupancy.value = await api.occupancy(nodeId)
    occupancyError.value = ''
  } catch (e) {
    // 不 toast：这一屏还有别的内容要看，一个够不着的节点不该弹窗打断。
    occupancyError.value = e.message
    occupancy.value = null
  } finally {
    occupancyLoading.value = false
  }
}

function stopPolling() {
  if (occupancyTimer) clearInterval(occupancyTimer)
  occupancyTimer = null
}

watch(() => props.node?.nodeId, (nodeId) => {
  reason.value = ''
  confirming.value = null
  occupancy.value = null
  occupancyError.value = ''
  stopPolling()
  if (!nodeId) return
  loadOccupancy(nodeId)
  // 3 秒：这一屏是用来做"杀不杀"这个决定的，隔十几秒的数据会让人对着
  // 一个早就结束的占用犹豫。只在抽屉开着时轮询，代价可控。
  occupancyTimer = setInterval(() => loadOccupancy(nodeId), 3000)
}, { immediate: true })

onBeforeUnmount(stopPolling)

/**
 * 值得让人多看一眼的占用。
 *
 * 判据有意只用"形状"：长时间没有新请求（调用方多半已经不在了）、跑了很久、
 * 或者输出量大得不正常。命令原文节点是不给的（那是用户数据，见
 * sandbox-worker/src/leases.js 的 inspect），而这几个数字本来就更适合
 * 回答"该不该杀"——跑 8 分钟的 npm install 和跑 8 分钟的死循环，
 * 区别全在这里。
 */
function suspicious(row) {
  if (row.idleMs > 300000) return '超过 5 分钟没有新请求，调用方可能已经不在了'
  if (row.running > 0 && row.execs.some((e) => e.durationMs > 600000)) return '有命令已经跑了 10 分钟以上'
  if (row.execs.some((e) => e.outputBytes > 5 * 1024 * 1024)) return '输出量异常大，可能在刷屏'
  return ''
}

function kill(row) {
  const nodeId = props.node.nodeId
  return run('已强制释放', async () => {
    const res = await api.kill(nodeId, row.leaseId)
    await loadOccupancy(nodeId)
    return res
  })
}

const secretMismatch = computed(() => {
  const fp = props.node?.ticketSecretFp
  const managerFp = config.value?.config?.ticketSecretFp
  if (!fp || !managerFp) return false
  return fp !== managerFp
})

async function run(label, fn) {
  busy.value = true
  try {
    const res = await fn()
    toast(label, 'ok')
    await refresh()
    return res
  } catch (e) {
    toast(`${label}失败：${e.message}`, 'error')
  } finally {
    busy.value = false
    confirming.value = null
  }
}

function drain() {
  const id = props.node.nodeId
  return run('已摘除', async () => {
    const res = await api.drain(id, true, reason.value.trim() || undefined)
    reason.value = ''
    return res
  })
}

function undrain() {
  const id = props.node.nodeId
  return run('已恢复调度', () => api.drain(id, false))
}

function evict() {
  const id = props.node.nodeId
  return run('已从注册表移除', async () => {
    const res = await api.evict(id)
    emit('close')
    return res
  })
}
</script>

<template>
  <Teleport to="body">
    <div v-if="node" class="backdrop" @click.self="emit('close')">
      <aside class="drawer">
        <header>
          <div>
            <div class="title mono">{{ node.nodeId }}</div>
            <div class="faint mono">{{ node.base }}</div>
          </div>
          <button class="close" @click="emit('close')" aria-label="关闭">✕</button>
        </header>

        <div class="body">
          <div class="badges">
            <StatusPill :level="node.schedulable ? 'ok' : 'error'"
              :text="node.schedulable ? '可调度' : `不可调度 · ${explainReason(node.blockedBy)}`" />
            <StatusPill v-if="node.stale" level="warn" text="心跳掉队" />
            <StatusPill v-if="!node.healthy" level="error" text="节点自报不健康" />
          </div>

          <div v-if="secretMismatch" class="alert error">
            <strong>票据密钥与 manager 不一致。</strong>
            这个节点会被正常调度到，但调用方拿票据换租约时全部 401 —— 现象是
            "调度成功但沙盒申请失败"，两边日志各自都正常。
            节点指纹 <code>{{ node.ticketSecretFp }}</code>，
            manager 指纹 <code>{{ config?.config?.ticketSecretFp }}</code>。
          </div>

          <div v-if="node.draining && node.drainSource === 'admin'" class="alert warn">
            <strong>已被运维摘除。</strong>
            操作人 <code>{{ node.drain?.by || '未知' }}</code>
            <template v-if="node.drain?.atMs">，{{ duration(Date.now() - node.drain.atMs) }} 前</template>。
            <template v-if="node.drain?.reason">原因：{{ node.drain.reason }}</template>
            <div class="faint">摘除标记不会自动过期，也不随节点重启消失 —— 要恢复必须手动点下面的按钮。</div>
          </div>

          <div v-else-if="node.draining" class="alert warn">
            <strong>节点自己在停机。</strong>
            这是节点收到 SIGTERM 后主动上报的，不是运维摘除。等它退出即可。
          </div>

          <section>
            <h3 class="section-title">容量</h3>
            <SlotBar :used="node.slots.used" :total="node.slots.total" :inactive="!node.schedulable" />
            <dl>
              <div><dt>活跃租约</dt><dd>{{ node.leases }}</dd></div>
              <div><dt>空闲槽位</dt><dd>{{ node.slots.free }}</dd></div>
              <div><dt>资源池</dt><dd><code>{{ node.pool }}</code></dd></div>
              <div><dt>版本</dt><dd class="mono">{{ node.version || '未上报' }}</dd></div>
            </dl>
          </section>

          <section>
            <h3 class="section-title">
              槽位占用
              <span v-if="occupancyLoading && !occupancy" class="faint">加载中…</span>
            </h3>

            <div v-if="occupancyError" class="alert warn">
              取不到占用详情：{{ occupancyError }}
              <div class="faint">
                占用是<strong>按需向节点直接查</strong>的（不走心跳），所以管理端连不上这台机器时
                这一块就没有内容 —— 上面的容量数字来自心跳，仍然是准的。
              </div>
            </div>

            <p v-else-if="occupancy && !occupancy.occupancy.length" class="hint">
              当前没有槽位被占用。
            </p>

            <div v-else-if="occupancy" class="occupancy">
              <div v-for="row in occupancy.occupancy" :key="row.leaseId" class="occ"
                :class="{ flagged: Boolean(suspicious(row)) }">
                <div class="occ-head">
                  <span class="slot mono">#{{ row.slotIndex }}</span>
                  <strong class="username">{{ row.username || '(未署名)' }}</strong>
                  <StatusPill v-if="row.running > 0" level="ok" :text="`${row.running} 条命令在跑`" />
                  <StatusPill v-else level="neutral" text="空闲中" />
                  <StatusPill v-if="row.browser" level="neutral" text="浏览器已开" />
                  <span class="grow" />
                  <span class="faint">已占用 {{ duration(row.ageMs) }}</span>
                </div>

                <div class="occ-meta mono faint">
                  run <code>{{ row.runId || '—' }}</code> · lease <code>{{ row.leaseId }}</code>
                </div>

                <dl class="occ-stats">
                  <div><dt>空闲</dt><dd :class="{ danger: row.idleMs > 300000 }">{{ duration(row.idleMs) }}</dd></div>
                  <div><dt>命令数</dt><dd>{{ row.execCount }}</dd></div>
                  <div><dt>CPU</dt><dd>{{ row.resources?.cpuUsageUsec != null ? duration(row.resources.cpuUsageUsec / 1000) : '—' }}</dd></div>
                  <div><dt>内存</dt><dd>{{ bytes(row.resources?.memoryBytes) }}</dd></div>
                  <div><dt>进程数</dt><dd>{{ row.resources?.pids ?? '—' }}</dd></div>
                  <div v-if="row.remainingMs"><dt>剩余</dt><dd>{{ duration(row.remainingMs) }}</dd></div>
                </dl>

                <div v-if="row.execs.length" class="occ-execs">
                  <div v-for="e in row.execs" :key="e.execId" class="occ-exec mono">
                    <code>{{ e.execId }}</code>
                    已跑 {{ duration(e.durationMs) }} · 输出 {{ bytes(e.outputBytes) }}
                  </div>
                </div>

                <p v-if="row.egress.length" class="hint faint">
                  租约级放行：<code class="mono">{{ row.egress.join('、') }}</code>
                </p>

                <p v-if="suspicious(row)" class="occ-flag">⚠ {{ suspicious(row) }}</p>

                <div class="occ-actions">
                  <span v-if="!canWrite" class="hint warn-text">{{ writeBlockedReason }}</span>
                  <template v-else-if="confirming !== `kill:${row.leaseId}`">
                    <button class="small" :disabled="busy" @click="confirming = `kill:${row.leaseId}`">
                      强制释放…
                    </button>
                  </template>
                  <template v-else>
                    <span class="hint">
                      释放会把整个槽位<strong>销毁重建</strong>：
                      <code>{{ row.username }}</code> 这一轮在沙盒里产出的、还没同步回工作空间的东西
                      <strong>全部消失</strong>，正在跑的 {{ row.running }} 条命令会被杀掉。
                    </span>
                    <button class="danger small" :disabled="busy" @click="kill(row)">确认释放</button>
                    <button class="small" :disabled="busy" @click="confirming = null">取消</button>
                  </template>
                </div>
              </div>
            </div>

            <p class="hint faint">
              这里不显示命令原文 —— 那是用户数据，与日志遵守同一条规矩。
              要知道"这个人到底在做什么"，拿 <code>runId</code> 去 agent 侧查那一次会话。
            </p>
          </section>

          <section>
            <h3 class="section-title">能力与运行时</h3>
            <dl>
              <div><dt>浏览器</dt><dd>{{ node.caps?.browser ? '支持' : '不支持' }}</dd></div>
              <div>
                <dt>cgroup</dt>
                <dd :class="{ danger: node.caps?.cgroup === 'none' }">
                  {{ node.caps?.cgroup || '未上报' }}
                  <span v-if="node.caps?.cgroup === 'none'" class="faint">（资源限制不生效）</span>
                </dd>
              </div>
              <div><dt>Python</dt><dd>{{ node.caps?.python ? '可用' : '不可用' }}</dd></div>
              <div>
                <dt>密钥指纹</dt>
                <dd class="mono" :class="{ danger: secretMismatch }">{{ node.ticketSecretFp || '未上报（老版本节点）' }}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3 class="section-title">时间</h3>
            <dl>
              <div><dt>距上次心跳</dt><dd :class="{ danger: node.stale }">{{ duration(node.ageMs) }}</dd></div>
              <div v-if="node.registeredAtMs"><dt>注册于</dt><dd>{{ duration(Date.now() - node.registeredAtMs) }} 前</dd></div>
            </dl>
          </section>

          <section>
            <h3 class="section-title">操作</h3>

            <p v-if="!canWrite" class="hint warn-text">{{ writeBlockedReason }}</p>

            <template v-else>
              <div v-if="!node.draining || node.drainSource !== 'admin'" class="action">
                <p class="hint">
                  摘除后不再被调度到，<strong>已有 {{ node.leases }} 个租约会继续跑完</strong>。
                  下线一台机器的正确顺序是：摘除 → 等租约归零 → 关机。
                </p>
                <div class="row">
                  <input v-model="reason" placeholder="原因（会记录，可选）" />
                  <button class="danger" :disabled="busy" @click="drain">摘除</button>
                </div>
              </div>

              <div v-else class="action">
                <p class="hint">恢复后此节点重新参与调度。</p>
                <button class="primary" :disabled="busy" @click="undrain">恢复调度</button>
              </div>

              <div class="action">
                <p class="hint">
                  从注册表移除。<strong>这不是下线手段</strong> ——
                  节点只要还活着，下一次心跳会拿到 409 并立刻重新注册回来，
                  净效果只是把它的负载读数清一遍。真正要下线请用上面的摘除。
                  它唯一有用的场景是清理<strong>已经死了但还没到 30 秒 TTL</strong> 的节点。
                </p>
                <button v-if="confirming !== 'evict'" :disabled="busy" @click="confirming = 'evict'">
                  从注册表移除…
                </button>
                <div v-else class="row">
                  <span class="hint">确认移除 <code>{{ node.nodeId }}</code>？</span>
                  <button class="danger" :disabled="busy" @click="evict">确认</button>
                  <button :disabled="busy" @click="confirming = null">取消</button>
                </div>
              </div>
            </template>
          </section>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.occupancy { display: flex; flex-direction: column; gap: 10px; }
.occ {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--bg-sunken);
}
.occ.flagged { border-color: var(--warn); }
.occ-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.occ-head .slot { font-size: 12px; color: var(--text-muted); }
.occ-head .username { font-size: 14px; }
.occ-head .grow { flex: 1; }
.occ-meta { font-size: 11.5px; margin-top: 4px; word-break: break-all; }
.occ-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(62px, 1fr));
  gap: 6px 12px;
  margin: 8px 0 0;
}
.occ-stats > div { display: flex; flex-direction: column; }
.occ-stats dt { font-size: 11px; color: var(--text-muted); }
.occ-stats dd { margin: 0; font-size: 13px; }
.occ-execs { margin-top: 8px; display: flex; flex-direction: column; gap: 3px; }
.occ-exec { font-size: 11.5px; color: var(--text-muted); }
.occ-flag { font-size: 12px; color: var(--warn); margin: 8px 0 0; }
.occ-actions { margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.occ-actions .hint { flex: 1 1 100%; margin: 0; }
button.small { font-size: 12px; padding: 4px 10px; }

.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(12, 15, 20, 0.4);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}
.drawer {
  width: min(520px, 100vw);
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
}
.title { font-size: 15px; font-weight: 600; }
.close { border: none; background: transparent; padding: 2px 6px; }

.body { flex: 1; overflow-y: auto; padding: 16px 20px 40px; }

.badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }

.alert {
  border-radius: var(--radius-sm);
  padding: 10px 13px;
  font-size: 12.5px;
  line-height: 1.6;
  margin-bottom: 14px;
}
.alert.error { background: var(--error-soft); color: var(--error); }
.alert.warn { background: var(--warn-soft); color: var(--warn); }
.alert .faint { display: block; margin-top: 4px; opacity: 0.85; }

section { margin-bottom: 22px; }

dl { margin: 10px 0 0; display: grid; gap: 6px; }
dl > div { display: flex; gap: 12px; font-size: 13px; }
dt { color: var(--text-muted); min-width: 88px; }
dd { margin: 0; }
dd.danger { color: var(--error); }

.action { margin-bottom: 18px; }
.hint { font-size: 12.5px; color: var(--text-muted); line-height: 1.6; margin: 0 0 8px; }
.warn-text { color: var(--warn); }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.row input { flex: 1; min-width: 160px; }
</style>
