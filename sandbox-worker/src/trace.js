/**
 * 请求标识：`requestId` 与 `traceId`。
 *
 * 两个 id 各有各的用处，不能只留一个：
 *
 *   - **requestId** 每个 HTTP 请求一个，本进程生成。用来把"这条响应"和
 *     "日志里那几行"对上 —— 用户截个图报错，凭它就能定位。
 *   - **traceId** 跨进程，由最上游生成、逐跳透传。用来把
 *     agent 的一次 run、worker 上的执行、桥的一次出网**串成一条链**。
 *
 * 为什么必须有 traceId：我们让模型在沙盒里跑任意代码，"这条出网请求是谁发的"
 * 是必须答得出的问题。没有跨进程的 id，每一跳的日志都自成一体，
 * 事后只能靠时间戳猜。
 */
import { randomBytes } from 'node:crypto'

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

export function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

/**
 * 取上游带来的 traceId，没有就生成一个。
 *
 * **必须校验格式**：这个值会进日志，也会被原样回写进响应头。
 * 不校验的话，一个带换行的头就能往结构化日志里注入伪造的行
 * （日志注入是真实的攻击手法，不是理论风险）。
 */
export function resolveTraceId(headers = {}) {
  const raw = String(headers['x-trace-id'] || headers['x-request-id'] || '').trim()
  if (raw && ID_PATTERN.test(raw)) return raw
  return newId('trace')
}
