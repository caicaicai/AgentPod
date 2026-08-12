/**
 * 询问框（取代 window.prompt / confirm）。
 *
 * 这一层唯一真正的风险是**那个 Promise 悬着不兑现** —— 界面上表现为
 * "点了取消，但是什么都没发生"，而调用点还在 await。所以每条路径都要落地：
 * 确认、取消、以及"上一个还开着又开了一个"。
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { askConfirm, askText, cancelDialog, confirmDialog, dialog } from '../web/src/lib/dialog.js'

afterEach(() => {
  // 用例之间别互相污染：没关的框会把下一个 open 的"先兑现上一个"逻辑带跑
  if (dialog.open) cancelDialog()
})

describe('确认框', () => {
  test('确认回 true，取消回 false', async () => {
    const yes = askConfirm({ title: '删除会话' })
    confirmDialog()
    assert.equal(await yes, true)

    const no = askConfirm({ title: '删除会话' })
    cancelDialog()
    assert.equal(await no, false)
  })

  test('打开时把配置摆进状态，危险操作带标记', () => {
    askConfirm({ title: '删除作品', message: '不可恢复', confirmText: '删除', danger: true })
    assert.equal(dialog.open, true)
    assert.equal(dialog.kind, 'confirm')
    assert.equal(dialog.title, '删除作品')
    assert.equal(dialog.danger, true)
    assert.equal(dialog.confirmText, '删除')
  })
})

describe('输入框', () => {
  test('确认回输入的字，且两头空白被去掉', async () => {
    const asked = askText({ title: '新建项目' })
    dialog.value = '  结算中台  '
    confirmDialog()
    assert.equal(await asked, '结算中台')
  })

  /**
   * 取消回 `null` 而不是空串：调用点要能分开"用户取消了"和"用户清空了内容"。
   * 重命名那处就靠这个 —— 回空串会被当成"改成空标题"。
   */
  test('取消回 null，不是空串', async () => {
    const asked = askText({ title: '重命名会话', value: '原来的名字' })
    cancelDialog()
    assert.equal(await asked, null)
  })

  /**
   * 空输入**不静默关掉**：那样用户会以为自己建了个没名字的东西，
   * 而实际上什么都没发生。
   */
  test('空输入不兑现，就地报错等他改', async () => {
    let settled = false
    const asked = askText({ title: '新建项目' }).then((value) => { settled = true; return value })

    dialog.value = '   '
    confirmDialog()
    await Promise.resolve()
    assert.equal(settled, false, '空输入时不该兑现')
    assert.equal(dialog.open, true, '框还开着')
    assert.match(dialog.error, /不能为空/)

    dialog.value = '结算中台'
    confirmDialog()
    assert.equal(await asked, '结算中台')
  })

  test('预填的值进状态，供输入框选中', () => {
    askText({ title: '重命名会话', value: '结算中台', label: '会话名称' })
    assert.equal(dialog.value, '结算中台')
    assert.equal(dialog.label, '会话名称')
  })
})

/**
 * 上一个还开着又开一个：老的必须**当场兑现**（按取消处理）。
 * 不兑现的话那个 Promise 永远悬着 —— 而调用点很可能正 await 着它做后续动作。
 */
describe('叠开', () => {
  test('新的一开，旧的按取消兑现', async () => {
    const first = askConfirm({ title: '第一个' })
    const second = askConfirm({ title: '第二个' })

    assert.equal(await first, false, '旧的按取消落地')
    assert.equal(dialog.title, '第二个')

    confirmDialog()
    assert.equal(await second, true)
  })

  test('上一个是输入框时，旧的按 null 兑现', async () => {
    const first = askText({ title: '第一个' })
    askConfirm({ title: '第二个' })
    assert.equal(await first, null)
  })

  test('每次打开都重置上一次的残留字段', () => {
    askText({ title: '重命名', value: '旧名字', label: '会话名称', danger: false })
    cancelDialog()
    askConfirm({ title: '删除', danger: true })
    assert.equal(dialog.value, '', '上一次的输入不该带到下一个框里')
    assert.equal(dialog.label, '')
    assert.equal(dialog.danger, true)
  })
})
