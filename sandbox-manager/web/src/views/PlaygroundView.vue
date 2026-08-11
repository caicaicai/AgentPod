<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import StatusPill from '@/components/StatusPill.vue'
import { api } from '@/api/client.js'
import { nodes, me, toast, refresh } from '@/store/cluster.js'
import { toBase64, fromBase64, parseNdjson, duration } from '@/utils/format.js'

/**
 * 调试沙盒：在选定节点上真的开一个沙盒跑东西，验证它是不是真能干活。
 *
 * 所有操作都经 manager 转发 —— 节点的 base 是内网地址，而且它不发 CORS 头，
 * 浏览器直连不通。租约凭据也因此全程留在 manager，这里只有一个不透明的
 * sessionId。
 */

const nodeId = ref('')
const session = ref(null)
const busy = ref(false)
const tab = ref('exec')

const candidates = computed(() => nodes.value.filter((n) => n.slots.total > 0))
const selected = computed(() => nodes.value.find((n) => n.nodeId === nodeId.value) || null)
const enabled = computed(() => Boolean(me.value?.canRunSandbox))
const disabledReason = computed(() => {
  if (!me.value) return ''
  if (!me.value.canWrite) return me.value.reason || '没有写权限'
  return me.value.sandboxDisabledReason || ''
})

// ── 会话 ──────────────────────────────────────────────────────────────
async function open() {
  if (!nodeId.value) return
  busy.value = true
  try {
    const res = await api.sandboxOpen(nodeId.value)
    session.value = res
    startKeepalive(res.idleTimeoutMs)
    log('session', `已在 ${res.nodeId} 上开启沙盒，租约 ${res.leaseId}`)
    await refresh()
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    busy.value = false
  }
}

// ── 保活 ──────────────────────────────────────────────────────────────
// 节点侧的租约是"活跃即续"，但那只认请求。人对着一个 snapshot 看两分钟、
// 或者去开个会，页面这边一声不吭，租约就到 idle 被回收了 —— 回来一点按钮
// 全是"租约已过期"，而槽位其实早就还回去了。
//
// 节奏由节点下发的滑动窗口算出来，**不在前端硬编码**：两边各存一份、
// 节点改了配置而页面没改，现象是租约莫名其妙提前消失。
let keepaliveTimer = null
const remainingMs = ref(0)

function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer)
  keepaliveTimer = null
  remainingMs.value = 0
}

function startKeepalive(idleTimeoutMs) {
  stopKeepalive()
  const window = Number(idleTimeoutMs) || 600000
  const period = Math.min(Math.max(Math.floor(window / 3), 30000), 300000)
  remainingMs.value = window
  keepaliveTimer = setInterval(async () => {
    if (!session.value) return stopKeepalive()
    try {
      const res = await api.sandboxCall(session.value.sessionId, 'lease.renew', {})
      remainingMs.value = Number(res?.json?.remainingMs) || 0
    } catch {
      // 单次失败不要紧：续期周期远小于滑动窗口，下一次还有机会。
      // 真的没了会在下一次操作时明确报出来，不必在这里制造一条吓人的提示。
    }
  }, period)
}

const remainingText = computed(() => {
  if (!remainingMs.value) return ''
  const min = Math.floor(remainingMs.value / 60000)
  return min >= 1 ? `剩余约 ${min} 分钟` : '剩余不足 1 分钟'
})

async function close() {
  if (!session.value) return
  busy.value = true
  stopKeepalive()
  const id = session.value.sessionId
  try {
    await api.sandboxClose(id)
    log('session', '沙盒已关闭，槽位已释放')
  } catch (e) {
    toast(`关闭失败：${e.message}`, 'error')
  } finally {
    session.value = null
    busy.value = false
    await refresh()
  }
}

// 离开页面时把沙盒关掉。忘记关的租约会一直占着节点的槽位，直到它自己的
// TTL 到期 —— 一个只有 1 个槽位的节点被这么占住，整个池就没法调度了。
onBeforeUnmount(() => {
  stopKeepalive()
  if (session.value) api.sandboxClose(session.value.sessionId).catch(() => {})
})

// ── 运行记录 ──────────────────────────────────────────────────────────
const entries = ref([])
let seq = 0

function log(kind, text, extra = {}) {
  entries.value.unshift({ id: ++seq, at: Date.now(), kind, text, ...extra })
  if (entries.value.length > 60) entries.value.length = 60
}

async function call(op, payload, describe) {
  if (!session.value) return null
  busy.value = true
  try {
    const res = await api.sandboxCall(session.value.sessionId, op, payload)
    log(op, describe, { result: res })
    return res
  } catch (e) {
    log(op, describe, { error: e.message })
    return null
  } finally {
    busy.value = false
  }
}

// ── 命令 ──────────────────────────────────────────────────────────────
const command = ref('uname -a && whoami && pwd')
const cwd = ref('')
const timeoutMs = ref(30000)

const PRESETS = [
  { label: '基本信息', cmd: 'uname -a; whoami; pwd; ls -la' },
  { label: 'cgroup 限制', cmd: 'cat /proc/self/cgroup; echo ---; cat /sys/fs/cgroup/**/memory.limit_in_bytes 2>/dev/null | head -1' },
  { label: '进程隔离', cmd: 'ps aux | head -20' },
  { label: '出站白名单外应被拦', cmd: 'curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://example.com; echo " ← 000 表示已拦截"' },
  { label: 'Python', cmd: 'python3 -c "import sys; print(sys.version)"' },
  { label: 'Node', cmd: 'node -e "console.log(process.version)"' },
]

async function runCommand() {
  const res = await call(
    'exec',
    { command: command.value, cwd: cwd.value || undefined, timeoutMs: Number(timeoutMs.value) || undefined },
    command.value,
  )
  if (res?.raw) {
    const frames = parseNdjson(res.raw)
    entries.value[0].frames = frames
    entries.value[0].exit = frames.find((f) => f.type === 'exit') || null
  }
}

// ── 文件 ──────────────────────────────────────────────────────────────
const filePath = ref('demo.txt')
const fileContent = ref('hello sandbox\n你好，沙盒\n')

async function writeFile() {
  await call('file.write', { path: filePath.value, contentBase64: toBase64(fileContent.value) },
    `写入 ${filePath.value}`)
}

async function readFile() {
  const res = await call('file.read', { path: filePath.value }, `读取 ${filePath.value}`)
  if (res?.json?.contentBase64) {
    try {
      entries.value[0].detail = fromBase64(res.json.contentBase64)
    } catch {
      entries.value[0].detail = '(二进制内容，无法按文本显示)'
    }
  }
}

// ── 浏览器 ────────────────────────────────────────────────────────────
const browserUrl = ref('https://www.xiaocaicai.com/')
const evalFn = ref('return document.title')

async function browserOpen() {
  await call('browser.open', { url: browserUrl.value }, `打开 ${browserUrl.value}`)
}
async function browserSnapshot() {
  const res = await call('browser.snapshot', {}, 'ARIA 快照')
  if (res?.json?.snapshot) entries.value[0].detail = res.json.snapshot
}
async function browserScreenshot() {
  const res = await call('browser.screenshot', { fullPage: false }, '截图')
  if (res?.json?.contentBase64) entries.value[0].image = `data:image/png;base64,${res.json.contentBase64}`
}
async function browserEvaluate() {
  await call('browser.evaluate', { fn: evalFn.value }, `evaluate: ${evalFn.value}`)
}
async function browserNetwork() {
  await call('browser.network', { limit: 20 }, '网络记录')
}
async function browserClose() {
  await call('browser.close', {}, '关闭浏览器')
}

const browserSupported = computed(() => selected.value?.caps?.browser !== false)

function frameClass(f) {
  if (f.type === 'stderr') return 'err'
  if (f.type === 'error') return 'err'
  if (f.type === 'exit') return 'exit'
  return ''
}
</script>

<template>
  <div>
    <div v-if="!enabled" class="card locked">
      <StatusPill level="warn" text="不可用" />
      <div>
        <div class="title">调试沙盒未开放</div>
        <p class="muted">{{ disabledReason || '当前账号无权使用' }}</p>
        <p class="faint">
          这条路径能在生产机器上执行代码，所以在管理员名单之外还有一道独立开关
          <code>SANDBOX_CONSOLE_EXEC=1</code>。摘除节点改变的是容量，
          这里改变的是「谁能跑代码」，不共用一个开关。
        </p>
      </div>
    </div>

    <template v-else>
      <!-- 会话栏 -->
      <div class="card bar">
        <template v-if="!session">
          <div class="field">
            <label>节点</label>
            <select v-model="nodeId">
              <option value="" disabled>选择一个节点</option>
              <option v-for="n in candidates" :key="n.nodeId" :value="n.nodeId">
                {{ n.nodeId }} · {{ n.pool }} · 空闲 {{ n.slots.free }}/{{ n.slots.total }}{{ n.schedulable ? '' : '（不可调度）' }}
              </option>
            </select>
          </div>
          <button class="primary" :disabled="!nodeId || busy" @click="open">
            {{ busy ? '开启中…' : '开启沙盒' }}
          </button>
          <p class="faint note">
            会在该节点上占用一个槽位，直到你关闭或会话超时。
          </p>
        </template>

        <template v-else>
          <div class="live">
            <StatusPill level="ok" text="运行中" />
            <span class="mono">{{ session.nodeId }}</span>
            <span class="faint mono">{{ session.leaseId }}</span>
            <span v-if="remainingText" class="faint" title="页面在后台自动续期；关掉标签页就停">
              {{ remainingText }}
            </span>
          </div>
          <button class="danger" :disabled="busy" @click="close">关闭并释放</button>
        </template>
      </div>

      <template v-if="session">
        <div class="tabs">
          <button :class="{ on: tab === 'exec' }" @click="tab = 'exec'">命令</button>
          <button :class="{ on: tab === 'files' }" @click="tab = 'files'">文件</button>
          <button :class="{ on: tab === 'browser' }" @click="tab = 'browser'">浏览器</button>
        </div>

        <!-- 命令 -->
        <div v-show="tab === 'exec'" class="card panel">
          <div class="presets">
            <button v-for="p in PRESETS" :key="p.label" @click="command = p.cmd">{{ p.label }}</button>
          </div>
          <textarea v-model="command" rows="3" spellcheck="false" class="mono" />
          <div class="row">
            <label>工作目录 <input v-model="cwd" placeholder="（工作区根目录）" style="width: 160px" /></label>
            <label>超时 <input v-model="timeoutMs" type="number" style="width: 100px" /> ms</label>
            <button class="primary" :disabled="busy" @click="runCommand">
              {{ busy ? '执行中…' : '运行' }}
            </button>
          </div>
          <p class="faint note">
            输出由 manager 缓冲后一次性返回，不是实时流 —— 长时间运行的命令要等它结束才能看到结果。
          </p>
        </div>

        <!-- 文件 -->
        <div v-show="tab === 'files'" class="card panel">
          <div class="row">
            <label style="flex: 1">路径 <input v-model="filePath" placeholder="相对工作区，如 data/a.txt" style="width: 100%" /></label>
          </div>
          <textarea v-model="fileContent" rows="5" spellcheck="false" class="mono" />
          <div class="row">
            <button class="primary" :disabled="busy" @click="writeFile">写入</button>
            <button :disabled="busy" @click="readFile">读取</button>
            <span class="faint note">绝对路径和 <code>../</code> 逃逸都会被节点拒绝。</span>
          </div>
        </div>

        <!-- 浏览器 -->
        <div v-show="tab === 'browser'" class="card panel">
          <div v-if="!browserSupported" class="warn-box">
            该节点未上报浏览器能力，下面的操作大概率会返回 <code>501</code>。
          </div>
          <div class="row">
            <input v-model="browserUrl" placeholder="https://…" style="flex: 1; min-width: 220px" />
            <button class="primary" :disabled="busy" @click="browserOpen">打开</button>
          </div>
          <div class="row">
            <button :disabled="busy" @click="browserSnapshot">ARIA 快照</button>
            <button :disabled="busy" @click="browserScreenshot">截图</button>
            <button :disabled="busy" @click="browserNetwork">网络记录</button>
            <button :disabled="busy" @click="browserClose">关闭浏览器</button>
          </div>
          <div class="row">
            <input v-model="evalFn" class="mono" style="flex: 1; min-width: 220px" />
            <button :disabled="busy" @click="browserEvaluate">evaluate</button>
          </div>
          <p class="faint note">
            沙盒的出站是白名单锁定的，<strong>只有白名单内的地址能打开</strong>，
            其余一律被节点自己的 iptables 拒掉（命令面板里 <code>curl</code> 会报
            <code>Connection refused</code>，exit 7 —— 那是白名单在生效，不是对端拒绝）。
            要放行某个站点，在节点侧配 <code>SANDBOX_EGRESS_ALLOW</code>。
          </p>
        </div>

        <!-- 结果 -->
        <h2 class="section-title" style="margin-top: 22px">运行记录</h2>
        <div v-if="!entries.length" class="card empty">还没有操作。</div>
        <div v-for="e in entries" :key="e.id" class="card entry">
          <header>
            <code class="op">{{ e.kind }}</code>
            <span class="what">{{ e.text }}</span>
            <span v-if="e.exit" :class="['code', e.exit.exitCode === 0 ? 'ok' : 'bad']">
              exit {{ e.exit.exitCode ?? '—' }}
            </span>
            <span v-if="e.result?.durationMs !== undefined" class="faint">{{ duration(e.result.durationMs) }}</span>
          </header>

          <div v-if="e.error" class="err-box">{{ e.error }}</div>

          <pre v-if="e.frames" class="out"><span
            v-for="(f, i) in e.frames" :key="i" :class="frameClass(f)"
          >{{ f.type === 'exit' ? '' : (f.data || f.message || '') }}</span></pre>

          <pre v-else-if="e.detail" class="out">{{ e.detail }}</pre>
          <img v-else-if="e.image" :src="e.image" class="shot" alt="截图" />
          <pre v-else-if="e.result?.json" class="out">{{ JSON.stringify(e.result.json, null, 2) }}</pre>
          <pre v-else-if="e.result?.raw" class="out">{{ e.result.raw }}</pre>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.locked { display: flex; gap: 14px; padding: 18px 20px; align-items: flex-start; }
.locked .title { font-weight: 600; }
.locked p { margin: 4px 0 0; font-size: 13px; line-height: 1.7; }

.bar {
  display: flex;
  align-items: flex-end;
  gap: 14px;
  padding: 14px 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.field { display: flex; flex-direction: column; gap: 5px; min-width: 320px; }
.field > label { font-size: 12px; color: var(--text-muted); }
.field select { width: 100%; }
.live { display: flex; align-items: center; gap: 10px; margin-right: auto; font-size: 13px; }
.note { font-size: 12px; margin: 0; }

.tabs { display: flex; gap: 4px; margin-bottom: -1px; }
.tabs button {
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  border-bottom-color: transparent;
  background: var(--bg-sunken);
  color: var(--text-muted);
}
.tabs button.on { background: var(--bg-elevated); color: var(--accent); border-color: var(--border); }

.panel { padding: 16px; display: flex; flex-direction: column; gap: 12px; border-top-left-radius: 0; }
.presets { display: flex; gap: 6px; flex-wrap: wrap; }
.presets button { font-size: 12px; padding: 3px 9px; }

textarea {
  width: 100%;
  resize: vertical;
  font-size: 12.5px;
  line-height: 1.6;
}
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.row label { display: flex; align-items: center; gap: 6px; color: var(--text-muted); }

.warn-box {
  background: var(--warn-soft);
  color: var(--warn);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}

.entry { padding: 12px 16px; margin-bottom: 10px; }
.entry header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: 13px; }
.entry .op {
  font-size: 11.5px;
  background: var(--bg-sunken);
  color: var(--text-muted);
  border-radius: 3px;
  padding: 1px 6px;
}
.entry .what { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.entry .code { font-size: 12px; font-weight: 600; }
.entry .code.ok { color: var(--ok); }
.entry .code.bad { color: var(--error); }

.out {
  margin: 10px 0 0;
  background: var(--bg-sunken);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  max-height: 380px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.out .err { color: var(--error); }
.out .exit { display: none; }

.err-box {
  margin-top: 8px;
  background: var(--error-soft);
  color: var(--error);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
}

.shot {
  margin-top: 10px;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.empty { padding: 24px; text-align: center; color: var(--text-muted); }
</style>
