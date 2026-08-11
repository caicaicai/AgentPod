/**
 * 把模型这条消息的结束原因翻译成给用户看的一句话。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 *
 * 以前只有 `stopReason === 'error'` 被特殊对待，其余一律当正常结束。于是 `'length'`
 * （输出撞上 max_tokens 被砍断）**完全不可见** —— 模型不知道自己被截了，用户不知道，
 * 日志里也没有，调试信息里同样没有。
 *
 * 线上实测到的样子：模型写的 python 文件最后一行停在 `print("接口返回`，
 * 接着连撞 SyntaxError → edit 少传 edits → edit 撞重复文本 → read → edit，
 * 才绕回来把文件补好。7 次工具调用里 5 次是在给这一次截断擦屁股。
 * 而最后给用户的结论是**编的** —— 脚本压根没打印 body，它说"body 为空，建议检查接口文档"。
 *
 * 静默截断是最难查的一类故障：它不像报错，它像模型变笨了。
 *
 * ── 为什么单独成一个模块 ────────────────────────────────────────────
 *
 * 实时那条路（agent/events.js）和历史那条路（sessions/transcript.js）必须**共用同一个
 * 函数**，否则同一轮对话在刷新前后显示的提示会不一样 —— 跟 turnStats 是同一个教训。
 * 这里不 import 任何东西，两边都能安全引用。
 */

/**
 * pi 的 stopReason 取值见 pi-ai/dist/providers/openai-completions.js：
 * finish_reason 'length' → 'length'，'tool_calls' → 'toolUse'，content_filter 等 → 'error'。
 */
const NOTES = {
  length: '模型输出达到 max_tokens 上限被**截断**了 —— 本轮结果可能不完整：'
    + '工具参数可能断在一半，写出来的文件可能少了后半截。建议重说一次，或换用输出上限更大的模型。',
  aborted: '本轮被中止，输出不完整。',
}

/**
 * @param {object} message pi 的助手消息（含 stopReason / errorMessage）
 * @returns {{error: string, warning: string}} 两个都可能是空串
 */
export function describeStop(message) {
  const stopReason = message?.stopReason || ''

  // 模型或网关出错时 pi **不抛异常**，而是正常结束一条 stopReason='error' 的消息。
  // 不把它带出去，界面上就是一个空空的回复气泡。
  if (stopReason === 'error') {
    return { error: message?.errorMessage || '模型调用失败', warning: '' }
  }

  return { error: '', warning: NOTES[stopReason] || '' }
}

/** 给日志用：值得记一笔的结束原因（正常结束的不记，免得刷屏） */
export function isAbnormalStop(stopReason) {
  return Boolean(stopReason) && stopReason !== 'stop' && stopReason !== 'toolUse'
}
