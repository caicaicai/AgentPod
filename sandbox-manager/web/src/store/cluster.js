/**
 * 集群状态：单例轮询 + 全局共享。
 *
 * 沿用主仓的约定 —— 普通 composable，不引 Pinia。这个管理台的状态就是
 * "一份节点快照 + 一份配置快照"，为它装一个状态库不划算。
 */

import { ref, computed, reactive } from 'vue'
import { api, SessionExpiredError, getToken } from '@/api/client.js'

const POLL_MS = 5000
/** 连续失败时退避，别让一个挂掉的后端被前端持续锤。 */
const BACKOFF_MS = [5000, 10000, 20000, 30000, 60000]

export const nodes = ref([])
export const pools = ref([])
export const summary = ref(null)
export const config = ref(null)
export const me = ref(null)

export const loading = ref(true)
export const error = ref(null)
export const sessionExpired = ref(false)
export const lastUpdatedAt = ref(0)
export const paused = ref(false)

export const toasts = reactive([])
let toastSeq = 0

export function toast(message, level = 'info') {
  const id = ++toastSeq
  toasts.push({ id, message, level })
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id)
    if (i >= 0) toasts.splice(i, 1)
  }, level === 'error' ? 8000 : 4000)
}

export const health = computed(() => {
  const s = summary.value
  if (!s) return { level: 'unknown', text: '加载中' }
  if (s.nodes === 0) return { level: 'error', text: '集群内没有任何节点' }
  if (s.schedulable === 0) return { level: 'error', text: '没有可调度的节点' }
  const failing = (config.value?.checks || []).filter((c) => !c.ok && c.level === 'error')
  if (failing.length) return { level: 'error', text: `${failing.length} 项配置自检未通过` }
  if (s.stale > 0) return { level: 'warn', text: `${s.stale} 个节点心跳掉队` }
  if (s.slotsTotal > 0 && s.slotsUsed / s.slotsTotal >= 0.9) return { level: 'warn', text: '槽位水位超过 90%' }
  return { level: 'ok', text: '正常' }
})

export const utilization = computed(() => {
  const s = summary.value
  if (!s || !s.slotsTotal) return 0
  return s.slotsUsed / s.slotsTotal
})

let timer = null
let failures = 0
let started = false

async function tick() {
  try {
    // 三个接口一起发。串行的话一次轮询要三个往返，页面上会看到分段刷新。
    const [nodesRes, configRes, meRes] = await Promise.all([
      api.nodes(),
      api.config(),
      me.value ? Promise.resolve({ ...me.value, __cached: true }) : api.whoami(),
    ])

    nodes.value = nodesRes.nodes || []
    pools.value = nodesRes.pools || []
    summary.value = nodesRes.summary || null
    config.value = configRes
    if (!meRes.__cached) me.value = meRes

    lastUpdatedAt.value = Date.now()
    error.value = null
    sessionExpired.value = false
    failures = 0
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      // 登录态没了就停轮询：继续打只会刷一屏 401。
      sessionExpired.value = true
      stop()
      return
    }
    failures += 1
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function schedule() {
  clearTimeout(timer)
  if (paused.value) return
  const delay = failures > 0 ? BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)] : POLL_MS
  timer = setTimeout(async () => {
    await tick()
    schedule()
  }, delay)
}

/** 立即拉一次（写操作之后调，别让人等一个轮询周期才看到结果）。 */
export async function refresh() {
  await tick()
  schedule()
}

export function stop() {
  clearTimeout(timer)
  timer = null
}

export function start() {
  if (started) return
  started = true

  // 没有 token 时不启动轮询，等登录后再调 start
  if (!getToken()) {
    sessionExpired.value = true
    loading.value = false
    return
  }

  document.addEventListener('visibilitychange', () => {
    paused.value = document.hidden
    if (document.hidden) {
      stop()
    } else if (!sessionExpired.value) {
      refresh()
    }
  })

  refresh()
}

/** 登录成功后重置状态并开始轮询。 */
export function onLogin() {
  sessionExpired.value = false
  loading.value = true
  error.value = null
  failures = 0
  started = false
  start()
}

export const canWrite = computed(() => Boolean(me.value?.canWrite))
export const writeBlockedReason = computed(() => me.value?.reason || '没有写权限')
