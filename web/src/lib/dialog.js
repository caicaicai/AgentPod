/**
 * 询问用户：输入一行字，或者确认一件事。
 *
 * ── 为什么要自己做，而不是用 window.prompt / confirm ────────────────────
 *
 * 原生弹框有三个躲不开的问题：
 *   1. **样式完全不受控**，浏览器画什么样就是什么样，深色主题下尤其突兀；
 *   2. **同步阻塞整个页面** —— 流式回复正在往下写的时候弹一个 confirm，
 *      渲染会一起停住；
 *   3. 部分浏览器在跨源 iframe、或者短时间内弹第二次时**直接不显示**，
 *      表现是"点了没反应"，而代码这边还在等一个永远不会来的返回值。
 *
 * ── 为什么是 Promise，而不是给每个调用点写一套状态 ──────────────────────
 *
 * 调用点的代码形状不该因为换了个弹框就变：
 *
 *     if (!window.confirm('删除？')) return        →   if (!await askConfirm(…)) return
 *     const name = window.prompt('项目名称')        →   const name = await askText(…)
 *
 * 一个 Promise 就够了。把 resolve 存进状态里，按钮点下去时兑现它 ——
 * 于是七个调用点各自只改一行，没有一个需要自己管"弹框开着没有"。
 */
import { reactive } from 'vue'

export const dialog = reactive({
  open: false,
  kind: 'confirm', // 'confirm' | 'text'
  title: '',
  message: '',
  label: '',
  value: '',
  placeholder: '',
  confirmText: '确定',
  /** 危险操作（删除、清空）：确认按钮走警示色 */
  danger: false,
  error: '',
})

let pending = null

function settle(result) {
  const resolve = pending
  pending = null
  dialog.open = false
  dialog.error = ''
  resolve?.(result)
}

/**
 * 按"取消"兑现当前这个。
 *
 * ⚠️ **取消值取决于当前开着的那个框是什么类型，不是接下来要开的那个。**
 * 第一版是 `settle(config.kind === 'text' ? null : false)` —— 用新框的类型
 * 决定旧框怎么兑现。于是"输入框还开着又弹了个确认框"时，前者被兑现成 `false`，
 * 而调用点写的是 `title === null ? undefined : renameSession(key, title)` ——
 * `false` 不是 `null`，会话名就被改成了字符串 "false"。
 * （这条是被 test/dialog.test.js 当场抓出来的。）
 */
function cancelPending() {
  settle(dialog.kind === 'text' ? null : false)
}

function openWith(config) {
  if (pending) cancelPending()
  Object.assign(dialog, {
    open: true,
    message: '',
    label: '',
    value: '',
    placeholder: '',
    confirmText: '确定',
    danger: false,
    error: '',
    ...config,
  })
  return new Promise((resolve) => { pending = resolve })
}

/**
 * 要一行文字。
 * @returns {Promise<string|null>} 取消时是 null（与 window.prompt 一致，
 *   这样调用点判"用户取消了"和"用户清空了内容"仍然是两件事）
 */
export function askText(config) {
  return openWith({ kind: 'text', ...config })
}

/** @returns {Promise<boolean>} */
export function askConfirm(config) {
  return openWith({ kind: 'confirm', ...config })
}

export function confirmDialog() {
  if (dialog.kind !== 'text') return settle(true)
  const text = dialog.value.trim()
  // 空输入不静默关掉：那样用户会以为自己建了个没名字的东西
  if (!text) {
    dialog.error = '不能为空'
    return undefined
  }
  return settle(text)
}

export function cancelDialog() {
  cancelPending()
}
