/**
 * 极简指标聚合。生产接 Prometheus / 内部监控时把 recordX 换成打点即可，
 * 调用方不用动。
 *
 * 关键指标（对应设计文档附录 C）：
 *   - run 时长分布、失败原因分布
 *   - token 用量按 username / 模型归因（成本可归因是平台化的前提）
 *   - 上游（llminfo / 模型网关 / 沙盒）失败率
 */
export function createMetrics() {
  const runs = { total: 0, byStatus: new Map(), durations: [] }
  const usageByUser = new Map()
  const usageByModel = new Map()

  function bump(map, key, delta = 1) {
    map.set(key, (map.get(key) || 0) + delta)
  }

  return {
    recordRun({ username, status, durationMs, usage, modelId }) {
      runs.total += 1
      bump(runs.byStatus, status || 'unknown')
      if (Number.isFinite(durationMs)) {
        runs.durations.push(durationMs)
        if (runs.durations.length > 1000) runs.durations.shift()
      }
      if (usage && username) {
        const current = usageByUser.get(username) || { input: 0, output: 0, runs: 0 }
        usageByUser.set(username, {
          input: current.input + (usage.input || 0),
          output: current.output + (usage.output || 0),
          runs: current.runs + 1,
        })
      }
      if (usage && modelId) {
        const current = usageByModel.get(modelId) || { input: 0, output: 0, runs: 0 }
        usageByModel.set(modelId, {
          input: current.input + (usage.input || 0),
          output: current.output + (usage.output || 0),
          runs: current.runs + 1,
        })
      }
    },

    snapshot() {
      const sorted = [...runs.durations].sort((a, b) => a - b)
      const pick = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0)
      return {
        runs: {
          total: runs.total,
          byStatus: Object.fromEntries(runs.byStatus),
          durationMs: { p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1] || 0 },
        },
        usageByModel: Object.fromEntries(usageByModel),
        distinctUsers: usageByUser.size,
      }
    },
  }
}
