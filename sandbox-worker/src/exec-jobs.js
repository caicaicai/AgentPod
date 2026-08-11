/**
 * 异步执行任务：命令的生命周期与**某一条 HTTP 连接**解绑。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 *
 * 同步 exec 是一条长连接：帧边产生边写进响应，客户端断开就把命令杀掉
 * （server.js 里的 `req.on('close')`）。在桌面端那是对的 —— 连接断了就是
 * 用户关了窗口，没人要结果了。
 *
 * 但 B/S 之后"断开"不再等于"放弃"：浏览器切个标签页、网络抖一下、
 * 网关掐一次空闲连接，一条跑了四分钟的 `npm install` 就白跑了，而且
 * **工作区里留下的是半装完的 node_modules**，比彻底没跑还糟。
 *
 * 所以这里把两件事分开：
 *   - **断开** → 什么也不做，命令继续跑，输出攒在缓冲区里等人回来取
 *   - **放弃** → 调用方显式 `DELETE .../execs/{execId}`，这才杀
 *
 * ── 为什么可以把输出全留在内存里 ────────────────────────────────────
 *
 * `executor.js` 已经在 `EXEC_MAX_OUTPUT_BYTES`（默认 1 MiB）处截断，
 * 所以一个任务的帧总量天然有上限。这条既有的约束让"断线续传"不需要环形
 * 缓冲、不需要处理"要的那段已经被冲掉了"的 gap 分支 —— 少一整条错误路径。
 */
import { randomBytes } from 'node:crypto'

/** 与 xbox 的 `exe_` 前缀同形，便于两边日志对照 */
function newExecId() {
  return `exe_${randomBytes(8).toString('hex')}`
}

export function createExecJobs({ config, logger }) {
  /**
   * 任务挂在**租约对象**上（`lease.execs`），不是本模块自己的全局表。
   *
   * 这样它的寿命天然跟着租约走：租约一释放，slot 被销毁重建、工作区没了，
   * 那些任务的输出再留着也没有意义，而 Map 随租约对象一起被回收，
   * 不需要任何清理任务，也不可能漏。
   */
  function bucket(lease) {
    if (!lease.execs) lease.execs = new Map()
    return lease.execs
  }

  /**
   * 只保留最近若干个**已结束**的任务。
   *
   * 内存上界 = EXEC_RETAIN_JOBS × EXEC_MAX_OUTPUT_BYTES（默认 8 × 1 MiB）
   * 每租约。正在跑的永远不淘汰 —— 淘汰一个还在跑的任务等于让它的输出凭空消失。
   */
  function evictOld(lease) {
    const jobs = bucket(lease)
    const finished = [...jobs.values()].filter((job) => job.status !== 'running')
    const excess = finished.length - config.exec.retainJobs
    if (excess <= 0) return
    finished.sort((a, b) => a.finishedAt - b.finishedAt)
    for (let i = 0; i < excess; i += 1) jobs.delete(finished[i].execId)
  }

  return {
    /**
     * 起一个异步任务，立刻返回句柄。
     *
     * @param run `({ onFrame, signal }) => Promise<result>` —— 通常是 execCommand
     */
    start(lease, run) {
      const job = {
        execId: newExecId(),
        status: 'running',
        startedAt: Date.now(),
        finishedAt: 0,
        frames: [],
        /**
         * 已产出的字节数。管控台靠它区分"卡住了"和"正在疯狂刷输出"——
         * 两者都表现为"跑了很久还没结束"，处理方式却相反。
         * **只累计长度，不留内容** —— 输出是用户数据。
         */
        outputBytes: 0,
        nextSeq: 1,
        result: null,
        controller: new AbortController(),
        subscribers: new Set(),
      }

      const emit = (frame) => {
        const stamped = { ...frame, seq: job.nextSeq }
        if (typeof frame.data === 'string') job.outputBytes += Buffer.byteLength(frame.data)
        job.nextSeq += 1
        job.frames.push(stamped)
        for (const sink of job.subscribers) {
          try {
            sink(stamped)
          } catch (error) {
            // 一个订阅者写失败（连接已经断了）不能影响别人，也不能影响命令本身
            logger.warn('推送执行帧失败', { execId: job.execId, err: error?.message })
          }
        }
      }

      // 注册进租约的 running 集合：释放租约时会 abort 它（leases.js），
      // sweep 也据此认定"这个租约正在干活，别回收"。
      lease.running.add(job.controller)
      lease.execCount += 1

      job.done = run({ onFrame: emit, signal: job.controller.signal })
        .then((result) => {
          job.result = { ...result, error: null }
          job.status = result.aborted ? 'aborted' : 'completed'
        })
        .catch((error) => {
          // 执行期的错误走帧，不走 HTTP 状态码：这条流可能早就 200 了
          emit({ type: 'error', code: error?.code || 'EXEC_FAILED', message: error?.message || String(error) })
          job.result = { exitCode: null, signal: null, truncated: false, durationMs: Date.now() - job.startedAt }
          job.status = 'failed'
        })
        .finally(() => {
          job.finishedAt = Date.now()
          // 终止帧一定要进缓冲区，不能只推给当前订阅者 —— 断线的客户端回来
          // 靠的就是它才知道命令已经结束、退出码是多少。
          emit({
            type: 'exit',
            exitCode: job.result?.exitCode ?? null,
            signal: job.result?.signal ?? null,
            truncated: Boolean(job.result?.truncated),
            durationMs: job.result?.durationMs ?? Date.now() - job.startedAt,
            status: job.status,
          })
          lease.running.delete(job.controller)
          job.subscribers.clear()
          evictOld(lease)
        })

      bucket(lease).set(job.execId, job)
      evictOld(lease)
      return job
    },

    get(lease, execId) {
      return bucket(lease).get(execId) || null
    },

    list(lease) {
      return [...bucket(lease).values()].map((job) => ({
        execId: job.execId,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt || null,
        frames: job.frames.length,
        outputBytes: job.outputBytes,
      }))
    },

    /** 显式放弃。与"连接断了"是两件事，只有这里才杀命令。 */
    abort(job) {
      if (job.status !== 'running') return false
      job.controller.abort()
      return true
    },

    /**
     * 订阅。先把 `fromSeq` 之后已经攒下的帧补齐，再挂上实时推送。
     *
     * 补历史和挂订阅之间**不能有 await** —— 中间产生的帧会既不在历史里、
     * 也没被推送，客户端那边表现为输出凭空少了一段。
     */
    subscribe(job, fromSeq, sink) {
      for (const frame of job.frames) {
        if (frame.seq > fromSeq) sink(frame)
      }
      if (job.status !== 'running') return () => {}
      job.subscribers.add(sink)
      return () => job.subscribers.delete(sink)
    },
  }
}
