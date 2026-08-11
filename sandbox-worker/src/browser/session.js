/**
 * 一个租约的浏览器会话 = 一个独立的 BrowserContext。
 *
 * 动作实现**全部走 CDP**，而不是 Playwright 的高层 API —— 这是刻意的：
 * 桌面端 `browser-manager.js` 就是这么做的，逐字照搬才能保证两端**行为一致**。
 * 一旦这边改用 `locator.click()`，"AntD 日期框填不进去""受控组件 value 被框架忽略"
 * 这类桌面端已经踩过并修好的坑就会在云端重新出现一遍。
 *
 * 隔离：一个租约一个 BrowserContext（cookie / storage / cache 全独立），
 * 释放时 context.close()。浏览器进程本身是复用的 —— 每次冷启一个 Chromium 要 1–2s，
 * 而 context 的创建是毫秒级，且 context 之间本来就是 Playwright 保证的隔离边界。
 */
import { formatAriaToYaml, buildSelectOptionLocatorExpr } from './aria-snapshot.js'

const DEFAULT_VIEWPORT = { width: 1440, height: 900 }
const NETWORK_LOG_LIMIT = 200
const MAX_SCREENSHOT_HEIGHT = 16000

/** 与桌面端 _actPress 的键位映射保持一致 */
const KEY_MAP = {
  Enter: { keyCode: 13, code: 'Enter', key: 'Enter' },
  Tab: { keyCode: 9, code: 'Tab', key: 'Tab' },
  Escape: { keyCode: 27, code: 'Escape', key: 'Escape' },
  Backspace: { keyCode: 8, code: 'Backspace', key: 'Backspace' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
  Space: { keyCode: 32, code: 'Space', key: ' ' },
}

export class BrowserSession {
  constructor({ context, logger, leaseId, username }) {
    this.context = context
    this.logger = logger
    this.leaseId = leaseId
    this.username = username
    this.page = null
    this.cdp = null
    this.snapshotRefs = {}
    this.network = []
    this.networkSeq = 0
    this.closed = false
  }

  async ensurePage() {
    if (this.page && !this.page.isClosed()) return this.page
    this.page = await this.context.newPage()
    this.cdp = await this.context.newCDPSession(this.page)
    await this.cdp.send('Accessibility.enable').catch(() => {})
    this._trackNetwork()
    return this.page
  }

  _trackNetwork() {
    const push = (entry) => {
      this.network.push(entry)
      if (this.network.length > NETWORK_LOG_LIMIT) this.network.shift()
    }
    this.page.on('request', (request) => {
      this.networkSeq += 1
      push({
        id: `n${this.networkSeq}`,
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        startedAt: Date.now(),
        status: null,
      })
    })
    this.page.on('response', (response) => {
      const entry = [...this.network].reverse().find((item) => item.url === response.url() && item.status === null)
      if (entry) {
        entry.status = response.status()
        entry.durationMs = Date.now() - entry.startedAt
      }
    })
    this.page.on('requestfailed', (request) => {
      const entry = [...this.network].reverse().find((item) => item.url === request.url() && item.status === null)
      if (entry) {
        entry.status = -1
        entry.failure = request.failure()?.errorText || 'failed'
      }
    })
  }

  async open({ url }) {
    if (!url) throw new Error('open 需要 url')
    const page = await this.ensurePage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    return { url: page.url(), title: await page.title() }
  }

  async navigate({ url }) {
    return this.open({ url })
  }

  /**
   * ARIA 快照。用 CDP 的 getFullAXTree + 与桌面端同一个格式化函数，
   * 保证两端产出**逐字相同**的快照格式。
   */
  async snapshot() {
    const page = await this.ensurePage()
    const { nodes } = await this.cdp.send('Accessibility.getFullAXTree')
    const { snapshot, refs } = formatAriaToYaml(nodes)
    this.snapshotRefs = refs
    return {
      snapshot,
      refs,
      refCount: Object.keys(refs).length,
      url: page.url(),
      title: await page.title(),
    }
  }

  async screenshot({ waitMs, fullPage } = {}) {
    const page = await this.ensurePage()
    if (Number.isFinite(waitMs) && waitMs > 0) {
      await page.waitForTimeout(Math.min(waitMs, 30000))
    } else if (waitMs !== 0) {
      // 默认等网络静默：不这么做经常截到 loading 中的页面
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
    }
    const buffer = await page.screenshot({
      fullPage: Boolean(fullPage),
      timeout: fullPage ? 60000 : 15000,
      ...(fullPage ? {} : { clip: undefined }),
    })
    const viewport = page.viewportSize() || DEFAULT_VIEWPORT
    return {
      contentBase64: buffer.toString('base64'),
      sizeBytes: buffer.length,
      url: page.url(),
      title: await page.title(),
      dimensions: { mode: fullPage ? 'fullPage' : 'viewport', width: viewport.width, height: viewport.height, maxHeight: MAX_SCREENSHOT_HEIGHT },
    }
  }

  async content() {
    const page = await this.ensurePage()
    return { url: page.url(), title: await page.title(), html: await page.content() }
  }

  async evaluate({ fn }) {
    if (!fn) throw new Error('evaluate 需要 fn')
    const page = await this.ensurePage()
    // 与桌面端一致：允许顶层 return，并把真实错误信息回给模型
    // （笼统的 "Script failed to execute" 会让模型盲目重试）
    const result = await this.cdp.send('Runtime.evaluate', {
      expression: `(function(){ ${fn} })()`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails
      throw new Error(detail.exception?.description || detail.text || 'evaluate 执行出错')
    }
    return { value: result.result?.value ?? null, url: page.url() }
  }

  async _resolveRefToObjectId(ref) {
    const refData = this.snapshotRefs[ref]
    if (!refData?.backendDOMNodeId) throw new Error(`未知或已失效的 ref "${ref}"，请先重新 snapshot`)
    const result = await this.cdp.send('DOM.resolveNode', { backendNodeId: refData.backendDOMNodeId })
    if (!result?.object?.objectId) throw new Error(`ref "${ref}" 解析不到 DOM 节点，页面可能已变化`)
    return result.object.objectId
  }

  async _centerOf(ref) {
    const refData = this.snapshotRefs[ref]
    // 提示必须告诉模型"下一步该做什么"。只说"未知 ref"它会原地重试同一个 ref。
    if (!refData?.backendDOMNodeId) throw new Error(`未知或已失效的 ref "${ref}"，请先重新 snapshot 再操作`)
    await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: refData.backendDOMNodeId }).catch(() => {})
    const { model } = await this.cdp.send('DOM.getBoxModel', { backendNodeId: refData.backendDOMNodeId })
    const c = model.content
    return { x: (c[0] + c[4]) / 2, y: (c[1] + c[5]) / 2 }
  }

  async act(request = {}) {
    await this.ensurePage()
    const { kind } = request
    if (!kind) throw new Error('act 需要 kind')

    switch (kind) {
      case 'click': return this._click(request)
      case 'type': return this._type(request)
      case 'fill': return this._fill(request)
      case 'press': return this._press(request)
      case 'select': return this._select(request)
      case 'selectOption': return this._selectOption(request)
      case 'hover': return this._hover(request)
      case 'wait': return this._wait(request)
      case 'evaluate': return this.evaluate({ fn: request.fn })
      default: throw new Error(`不支持的 act kind: ${kind}`)
    }
  }

  async _click({ ref, doubleClick }) {
    if (!ref) throw new Error('click 需要 snapshot 给出的 ref')
    const { x, y } = await this._centerOf(ref)
    const clickCount = doubleClick ? 2 : 1
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount })
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount })
    return { clicked: true, ref }
  }

  async _type({ ref, text }) {
    if (!ref) throw new Error('type 需要 ref')
    if (!text) throw new Error('type 需要 text')
    const objectId = await this._resolveRefToObjectId(ref)
    await this.cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function() { this.focus(); }' })
    await this.cdp.send('Input.insertText', { text })
    return { typed: true, ref, text }
  }

  /**
   * 受控组件（AntD / ElementUI 的日期框、输入框）用框架自己的 value tracker 接管了原生 setter，
   * 直接 `this.value = val` 不会被框架感知 —— 这是桌面端"用 JS 改日期框没生效"的根因。
   * 必须走原型链上的原生 setter，框架的 tracker 才会当成真实输入。逐字照搬桌面端实现。
   */
  async _fill({ ref, text }) {
    if (!ref) throw new Error('fill 需要 ref')
    if (text === undefined || text === null) throw new Error('fill 需要 text')
    const objectId = await this._resolveRefToObjectId(ref)
    await this.cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(val) {
        this.focus();
        const proto = (this instanceof HTMLTextAreaElement)
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
        if (setter) { setter.call(this, val); } else { this.value = val; }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      arguments: [{ value: String(text) }],
    })
    return { filled: true, ref, text }
  }

  async _press({ key }) {
    if (!key) throw new Error('press 需要 key')
    const mapped = KEY_MAP[key] || { key, code: key }
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...mapped })
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...mapped })
    return { pressed: true, key }
  }

  /**
   * 原生 `<select>`。两个必须处理的现实：
   *
   * 1. ARIA 快照会把每个 `<option>` 也标上 ref，模型很自然会把选项的 ref 传进来。
   *    所以拿到 option 时要自己往上找 `<select>`，而不是让它白跑一趟。
   * 2. 目标压根不是 select 时**必须报错**。早先的实现是 `for (const o of this.options || [])`，
   *    非 select 就静默循环零次然后回 `{selected:true}` —— 模型收到"成功"却什么都没发生，
   *    接下来的每一步都建立在错误前提上。这类"假成功"比直接失败难查得多。
   */
  async _select({ ref, values }) {
    if (!ref) throw new Error('select 需要 ref')
    if (!Array.isArray(values) || !values.length) throw new Error('select 需要 values')
    const objectId = await this._resolveRefToObjectId(ref)
    const result = await this.cdp.send('Runtime.callFunctionOn', {
      objectId,
      returnByValue: true,
      functionDeclaration: `function(vals) {
        const target = (this.tagName === 'OPTION') ? this.closest('select') : this;
        if (!target || target.tagName !== 'SELECT') {
          return { ok: false, tagName: this.tagName };
        }
        const wanted = new Set(vals.map(String));
        let matched = 0;
        for (const option of target.options) {
          const hit = wanted.has(option.value) || wanted.has((option.textContent || '').trim());
          option.selected = hit;
          if (hit) matched += 1;
        }
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, matched, value: target.value };
      }`,
      arguments: [{ value: values }],
    })
    const outcome = result.result?.value || {}
    if (!outcome.ok) {
      throw new Error(
        `ref "${ref}" 指向的是 <${String(outcome.tagName || '?').toLowerCase()}>，不是原生 <select>。` +
          '自定义下拉（AntD / ElementUI / 级联 / portal 弹层）请用 kind=selectOption。',
      )
    }
    if (!outcome.matched) {
      throw new Error(`没有选项匹配 ${JSON.stringify(values)}；请先 snapshot 确认可选项的文本或 value`)
    }
    return { selected: true, ref, values, matched: outcome.matched, value: outcome.value }
  }

  /** 自定义下拉（AntD / ElementUI / 级联 / portal 弹层）：点触发器 → 等弹层 → 按文本点选项 */
  async _selectOption({ ref, text, exact, openDelayMs }) {
    if (!ref) throw new Error('selectOption 需要触发器的 ref')
    if (!text) throw new Error('selectOption 需要 text')
    await this._click({ ref })
    const delay = Math.min(Math.max(Number(openDelayMs) || 250, 0), 5000)
    await this.page.waitForTimeout(delay)

    const expression = buildSelectOptionLocatorExpr(text, Boolean(exact))
    const located = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true })
    const outcome = JSON.parse(located.result?.value || '{"ok":false}')
    if (!outcome.ok) {
      throw new Error(
        `在弹层里找不到选项 "${text}"（候选 ${outcome.candidateCount ?? 0} 个）。` +
          `${outcome.sample ? `实际可见的前几个：${outcome.sample}` : '弹层可能还没渲染出来，可加大 openDelayMs'}`,
      )
    }
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: outcome.cx, y: outcome.cy, button: 'left', clickCount: 1 })
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: outcome.cx, y: outcome.cy, button: 'left', clickCount: 1 })
    return { selectedOption: true, ref, text, matchedText: outcome.matchedText }
  }

  async _hover({ ref }) {
    if (!ref) throw new Error('hover 需要 ref')
    const { x, y } = await this._centerOf(ref)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    return { hovered: true, ref }
  }

  async _wait({ timeMs }) {
    const ms = Math.min(Math.max(Number(timeMs) || 1000, 0), 30000)
    await this.page.waitForTimeout(ms)
    return { waited: ms }
  }

  listNetwork({ limit = 20, onlyErrors = false, contains = '' } = {}) {
    let items = [...this.network]
    if (onlyErrors) items = items.filter((item) => item.status === -1 || (item.status && item.status >= 400))
    if (contains) items = items.filter((item) => item.url.includes(contains))
    const capped = Math.min(Math.max(Number(limit) || 20, 1), NETWORK_LOG_LIMIT)
    return { count: items.length, totalTracked: this.network.length, items: items.slice(-capped) }
  }

  clearNetwork() {
    const cleared = this.network.length
    this.network = []
    return { cleared }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    try {
      await this.context.close()
    } catch (error) {
      this.logger.warn?.('浏览器上下文关闭失败', { leaseId: this.leaseId, err: error?.message })
    }
  }
}
