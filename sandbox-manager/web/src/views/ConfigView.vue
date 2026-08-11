<script setup>
import { computed } from 'vue'
import StatusPill from '@/components/StatusPill.vue'
import { config, nodes } from '@/store/cluster.js'
import { duration } from '@/utils/format.js'

const cfg = computed(() => config.value?.config || {})
const checks = computed(() => {
  const list = config.value?.checks || []
  // 没通过的排前面：这一屏大部分时候是全绿的，翻着找那一条红的很费劲。
  return [...list].sort((a, b) => Number(a.ok) - Number(b.ok))
})

const eg = computed(() => config.value?.egress || {})
const targets = (list) => (list || []).map((t) => `${t.host}:${(t.ports || []).join('/')}`)

/** 密钥指纹横向比对表：manager 一行，每个不同的节点指纹一行。 */
const fingerprints = computed(() => {
  const managerFp = cfg.value.ticketSecretFp
  const groups = new Map()
  for (const n of nodes.value) {
    const fp = n.ticketSecretFp || '(未上报)'
    if (!groups.has(fp)) groups.set(fp, [])
    groups.get(fp).push(n.nodeId)
  }
  return [...groups.entries()]
    .map(([fp, ids]) => ({
      fingerprint: fp,
      nodes: ids,
      matches: fp === managerFp,
      unknown: fp === '(未上报)',
    }))
    .sort((a, b) => Number(b.matches) - Number(a.matches))
})
</script>

<template>
  <div v-if="config">
    <section>
      <h2 class="section-title">自检</h2>
      <div class="card">
        <div v-for="c in checks" :key="c.id" class="check" :class="{ failed: !c.ok }">
          <StatusPill
            :level="c.ok ? 'ok' : c.level === 'error' ? 'error' : 'warn'"
            :text="c.ok ? '通过' : c.level === 'error' ? '错误' : '注意'" />
          <div class="text">
            <code class="id">{{ c.id }}</code>
            <div class="message">{{ c.message }}</div>
          </div>
        </div>
      </div>
    </section>

    <section>
      <h2 class="section-title">Manager 配置</h2>
      <div class="card grid">
        <div><dt>环境前缀</dt><dd><code>{{ cfg.env }}</code> <span class="faint">JIMDB 键前缀 sbx:{{ cfg.env }}:</span></dd></div>
        <div><dt>心跳间隔</dt><dd>{{ duration(cfg.heartbeatIntervalMs) }} <span class="faint">下发给节点</span></dd></div>
        <div><dt>节点 TTL</dt><dd>{{ duration(cfg.staleAfterMs) }} <span class="faint">超过就从集群里消失</span></dd></div>
        <div><dt>票据有效期</dt><dd>{{ duration(cfg.ticketTtlMs) }}</dd></div>
        <div><dt>候选数上限</dt><dd>{{ cfg.candidates }} <span class="faint">每次调度返回</span></dd></div>
        <div>
          <dt>管理台写权限</dt>
          <dd>
            <template v-if="cfg.consoleAdmins > 0">{{ cfg.consoleAdmins }} 个账号</template>
            <template v-else><span class="warn-text">未配置，写操作全部禁用</span></template>
            <span class="faint">SANDBOX_CONSOLE_ADMINS</span>
          </dd>
        </div>
      </div>
    </section>

    <section>
      <h2 class="section-title">沙盒出站策略</h2>
      <p class="note faint">
        拦不拦、拦的话放行谁，<strong>由管理端一处配置</strong>，随注册与心跳下发到所有节点。
        改完环境变量一个心跳周期内全集群跟上，不用重启节点。
        出站白名单是整套凭据边界的地基 —— 沙盒里跑的是模型生成的任意代码，
        它拿得到用户登录态，<strong>能连出去就能被带走</strong>。
      </p>
      <div class="card grid">
        <div>
          <dt>拦截模式</dt>
          <dd>
            <StatusPill
              :level="eg.mode === 'allowlist' ? 'ok' : 'error'"
              :text="eg.mode === 'allowlist' ? '拦截中' : '已关闭'" />
            <span class="faint">SANDBOX_EGRESS_MODE</span>
          </dd>
        </div>
        <div><dt>策略版本</dt><dd><code>{{ eg.revision }}</code> <span class="faint">内容的 sha256 前 8 位</span></dd></div>
        <div>
          <dt>节点应用情况</dt>
          <dd>
            {{ eg.nodesApplied }} 已应用
            <span v-if="eg.nodesDrifted?.length" class="warn-text">/ {{ eg.nodesDrifted.length }} 落后</span>
            <span v-if="eg.nodesUnknown" class="faint">/ {{ eg.nodesUnknown }} 未上报</span>
          </dd>
        </div>
        <div>
          <dt>常开目标</dt>
          <dd>
            <template v-if="targets(eg.allow).length"><code class="mono">{{ targets(eg.allow).join('、') }}</code></template>
            <template v-else><span class="faint">无（只放行 DNS + Cloud Bridge）</span></template>
          </dd>
        </div>
        <div>
          <dt>租约可申请</dt>
          <dd>
            <template v-if="targets(eg.leaseAllow).length"><code class="mono">{{ targets(eg.leaseAllow).join('、') }}</code></template>
            <template v-else><span class="faint">空 —— 一条也不能申请</span></template>
          </dd>
        </div>
      </div>
      <p v-if="eg.nodesPending?.length" class="note faint">
        {{ eg.nodesPending.length }} 个节点收到了新策略但还有 slot 没换上。
        <strong>正在被租用的 slot 是刻意不中途改的</strong> —— 中途重编排会冲掉它自己申请的
        租约级放行。等租约释放、slot 重建时自然生效，不需要干预。
      </p>
    </section>

    <section>
      <h2 class="section-title">票据密钥指纹</h2>
      <p class="note faint">
        指纹是密钥的 sha256 前 8 位，不可逆。manager 和节点的
        <code>SANDBOX_TICKET_SECRET</code> 不一致时，现象是<strong>调度成功但所有租约申请 401</strong>，
        两边各自的日志都完全正常 —— 横向比一遍指纹是唯一能一眼看出来的办法。
      </p>
      <div class="card">
        <table>
          <thead>
            <tr><th style="width: 130px">指纹</th><th style="width: 90px">一致</th><th>持有者</th></tr>
          </thead>
          <tbody>
            <tr>
              <td class="mono">{{ cfg.ticketSecretFp }}</td>
              <td><StatusPill level="ok" text="基准" /></td>
              <td class="faint">manager 本身</td>
            </tr>
            <tr v-for="g in fingerprints" :key="g.fingerprint" :class="{ bad: !g.matches && !g.unknown }">
              <td class="mono">{{ g.fingerprint }}</td>
              <td>
                <StatusPill v-if="g.matches" level="ok" text="一致" />
                <StatusPill v-else-if="g.unknown" level="neutral" text="未上报" />
                <StatusPill v-else level="error" text="不一致" />
              </td>
              <td class="mono nodes">{{ g.nodes.join('、') }}</td>
            </tr>
            <tr v-if="!fingerprints.length">
              <td colspan="3" class="empty">集群里还没有节点。</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="fingerprints.some((g) => g.unknown)" class="note faint">
        「未上报」是 0.3.1 之前的老节点 —— 它们没有在心跳里带指纹，
        <strong>不代表配错了</strong>。升级节点后这一行会自动归位。
      </p>
    </section>
  </div>
</template>

<style scoped>
section { margin-bottom: 26px; }

.check {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border);
}
.check:last-child { border-bottom: none; }
.check.failed { background: var(--bg-sunken); }
.check .text { flex: 1; }
.check .id { font-size: 11.5px; color: var(--text-faint); }
.check .message { font-size: 13px; margin-top: 1px; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px 24px;
  padding: 16px;
}
.grid > div { display: flex; flex-direction: column; gap: 2px; }
dt { font-size: 12px; color: var(--text-muted); }
dd { margin: 0; font-size: 13.5px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
dd .faint { font-size: 11.5px; }
.warn-text { color: var(--warn); }

.note { font-size: 12.5px; line-height: 1.6; margin: 0 2px 12px; }
tr.bad { background: var(--error-soft); }
.nodes { font-size: 12px; word-break: break-all; }
.empty { padding: 20px; text-align: center; color: var(--text-muted); }
</style>
