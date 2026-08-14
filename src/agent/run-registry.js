/**
 * 进行中 run 的事件缓冲，用来支持**断线之后接回去**。
 *
 * ── 它解决的是什么 ──────────────────────────────────────────────────────
 *
 * `/v1/chat/stream` 是一条 POST + ReadableStream 的长连接（用 fetch 而不是
 * EventSource，因为后者只能 GET，见 web/src/lib/api.js）。连接一断，服务端的
 * run **照样在跑**（它登记在 run-service 的 active 表里，一直跑到结束），
 * 但客户端再也没有任何入口回到那条流上。
 *
 * 于是用户看到的是：合上笔记本、切个网络、进一趟电梯，这一轮的回答就在界面上
 * 永久消失了 —— 而 token 一个不少地烧完了。刷新页面也救不回来，因为会话正文
 * 要等这一轮**结束**才落库。
 *
 * 这里做的事很朴素：把每一帧按序号存下来，另开一条 `GET /v1/runs/:id/events`
 * 让客户端带着"我收到第几帧了"回来接着听。
 *
 * ── 为什么不直接落库 ────────────────────────────────────────────────────
 *
 * 帧是**每个字都在动**的东西（文本增量一秒几十帧）。写库等于把一次对话变成
 * 几千次 INSERT，而它们的生命周期只有几分钟 —— 这一轮结束之后，权威记录是
 * 会话正文，缓冲里这份就没用了。所以放内存，并且**明确接受它的边界**：
 *
 *   - 只在**本副本**内有效。多副本部署下，重连必须回到同一个副本才接得上
 *     （粘性会话能保证；不能保证时表现为"接不上，回退到刷新页面"）。
 *   - 进程重启就没了。那时 run 本身也没了，语义是一致的。
 *
 * ── 内存是有上限的，而且上限必须真的存在 ────────────────────────────────
 *
 * 一个不设上限的缓冲，等于给"让模型生成一篇超长文档"这个再正常不过的请求
 * 配了一条把进程撑爆的路径。所以三道闸都在：单个 run 的帧数、单个 run 的
 * 字节数、保留的 run 总数。撑爆任何一道就丢掉最老的帧，并把这一段标成
 * `truncated` —— 重连的人会被告知"接不上了，请重新加载会话"，
 * 那是个能说清楚的降级，而不是一段悄悄少了中间几句的回答。
 */

/** 单个 run 最多缓存多少帧。文本增量一秒几十帧，2000 帧足够覆盖几分钟的输出 */
const MAX_FRAMES_PER_RUN = 2000

/** 单个 run 的帧加起来最多多少字节。挡住"帧数不多但每帧很大"的那一类（工具结果） */
const MAX_BYTES_PER_RUN = 4 * 1024 * 1024

/**
 * run 结束之后缓冲再留多久。
 *
 * 留一会儿是必须的：最容易断线的时刻恰恰是**这一轮刚结束**（用户看完就合上盖子），
 * 而那时的重连要拿到的正是 final 帧里那段答案。5 分钟足够一次重连往返，
 * 又不至于让缓冲堆着不放。
 */
const KEEP_FINISHED_MS = 5 * 60 * 1000

/** 总共保留多少个 run 的缓冲（含已结束的）。防的是"高频短 run"把内存堆起来 */
const MAX_RETAINED_RUNS = 200

export function createRunRegistry({
  maxFramesPerRun = MAX_FRAMES_PER_RUN,
  maxBytesPerRun = MAX_BYTES_PER_RUN,
  keepFinishedMs = KEEP_FINISHED_MS,
  maxRetainedRuns = MAX_RETAINED_RUNS,
  now = () => Date.now(),
} = {}) {
  /**
   * runId -> {
   *   username, sessionKey, startedAt, endedAt,
   *   frames: [{ seq, type, data }],  // seq 从 1 开始，全局单调
   *   nextSeq, bytes, truncated, done,
   *   listeners: Set<fn>,
   * }
   */
  const runs = new Map()

  /** 已经可以忘掉的：结束够久了，或者总数超了（超了就先扔最早结束的） */
  function sweep() {
    const at = now()
    for (const [runId, run] of runs) {
      if (run.done && at - run.endedAt > keepFinishedMs) runs.delete(runId)
    }
    if (runs.size <= maxRetainedRuns) return
    /**
     * 淘汰顺序：**已结束的先走，其中结束得早的先走**。还在跑的排在最后 ——
     * 扔掉一个在跑的 run 的缓冲，等于当场废掉它的重连能力，
     * 而那正是这个模块存在的理由。
     */
    const evictable = [...runs.entries()]
      .filter(([, run]) => run.done)
      .sort((a, b) => a[1].endedAt - b[1].endedAt)
    for (const [runId] of evictable.slice(0, runs.size - maxRetainedRuns)) runs.delete(runId)
  }

  /** 丢掉最老的帧直到重新落回上限内。丢过就再也不是完整的了 */
  function trim(run) {
    while (run.frames.length > maxFramesPerRun || run.bytes > maxBytesPerRun) {
      const dropped = run.frames.shift()
      if (!dropped) break
      run.bytes -= dropped.bytes
      run.truncated = true
    }
  }

  return {
    /** run 开始，建缓冲。同一个 runId 重复调用按幂等处理 */
    open({ runId, username, sessionKey = '' }) {
      sweep()
      if (runs.has(runId)) return runs.get(runId)
      const run = {
        runId,
        username,
        sessionKey,
        startedAt: now(),
        endedAt: 0,
        frames: [],
        nextSeq: 1,
        bytes: 0,
        truncated: false,
        done: false,
        listeners: new Set(),
      }
      runs.set(runId, run)
      return run
    },

    /**
     * 记一帧，并推给正在听的人。
     *
     * 返回这一帧的序号 —— 调用方（HTTP 层）要把它一起发给客户端，
     * 客户端才知道自己"收到第几帧了"，重连时拿它当断点。
     */
    append(runId, type, data) {
      const run = runs.get(runId)
      if (!run) return 0

      const frame = { seq: run.nextSeq, type, data }
      run.nextSeq += 1
      /**
       * 按序列化后的长度记账。用 JSON.stringify 量一次是有成本的，但它是
       * 这里唯一一个与"真正占多少内存"相关的数 —— 按帧数算的话，
       * 一帧几百 KB 的工具结果和一帧十个字的增量会被当成一样重。
       */
      frame.bytes = JSON.stringify(data ?? null).length
      run.bytes += frame.bytes
      run.frames.push(frame)
      trim(run)

      for (const listener of run.listeners) {
        // 一个听众抛错不该影响别人，更不该把正在跑的 run 带崩
        try { listener(frame) } catch { /* 下一个 */ }
      }
      return frame.seq
    },

    /** run 结束。缓冲留到 keepFinishedMs 之后才回收 */
    close(runId) {
      const run = runs.get(runId)
      if (!run || run.done) return
      run.done = true
      run.endedAt = now()
      for (const listener of run.listeners) {
        try { listener(null) } catch { /* 下一个 */ }
      }
      run.listeners.clear()
    },

    /**
     * 接回一条流。
     *
     * @param {number} from 客户端已经收到的最后一帧序号（没收到过传 0）
     * @param {(frame|null) => void} listener 收到新帧时调用；run 结束时收到一个 null
     * @returns {null | { replay, truncated, done, unsubscribe }}
     *   `null` = 没有这个 run（已经被回收，或者压根不存在）。
     *   `truncated` = 中间有帧被丢掉了，接不上，调用方应让客户端整体重载。
     */
    subscribe(runId, from, listener) {
      sweep()
      const run = runs.get(runId)
      if (!run) return null

      const oldest = run.frames.length ? run.frames[0].seq : run.nextSeq
      /**
       * 断点比缓冲里最早的那帧还早 —— 中间那段已经被丢掉了，接不回来。
       *
       * 这时**不能假装接上了**：少掉的那几帧里可能有整段文本，
       * 补不上却继续往下发，用户看到的是一段中间缺了几句的回答，
       * 而没有任何迹象表明它缺过。宁可让客户端重新加载会话。
       */
      const gapped = run.truncated && from + 1 < oldest

      const replay = gapped ? [] : run.frames.filter((frame) => frame.seq > from)

      if (run.done) {
        // 已经结束的 run 没有后续帧可听，直接把攒下的给他就行
        return { replay, truncated: gapped, done: true, unsubscribe: () => {} }
      }

      run.listeners.add(listener)
      return {
        replay,
        truncated: gapped,
        done: false,
        unsubscribe: () => run.listeners.delete(listener),
      }
    },

    /** 这个人有哪些还在跑（或刚跑完还留着）的 run。界面刷新后靠它找回断掉的那条 */
    listFor(username, { sessionKey = '' } = {}) {
      sweep()
      return [...runs.values()]
        .filter((run) => run.username === username)
        .filter((run) => !sessionKey || run.sessionKey === sessionKey)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((run) => ({
          runId: run.runId,
          sessionKey: run.sessionKey,
          startedAt: run.startedAt,
          endedAt: run.endedAt || 0,
          done: run.done,
          lastSeq: run.nextSeq - 1,
          truncated: run.truncated,
        }))
    },

    /** 给测试和自检用 */
    stats() {
      return {
        runs: runs.size,
        active: [...runs.values()].filter((run) => !run.done).length,
        bytes: [...runs.values()].reduce((sum, run) => sum + run.bytes, 0),
      }
    },
  }
}
