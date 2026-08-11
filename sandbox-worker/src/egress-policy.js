/**
 * 出站策略：**本节点当前认为的**"拦不拦、拦的话放行谁"。
 *
 * ── 为什么这个决定不放在节点上 ──────────────────────────────────
 *
 * 出站白名单是整套凭据边界的地基：沙盒里跑的是模型生成的任意代码，它拿得到
 * 用户登录态，只要能连出去，凭据就能被带走。所以"要不要拦"这个开关放在哪里
 * 本身就是一个安全决定 ——
 *
 *   * 放在节点上 → N 台机器 N 份配置。"到底哪几台还开着拦截"没有单一答案，
 *     改错一台就是一个只在那台机器上成立的洞，而集群从外面看一切正常；
 *   * 放在管理端 → 一处生效、一处可审计，节点只负责执行。
 *
 * 所以接了管理端之后，**节点侧的 `SANDBOX_EGRESS_*` 全部失效**，以下发为准。
 * 不做合并 —— 两个来源合并出来的结果，出了事没人能一眼说清是谁贡献的那一条。
 *
 * ── 三条不能动的规则 ────────────────────────────────────────────
 *
 * 1. **默认拦。** 还没收到下发时按本地 env（其默认值也是拦）。管理端不可达、
 *    响应读不懂、字段缺失 —— 每一种"不知道该怎么办"都往收紧那一侧倒。
 * 2. **拿到过就不回退。** 管理端说过 open 之后又联系不上了，不把策略改回拦 ——
 *    正在跑的技能会在半途集体断网，而原因（管理端抖了一下）根本不在现场。
 *    最后一次明确下发一直有效，直到下一次明确下发。
 * 3. **比对内容，不比对版本号。** `revision` 只用于上报和排查；判断变没变一律
 *    按归一化之后的内容算。管理端算错版本号是可能的，那种情况下按内容比对
 *    只是多做一次幂等的重编程，按版本号比对则是策略静默不生效。
 */
import { parseEgressAllow, normalizeEgressEntries } from './namespace/netns.js'

/** 归一化之后的内容签名。排序过，所以改环境变量里的顺序不会被当成策略变更。 */
function signature(policy) {
  const targets = (list) => list
    .map((entry) => `${entry.host}:${entry.ports.join('/')}`)
    .sort()
    .join(',')
  return `${policy.enforce ? 'allowlist' : 'open'}|${targets(policy.allow)}|${targets(policy.leaseAllow)}`
}

export function createEgressPolicyStore({ config, logger }) {
  let policy = {
    enforce: config.namespace.egressMode !== 'open',
    allow: parseEgressAllow(config.namespace.egressAllow),
    leaseAllow: parseEgressAllow(config.namespace.egressLeaseAllow),
    source: 'env',
    revision: '',
  }
  policy.signature = signature(policy)

  return {
    current() { return policy },

    /**
     * 收下管理端在注册/心跳响应里带的 `egress`。
     *
     * @returns {{changed: boolean, policy: object, reason: string}}
     *   `changed=false` 时调用方什么都不用做 —— 心跳每 10 秒一次，绝大多数时候
     *   走的都是这条路，不该每次都去动 iptables。
     */
    update(incoming) {
      // 字段整个缺席 = 这个管理端不认识出站策略（老版本）。**保持现状，不重置成
      // 本地 env。** 否则升级管理端的顺序会决定节点的隔离强度，而这层因果关系
      // 没有任何人会想到。
      if (!incoming || typeof incoming !== 'object') {
        return { changed: false, policy, reason: 'absent' }
      }

      // mode 读不懂就按拦处理。这里是整个文件里最重要的一行默认值：
      // 只有明明白白写着 open 才放开，其余（缺字段、拼错、类型不对）一律拦。
      const enforce = incoming.mode !== 'open'
      const next = {
        enforce,
        allow: normalizeEgressEntries(incoming.allow),
        leaseAllow: normalizeEgressEntries(incoming.leaseAllow),
        source: 'manager',
        revision: typeof incoming.revision === 'string' ? incoming.revision.slice(0, 32) : '',
      }
      next.signature = signature(next)

      if (next.signature === policy.signature && policy.source === 'manager') {
        // 版本号变了但内容没变（管理端改了个不影响出站的配置）也走这里：
        // 记下新版本号好让上报对得上，但不重编程。
        if (next.revision !== policy.revision) policy = { ...policy, revision: next.revision }
        return { changed: false, policy, reason: 'unchanged' }
      }

      const previous = policy
      policy = next
      return { changed: true, policy, reason: previous.source === 'env' ? 'adopted' : 'updated' }
    },

    /** 给心跳上报与 /healthz 用。**不含放行目标的主机名** —— 见 slot-pool.js 的 status()。 */
    describe() {
      return {
        mode: policy.enforce ? 'allowlist' : 'open',
        source: policy.source,
        revision: policy.revision,
        allowCount: policy.allow.length,
        leaseAllowCount: policy.leaseAllow.length,
      }
    },

    /** 启动日志用：把当前策略说清楚，尤其是"没拦"这件事。 */
    announce() {
      if (policy.enforce) {
        logger.info('沙盒出站拦截已启用', {
          source: policy.source,
          extraAllowed: policy.allow.map((e) => `${e.host}:${e.ports.join('/')}`),
        })
      } else {
        logger.error('沙盒出站拦截已关闭：沙盒可访问本机能访问的任意网络目标，用户登录态可被带出', {
          source: policy.source,
          revision: policy.revision,
        })
      }
    },
  }
}

export const _internal = { signature }
