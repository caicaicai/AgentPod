/**
 * 浏览器沙盒回归测试。用真实的 Chromium 打真实的本地页面 —— mock 一个 CDP 会话
 * 只能测到"我以为 CDP 是这样的"，测不出 AntD 受控组件那类真问题。
 *
 * 镜像里没装 playwright、或机器不具备 namespace 隔离所需的能力时整组跳过
 * （浏览器现在是"每个 slot 私有 Chromium"，创建会话必须先有一个真实的 slot）——
 * 跳过会说明具体原因，不是静默变成"这组用例不存在"。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { createLeaseManager } from '../src/leases.js'
import { createBrowserManager } from '../src/browser/index.js'
import { createSlotPool } from '../src/namespace/slot-pool.js'
import { createEgressPolicyStore } from '../src/egress-policy.js'
import { createServer } from '../src/server.js'
import { formatAriaToYaml } from '../src/browser/aria-snapshot.js'
import { _internal as netnsInternal } from '../src/namespace/netns.js'
import { probeNamespaceSupport } from './support.js'

const execFileAsync = promisify(execFile)

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }
const TOKEN = 'browser-token-abcdef'

let hasPlaywright = true
try {
  await import('playwright')
} catch {
  hasPlaywright = false
}

const nsSupport = await probeNamespaceSupport()
const skipReason = !hasPlaywright
  ? '镜像里没有 playwright，跳过浏览器用例'
  : !nsSupport.ok
    ? `跳过：${nsSupport.reason}`
    : false

/** 一个够真实的测试页：受控输入、原生 select、自定义下拉、动态内容 */
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>沙盒测试页</title></head>
<body>
  <h1 id="title">会议室预订</h1>
  <label for="name">姓名</label>
  <input id="name" type="text" />
  <label for="date">日期</label>
  <input id="date" type="text" value="" />
  <select id="floor">
    <option value="3">3层</option>
    <option value="4">4层</option>
  </select>
  <button id="go">查询</button>
  <div id="result"></div>
  <div id="dropdown-trigger" role="combobox" tabindex="0">请选择职场</div>
  <div id="popup" style="display:none">
    <div class="opt">亦庄科创</div>
    <div class="opt">总部大楼</div>
  </div>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      const name = document.getElementById('name').value
      const date = document.getElementById('date').value
      const floor = document.getElementById('floor').value
      document.getElementById('result').textContent = '查询:' + name + '|' + date + '|' + floor
    })
    document.getElementById('date').addEventListener('input', (e) => {
      document.getElementById('result').setAttribute('data-last-input', e.target.value)
    })
    document.getElementById('dropdown-trigger').addEventListener('click', () => {
      document.getElementById('popup').style.display = 'block'
    })
    document.querySelectorAll('.opt').forEach((el) => el.addEventListener('click', () => {
      document.getElementById('dropdown-trigger').textContent = el.textContent
      document.getElementById('popup').style.display = 'none'
    }))
    fetch('/api/data').catch(() => {})
  </script>
</body></html>`

describe('ARIA 快照格式（纯函数，无需浏览器）', () => {
  test('与桌面端同一个实现：交互元素带 [ref=eN]', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: '测试页' }, childIds: ['2', '3'] },
      { nodeId: '2', role: { value: 'button' }, name: { value: '查询' }, backendDOMNodeId: 11, childIds: [] },
      { nodeId: '3', role: { value: 'textbox' }, name: { value: '姓名' }, backendDOMNodeId: 12, childIds: [] },
    ]
    const { snapshot, refs } = formatAriaToYaml(nodes)
    assert.match(snapshot, /\[ref=e1\]/)
    assert.match(snapshot, /button/)
    assert.equal(refs.e1.backendDOMNodeId, 11)
    assert.equal(refs.e2.backendDOMNodeId, 12)
  })
})

describe('浏览器沙盒（需要 playwright + Linux + CAP_SYS_ADMIN + CAP_NET_ADMIN）', { skip: skipReason }, () => {
  let config
  let slotPool
  let leaseManager
  let browserManager
  let app
  let baseUrl
  let workRoot
  let site
  let sitePort

  const SUBNET = '10.253.0.0/16'
  const BROWSER_TEST_BRIDGE = 'sbxbrowserbr0'
  // Chromium 现在跑在 slot **自己的** network namespace 里，所以 `127.0.0.1`
  // 是那个 slot 的回环，不是 worker 的——测试站点必须挂在一个从 slot 里够得着
  // 的地址上，也就是网桥的网关地址。
  const SITE_HOST = netnsInternal.bridgeIp({ namespace: { subnetCidr: SUBNET } }).ip

  before(async () => {
    site = http.createServer((req, res) => {
      if (req.url === '/api/data') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }
      if (req.url === '/api/fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        return res.end('{}')
      }
      if (req.url === '/whoami') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        return res.end(`<html><body><pre id="c">${req.headers.cookie || 'none'}</pre></body></html>`)
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML)
    })
    // 0.0.0.0 而不是 127.0.0.1：要让 slot 经网桥连得到（见 SITE_HOST 的说明）
    await new Promise((resolve) => site.listen(0, '0.0.0.0', resolve))
    sitePort = site.address().port

    workRoot = await mkdtemp(path.join(tmpdir(), 'sbx-browser-'))
    config = loadConfig({
      NODE_ENV: 'test',
      SANDBOX_TOKEN: TOKEN,
      SANDBOX_SLOTS: '2',
      SANDBOX_WORK_ROOT: workRoot,
      SANDBOX_NS_BRIDGE: BROWSER_TEST_BRIDGE,
      SANDBOX_NS_SUBNET: SUBNET,
      BROWSER_ENABLED: '1',
      // slot 的 netns 出站白名单只放行 DNS 和 Cloud Bridge，别的一律 REJECT——
      // 浏览器也不例外，它就跑在这个 netns 里。所以测试站点必须**作为白名单目标**
      // 注册进去，否则 Chromium 连它都打不开。
      //
      // 这不是为了让用例好过：它精确反映了当前实现的一条真实约束——
      // **云端浏览器只能访问出站白名单里的地址**。真实部署里白名单只有 Cloud
      // Bridge，也就是说浏览器目前打不开任何业务站点。这是个待定的设计问题
      // （给 slot 开浏览器专用放行 vs 让 Chromium 走 Bridge 的 HTTP 代理），
      // 定下来之前这组用例就按"只有白名单目标可达"来测。
      AP_BRIDGE_HOST: SITE_HOST,
      AP_BRIDGE_PORT: String(sitePort),
    })
    browserManager = createBrowserManager({ config, logger: silentLogger })
    const egressPolicy = createEgressPolicyStore({ config, logger: silentLogger })
    slotPool = createSlotPool({ config, logger: silentLogger, egressPolicy, browserManager })
    await slotPool.init()
    leaseManager = createLeaseManager({ config, logger: silentLogger, slotPool })
    app = createServer({ config, logger: silentLogger, leaseManager, browserManager, slotPool, egressPolicy })
    const address = await app.listen(0)
    baseUrl = `http://127.0.0.1:${address.port}`
    config.advertiseBase = baseUrl
  })

  after(async () => {
    await leaseManager?.releaseAll('test')
    await browserManager?.shutdown()
    await app?.close()
    await slotPool?.shutdown()
    // slotPool 只删 veth；网桥是 ensureBridge 建的、故意跨重启复用，测试得自己收尾
    await execFileAsync('ip', ['link', 'del', BROWSER_TEST_BRIDGE]).catch(() => {})
    await new Promise((resolve) => site.close(resolve))
    await rm(workRoot, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await leaseManager.releaseAll('reset')
  })

  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

  async function newLease() {
    const res = await fetch(`${baseUrl}/v1/leases`, { method: 'POST', headers: auth, body: JSON.stringify({ runId: 'r', username: 'zhangsan' }) })
    return (await res.json()).leaseId
  }

  async function browser(leaseId, action, payload = {}) {
    const res = await fetch(`${baseUrl}/v1/leases/${leaseId}/browser/${action}`, {
      method: 'POST', headers: auth, body: JSON.stringify(payload),
    })
    return { status: res.status, body: await res.json() }
  }

  const siteBase = () => `http://${SITE_HOST}:${sitePort}`
  const pageUrl = () => `${siteBase()}/`

  test('open + snapshot：产出带 ref 的 ARIA 快照', async () => {
    const leaseId = await newLease()
    const opened = await browser(leaseId, 'open', { url: pageUrl() })
    assert.equal(opened.body.ok, true)
    assert.equal(opened.body.title, '沙盒测试页')

    const snap = await browser(leaseId, 'snapshot')
    assert.equal(snap.body.ok, true)
    assert.match(snap.body.snapshot, /\[ref=e\d+\]/, '快照里没有 ref，act 就无从定位元素')
    assert.match(snap.body.snapshot, /查询/)
    assert.ok(snap.body.refCount > 0)
    // 快照不该把 backendDOMNodeId 回给模型 —— 对它没用还占 token
    assert.equal(snap.body.refs, undefined)
  })

  test('act fill：走原生 setter，受控组件能收到 input 事件', async () => {
    const leaseId = await newLease()
    await browser(leaseId, 'open', { url: pageUrl() })
    const snap = await browser(leaseId, 'snapshot')
    const dateRef = findRef(snap.body.snapshot, '日期')
    assert.ok(dateRef, `快照里找不到日期输入框：\n${snap.body.snapshot}`)

    const filled = await browser(leaseId, 'act', { kind: 'fill', ref: dateRef, text: '2026-08' })
    assert.equal(filled.body.ok, true)

    // 页面的 input 监听器把值写进了 data-last-input —— 证明框架能感知到这次写入，
    // 而不是只把 DOM 的 value 改了（那是桌面端"日期框填不进去"的老坑）
    const check = await browser(leaseId, 'evaluate', {
      fn: 'return document.getElementById("result").getAttribute("data-last-input")',
    })
    assert.equal(check.body.value, '2026-08', 'fill 没有触发 input 事件，受控组件不会认这个值')
  })

  test('act click：点击真的生效', async () => {
    const leaseId = await newLease()
    await browser(leaseId, 'open', { url: pageUrl() })
    const snap = await browser(leaseId, 'snapshot')
    const nameRef = findRef(snap.body.snapshot, '姓名')
    await browser(leaseId, 'act', { kind: 'fill', ref: nameRef, text: '张三' })

    const buttonRef = findRef(snap.body.snapshot, '查询')
    const clicked = await browser(leaseId, 'act', { kind: 'click', ref: buttonRef })
    assert.equal(clicked.body.ok, true)

    const result = await browser(leaseId, 'evaluate', { fn: 'return document.getElementById("result").textContent' })
    assert.match(result.body.value, /张三/, '点击没生效')
  })

  test('act select：原生 <select> 可选中', async () => {
    const leaseId = await newLease()
    await browser(leaseId, 'open', { url: pageUrl() })
    const snap = await browser(leaseId, 'snapshot')
    const floorRef = findRef(snap.body.snapshot, '3层') || findRef(snap.body.snapshot, 'combobox')
    assert.ok(floorRef, `快照里找不到 select：\n${snap.body.snapshot}`)

    await browser(leaseId, 'act', { kind: 'select', ref: floorRef, values: ['4'] })
    const value = await browser(leaseId, 'evaluate', { fn: 'return document.getElementById("floor").value' })
    assert.equal(value.body.value, '4')
  })

  test('evaluate 的报错把真实原因回给模型，而不是笼统一句失败', async () => {
    const leaseId = await newLease()
    await browser(leaseId, 'open', { url: pageUrl() })
    const result = await browser(leaseId, 'evaluate', { fn: 'return nonExistentFunction()' })
    assert.equal(result.body.ok, false)
    assert.match(result.body.error, /nonExistentFunction|not defined/i, '错误信息没带上真实原因，模型只能盲目重试')
  })

  test('screenshot 返回 base64 图片', async () => {
    const leaseId = await newLease()
    await browser(leaseId, 'open', { url: pageUrl() })
    const shot = await browser(leaseId, 'screenshot', { waitMs: 0 })
    assert.equal(shot.body.ok, true)
    assert.ok(shot.body.sizeBytes > 1000)
    // PNG magic number
    assert.equal(Buffer.from(shot.body.contentBase64, 'base64').subarray(1, 4).toString(), 'PNG')
  })

  test('network 记录页面发出的请求', async () => {
    const leaseId = await newLease()
    await browser(leaseId, 'open', { url: pageUrl() })
    await browser(leaseId, 'act', { kind: 'wait', timeMs: 500 })
    const net = await browser(leaseId, 'network', { limit: 50 })
    assert.equal(net.body.ok, true)
    assert.ok(net.body.items.some((item) => item.url.includes('/api/data')), '没记录到页面发出的 XHR')
  })

  test('cookie 由服务端注入，页面能带着它访问', async () => {
    const leaseId = await newLease()
    const opened = await browser(leaseId, 'open', {
      url: `${siteBase()}/whoami`,
      cookies: [{ name: 'sso.xiaocaicai.com', value: 'BROWSER_COOKIE', domain: SITE_HOST, path: '/' }],
    })
    assert.equal(opened.body.ok, true)
    const seen = await browser(leaseId, 'evaluate', { fn: 'return document.getElementById("c").textContent' })
    assert.match(seen.body.value, /BROWSER_COOKIE/, 'cookie 没注入进浏览器上下文')
  })

  test('两个租约的浏览器上下文互不可见（cookie 不串）', async () => {
    const a = await newLease()
    const b = await newLease()

    await browser(a, 'open', {
      url: `${siteBase()}/whoami`,
      cookies: [{ name: 'sso.xiaocaicai.com', value: 'COOKIE_OF_A', domain: SITE_HOST, path: '/' }],
    })
    await browser(b, 'open', { url: `${siteBase()}/whoami` })

    const seenByB = await browser(b, 'evaluate', { fn: 'return document.getElementById("c").textContent' })
    assert.ok(!String(seenByB.body.value).includes('COOKIE_OF_A'), 'B 的浏览器里出现了 A 的登录态')
  })

  test('释放租约会关掉浏览器上下文（用户登录态不留在内存里）', async () => {
    const leaseId = await newLease()
    await browser(leaseId, 'open', { url: pageUrl() })
    const lease = leaseManager.get(leaseId)
    assert.ok(lease.browser, '浏览器会话没建立，这条用例没在测东西')

    await fetch(`${baseUrl}/v1/leases/${leaseId}`, { method: 'DELETE', headers: auth })
    assert.equal(lease.browser, null, '释放后浏览器上下文还挂着')
    assert.equal(lease.closed !== false, true)
  })

  test('失效的 ref 给出可操作的提示', async () => {
    const leaseId = await newLease()
    await browser(leaseId, 'open', { url: pageUrl() })
    const result = await browser(leaseId, 'act', { kind: 'click', ref: 'e999' })
    assert.equal(result.body.ok, false)
    assert.match(result.body.error, /重新 snapshot/, '没告诉模型该怎么恢复')
  })

  test('close 幂等，没开过浏览器也不报错', async () => {
    const leaseId = await newLease()
    const first = await browser(leaseId, 'close')
    assert.equal(first.body.ok, true)
    await browser(leaseId, 'open', { url: pageUrl() })
    const second = await browser(leaseId, 'close')
    assert.equal(second.body.ok, true)
  })
})

/** 从 ARIA 快照文本里找出含某段文字的那一行的 ref */
function findRef(snapshot, text) {
  for (const line of String(snapshot || '').split('\n')) {
    if (!line.includes(text)) continue
    const match = line.match(/\[ref=(e\d+)\]/)
    if (match) return match[1]
  }
  return null
}
