/**
 * namespace 隔离（本 worker 唯一的隔离手段）专项回归测试，聚焦
 * `src/namespace/` 内部的机制本身（IP 分配、cgroup 探测、跨 slot 隔离性质）。
 * 更贴近调用方视角的执行/浏览器用例见 sandbox.test.js / browser.test.js。
 *
 * 两类用例分开处理：
 *   - 纯逻辑（IP 分配、cgroup 版本探测、配置校验）——在任何机器上都能跑，
 *     不需要真的建 namespace。
 *   - 真实建 namespace 的集成用例（跨 slot 不可见、销毁重建零残留、网络隔离）——
 *     只有 Linux 且具备 CAP_SYS_ADMIN + CAP_NET_ADMIN 才跑得起来，本地 macOS
 *     开发机、CI 沙盒容器大概率跑不了。**跳过要跳得明明白白**：
 *     打印清楚原因，而不是静默变成"这组用例不存在"。
 *
 * 这组用例的可信度只到"在具备条件的机器上跑过一次绿"——它不能替代
 * 在目标容器环境上用 bin/check-namespace-caps.sh 做的那次真实验证。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

import { loadConfig } from '../src/config.js'
import { createLeaseManager } from '../src/leases.js'
import { createServer } from '../src/server.js'
import { execCommand } from '../src/executor.js'
import { createSlotPool } from '../src/namespace/slot-pool.js'
import { createEgressPolicyStore } from '../src/egress-policy.js'
import { detectCgroupVersion } from '../src/namespace/cgroup.js'
import { _internal as netnsInternal } from '../src/namespace/netns.js'
import { probeNamespaceSupport } from './support.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

describe('IP 分配逻辑（纯函数，任何机器都能跑）', () => {
  test('桥地址固定是子网的 .1', () => {
    const config = { namespace: { subnetCidr: '10.250.0.0/16' } }
    assert.deepEqual(netnsInternal.bridgeIp(config), { ip: '10.250.0.1', prefix: 16 })
  })

  test('slot 地址从 .2 开始按 index 递增，不与网络号/网关冲突', () => {
    const config = { namespace: { subnetCidr: '10.250.0.0/16' } }
    assert.deepEqual(netnsInternal.slotIp(config, 0), { ip: '10.250.0.2', prefix: 16 })
    assert.deepEqual(netnsInternal.slotIp(config, 1), { ip: '10.250.0.3', prefix: 16 })
    assert.notEqual(netnsInternal.slotIp(config, 0).ip, netnsInternal.bridgeIp(config).ip)
  })
})

describe('cgroup 版本探测（读真实 /proc/mounts，非 Linux 上会得到 none）', () => {
  test('不会抛异常，最差情况回退到 none', async () => {
    const version = await detectCgroupVersion()
    assert.ok(['v1', 'v2', 'none'].includes(version))
  })
})

const support = await probeNamespaceSupport()

describe('真实 namespace 隔离（需要 Linux + CAP_SYS_ADMIN + CAP_NET_ADMIN）', { skip: support.ok ? false : `跳过：${support.reason}` }, () => {
  let config
  let slotPool
  let leaseManager
  let app
  let baseUrl
  let workRoot

  const TEST_BRIDGE = 'nstestbr0'

  before(async () => {
    workRoot = await mkdtemp(path.join(tmpdir(), 'sbx-ns-test-'))
    config = loadConfig({
      NODE_ENV: 'test',
      SANDBOX_TOKEN: 'ns-test-token-0123456789',
      SANDBOX_SLOTS: '2',
      SANDBOX_WORK_ROOT: workRoot,
      SANDBOX_NS_BRIDGE: TEST_BRIDGE,
      SANDBOX_NS_SUBNET: '10.251.0.0/16',
      EXEC_DEFAULT_TIMEOUT_MS: '5000',
      EXEC_MAX_TIMEOUT_MS: '10000',
    })
    const egressPolicy = createEgressPolicyStore({ config, logger: silentLogger })
    slotPool = createSlotPool({ config, logger: silentLogger, egressPolicy })
    await slotPool.init()
    leaseManager = createLeaseManager({ config, logger: silentLogger, slotPool })
    app = createServer({ config, logger: silentLogger, leaseManager, slotPool, egressPolicy })
    const address = await app.listen(0)
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    await leaseManager.releaseAll('test')
    await app.close()
    await slotPool.shutdown()
    // slotPool 只删 veth，网桥是 ensureBridge 建的、故意跨重启复用，
    // 所以测试要自己收尾——否则每跑一次就在机器上留一张网卡
    await execFileAsync('ip', ['link', 'del', TEST_BRIDGE]).catch(() => {})
    await rm(workRoot, { recursive: true, force: true }).catch(() => {})
  })

  // 每个用例开始前把 slot 全部还回去。
  // 只有 2 个 slot，而下面好几个用例都要同时拿 2 个租约——不还，第二个用例
  // 起就会拿到 429，`body.leaseId` 是 undefined，后续断言全部跑在一个不存在的
  // 租约上。这类"用例之间互相污染"在本地会被 SKIP 掩盖掉，只有真跑起来才暴露。
  beforeEach(async () => {
    await leaseManager.releaseAll('test-reset')
  })

  const auth = { Authorization: 'Bearer ns-test-token-0123456789', 'Content-Type': 'application/json' }

  async function lease(body = {}) {
    const res = await fetch(`${baseUrl}/v1/leases`, { method: 'POST', headers: auth, body: JSON.stringify({ runId: 'r', username: 'e', ...body }) })
    return { status: res.status, body: await res.json() }
  }

  async function exec(leaseId, payload) {
    const res = await fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, { method: 'POST', headers: auth, body: JSON.stringify(payload) })
    const text = await res.text()
    const frames = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const stdout = frames.filter((f) => f.type === 'stdout').map((f) => f.data).join('')
    return { stdout, exit: frames.find((f) => f.type === 'exit') || null }
  }

  test('两个 slot 各自认领，互不共享', async () => {
    const a = await lease({ username: 'userA' })
    const b = await lease({ username: 'userB' })
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.notEqual(a.body.leaseId, b.body.leaseId)

    const third = await lease({ username: 'userC' })
    assert.equal(third.status, 429, '只建了 2 个 slot，第三个应该拿不到')
  })

  test('两个 slot 的 PID namespace 互相看不见——A 起的进程，B 的 ps 里没有', async () => {
    const a = await lease({ username: 'userA' })
    const b = await lease({ username: 'userB' })

    // 观察必须发生在 A 那次 exec **还没结束的时候**：后台进程活不过它那次 exec
    // 是有意设计的（exec 收尾会杀掉整个进程组，sandbox.test.js 里有专门的用例守着），
    // 所以"先起一个常驻进程，之后再回来 ps"这种写法在这套设计下永远看到的是 <defunct>。
    const runningInA = exec(a.body.leaseId, {
      command: 'sleep 30 & sleep 2; ps aux',
      timeoutMs: 8000,
    })
    await new Promise((resolve) => setTimeout(resolve, 500))

    // 趁 A 的 sleep 30 还活着，从 B 看一眼
    const psInB = await exec(b.body.leaseId, { command: 'ps aux' })
    const psInA = await runningInA

    assert.match(psInA.stdout, /sleep 30/, 'A 自己应该能看到自己起的进程')
    assert.ok(!psInB.stdout.includes('sleep 30'), 'B 不该看到 A 的进程——PID namespace 没有真正隔离')

    // 每个 slot 在自己的 PID namespace 里，job 应该是很小的号码（1 号进程是 sentinel 的 sleep infinity）
    const pidLine = (await exec(a.body.leaseId, { command: 'echo $$' })).stdout.trim()
    assert.ok(Number(pidLine) < 100, `job 的 PID（${pidLine}）应该在独立 namespace 里很小，说明确实进入了新 PID namespace`)
  })

  test('slot 回收重建后完全没有残留：文件、进程、监听端口都要清零', async () => {
    const first = await lease({ username: 'userA' })
    const slotIndexBefore = leaseManager.get(first.body.leaseId).slot.index

    await exec(first.body.leaseId, { command: 'echo SECRET_LEFTOVER > leftover.txt' })
    await exec(first.body.leaseId, {
      command: 'nohup bash -c "python3 -m http.server 18080 2>/dev/null || nc -lk -p 18080" >/dev/null 2>&1 & echo started',
      timeoutMs: 2000,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))

    await fetch(`${baseUrl}/v1/leases/${first.body.leaseId}`, { method: 'DELETE', headers: auth })
    // release() 会等这个 slot 完整回收重建之后才把它标记为空闲，这里多等一小会兜底
    await new Promise((resolve) => setTimeout(resolve, 500))

    const second = await lease({ username: 'userB' })
    const slotIndexAfter = leaseManager.get(second.body.leaseId).slot.index
    assert.equal(slotIndexAfter, slotIndexBefore, '这个用例要验证的就是同一个 slot 复用后是否干净，不是同一个 slot 就没测到点上')

    const peek = await exec(second.body.leaseId, { command: 'cat leftover.txt 2>&1 || echo GONE' })
    assert.match(peek.stdout, /GONE/, '上一个用户的文件应该已经随 slot 销毁重建一起消失')

    const portCheck = await exec(second.body.leaseId, { command: 'curl -m 1 -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18080 || echo UNREACHABLE' })
    assert.match(portCheck.stdout, /UNREACHABLE|000/, '上一个用户留下的监听端口不该在新的 slot 里还能连上')
  })

  test('slot 之间网络不通：A 起的监听端口，B 连不上', async () => {
    const a = await lease({ username: 'userA' })
    const b = await lease({ username: 'userB' })
    const aIp = leaseManager.get(a.body.leaseId).slot.net.ip

    await exec(a.body.leaseId, {
      command: 'nohup bash -c "python3 -m http.server 18081 2>/dev/null || nc -lk -p 18081" >/dev/null 2>&1 & echo started',
      timeoutMs: 2000,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const fromB = await exec(b.body.leaseId, { command: `curl -m 1 -s -o /dev/null -w "%{http_code}" http://${aIp}:18081 || echo UNREACHABLE` })
    assert.match(fromB.stdout, /UNREACHABLE|000/, 'B 不该连得上 A 的 slot 内部端口——两个 slot 应该是互相独立的网络 namespace')
  })

  // 这两条守的是一个真实发生过的 bug：cgroup 建好了、cpu/memory/pids 限额也都
  // 写进去了，但没有任何进程被加进去（`addProcess` 定义了却没人调用），
  // 于是限额全部挂在空组上——`/healthz` 一切正常，实际一条限制都不生效。
  // 这种失效不会以任何形式报错，只能靠断言"进程确实在里面"来发现。
  test('sentinel 在建 slot 时就被加进这个 slot 的 cgroup', async (t) => {
    const a = await lease({ username: 'userA' })
    const slot = leaseManager.get(a.body.leaseId).slot
    if (!slot.cgroup.procsFiles.length) {
      t.skip('这台机器没挂载 cgroup（/healthz 上是 cgroupVersion: none），限额本来就不适用')
      return
    }
    const procs = await readFile(slot.cgroup.procsFiles[0], 'utf8')
    assert.match(
      procs,
      new RegExp(`^${slot.sentinel.pid}$`, 'm'),
      `cgroup.procs 里应该有 sentinel 的 pid，实际内容：${JSON.stringify(procs)}`,
    )
  })

  test('job 进程也落在这个 slot 的 cgroup 里 —— 否则 cpu/memory/pids 限额一条都不生效', async (t) => {
    const a = await lease({ username: 'userA' })
    const slot = leaseManager.get(a.body.leaseId).slot
    if (!slot.cgroup.procsFiles.length) {
      t.skip('这台机器没挂载 cgroup，限额本来就不适用')
      return
    }
    // /proc 在 slot 里是 --mount-proc 重新挂过的，但我们没有 unshare cgroup
    // namespace，所以这里读到的仍是从容器 cgroup 根算起的完整路径
    const out = await exec(a.body.leaseId, { command: 'cat /proc/self/cgroup' })
    assert.match(
      out.stdout,
      new RegExp(`ap-sandbox/slot-${slot.index}(?![0-9])`),
      `job 应该在 slot-${slot.index} 的 cgroup 里，实际：${out.stdout}`,
    )
  })

  test('slot cgroup 里的限额值就是配置的值 —— 写进去了才谈得上生效', async (t) => {
    const a = await lease({ username: 'userA' })
    const slot = leaseManager.get(a.body.leaseId).slot
    if (!slot.cgroup.procsFiles.length) {
      t.skip('这台机器没挂载 cgroup')
      return
    }
    const dir = path.dirname(slot.cgroup.procsFiles[0])
    const pidsMax = await readFile(path.join(dir, 'pids.max'), 'utf8').catch(() => '')
    assert.equal(
      pidsMax.trim(),
      String(config.namespace.pidsMax),
      'pids.max 读不回配置值，多半是 controller 没有下放到这一层（cgroup.subtree_control）',
    )
  })

  // mount namespace 是从容器的挂载表**克隆**出来的，不是 chroot：除了显式 bind
  // 进去的 /sandbox-root，其余路径看到的都还是同一份文件系统。也就是说
  // /tmp 这个 1777 目录默认在所有 slot 之间共享 —— A 写、B 读，一条现成的
  // 跨 slot 通道，顺带还是符号链接攻击面。sentinel 起来时挂私有 tmpfs 堵掉它。
  test('/tmp 是每个 slot 私有的 —— 否则它就是一条现成的跨 slot 通道', async () => {
    const a = await lease({ username: 'userA' })
    const b = await lease({ username: 'userB' })

    await exec(a.body.leaseId, { command: 'echo SECRET_IN_TMP > /tmp/leak.txt && ls -la /tmp/leak.txt' })
    const peek = await exec(b.body.leaseId, { command: 'cat /tmp/leak.txt 2>&1 || echo GONE' })
    assert.ok(!peek.stdout.includes('SECRET_IN_TMP'), `B 读到了 A 写在 /tmp 的内容：${peek.stdout}`)

    // 顺带确认它确实是 tmpfs，而不是"恰好没读到"
    const mnt = await exec(a.body.leaseId, { command: 'df -T /tmp 2>/dev/null | tail -1' })
    assert.match(mnt.stdout, /tmpfs/, `/tmp 不是 tmpfs，私有挂载没生效：${mnt.stdout}`)
  })

  test('/dev/shm 同样是 slot 私有的', async () => {
    const a = await lease({ username: 'userA' })
    const b = await lease({ username: 'userB' })
    await exec(a.body.leaseId, { command: 'echo SECRET_IN_SHM > /dev/shm/leak.txt' })
    const peek = await exec(b.body.leaseId, { command: 'cat /dev/shm/leak.txt 2>&1 || echo GONE' })
    assert.ok(!peek.stdout.includes('SECRET_IN_SHM'), `B 读到了 A 写在 /dev/shm 的内容：${peek.stdout}`)
  })

  test('/healthz 如实报告出站白名单里有没有可用目标', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    const body = await res.json()
    // 这套用例没配 AP_BRIDGE_HOST：出站是锁死的，但业务放行目标是 0。
    // "锁上了"和"还能用"是两回事，探针必须把后者也说清楚。
    assert.equal(body.namespace.egress.bridgeConfigured, false)
    assert.equal(body.namespace.egress.allowedBridgeIps, 0)
  })

  test('/healthz 按 slot 报告 namespace 状态', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    const body = await res.json()
    assert.equal(body.namespace.slots.length, 2)
    assert.ok(['v1', 'v2', 'none'].includes(body.namespace.cgroupVersion))
  })
})

/**
 * 限额到底挡不挡得住 —— 单独起一个只有 1 个 slot、限额刻意调很小的池子，
 * 这样几秒钟就能看出结论。
 *
 * 为什么要有这一组：`cgroup.procs` 里能看到进程、限额文件里能读回配置值，
 * 都只是**必要条件**。这一整套机制之前就是"每一步看起来都对，合起来一条限制
 * 都不生效"——进程没被加进 cgroup、controller 没有下放到子层、内存限额没管住
 * swap，三个环节各自都不报错。所以最后必须有一条用真实行为收口的断言。
 */
describe('cgroup 限额真的挡得住（需要 Linux + CAP_SYS_ADMIN + CAP_NET_ADMIN）', { skip: support.ok ? false : `跳过：${support.reason}` }, () => {
  let config
  let pool
  let slot
  let workRoot

  const LIMIT_BRIDGE = 'nslimbr0'

  before(async () => {
    workRoot = await mkdtemp(path.join(tmpdir(), 'sbx-lim-'))
    config = loadConfig({
      NODE_ENV: 'test',
      SANDBOX_TOKEN: 'lim-test-token-0123456789',
      SANDBOX_SLOTS: '1',
      SANDBOX_WORK_ROOT: workRoot,
      SANDBOX_NS_BRIDGE: LIMIT_BRIDGE,
      SANDBOX_NS_SUBNET: '10.249.0.0/16',
      SANDBOX_NS_PIDS_MAX: '20',
      SANDBOX_NS_MEMORY_MAX_MB: '64',
      EXEC_DEFAULT_TIMEOUT_MS: '15000',
      EXEC_MAX_TIMEOUT_MS: '20000',
    })
    const egressPolicy = createEgressPolicyStore({ config, logger: silentLogger })
    pool = createSlotPool({ config, logger: silentLogger, egressPolicy })
    await pool.init()
    slot = pool.acquire('limits')
  })

  after(async () => {
    await pool?.shutdown()
    await execFileAsync('ip', ['link', 'del', LIMIT_BRIDGE]).catch(() => {})
    await rm(workRoot, { recursive: true, force: true }).catch(() => {})
  })

  async function run(command) {
    let out = ''
    const result = await execCommand({
      config,
      logger: silentLogger,
      workspace: { rootDir: slot.guest.workDir, homeDir: slot.guest.homeDir, tmpDir: slot.guest.tmpDir },
      command,
      timeoutMs: 12000,
      onFrame: (frame) => { out += frame.data },
      slot,
    })
    return { ...result, out }
  }

  test('pids.max 挡得住 fork 风暴 —— 这是删掉 ulimit -u 之后唯一的进程数上限', async (t) => {
    if (!slot.cgroup.procsFiles.length) { t.skip('这台机器没挂载 cgroup'); return }
    const { out } = await run('for i in $(seq 1 60); do sleep 5 & done 2>&1 | tail -3')
    assert.match(out, /Resource temporarily unavailable|fork/, `60 个后台进程全起来了，pids.max=20 没有生效。输出：${out}`)
  })

  test('memory.max 要配合 memory.swap.max 才挡得住 —— 只限内存的话换页出去就绕过了', async (t) => {
    if (!slot.cgroup.procsFiles.length) { t.skip('这台机器没挂载 cgroup'); return }
    const probe = await run('command -v python3 >/dev/null && echo yes || echo no')
    if (!probe.out.includes('yes')) { t.skip('镜像里没有 python3，换个分配内存的办法再测'); return }

    // 标记要在 python 里拼出来，不能在命令行里出现完整字样：进程被 OOM 干掉时
    // bash 打的 "Killed" 提示会把**整条命令行原样回显**，直接找完整标记会永远命中。
    const { out } = await run('python3 -c "b=bytearray(200*1024*1024); print(\'NOT\'+\'_LIMITED\')" 2>&1 || echo KILLED')
    assert.ok(
      !out.includes('NOT_LIMITED'),
      `64MB 上限的 slot 里成功分配了 200MB —— 多半是 memory.swap.max 没设，超限的页被换出去了。输出：${out}`,
    )
  })
})

// 线上观察到的回归：executor 曾用 `bash -lc`，登录 shell 会 source /etc/profile
// 和 job 自己可写的 ~/.bash_profile。前者让每条命令的 stderr 都多一行假错误，
// 后者让 job 能给同一租约后续的所有命令植入代码，并覆盖 buildJobEnv 的白名单环境。
describe('job 的 shell 不是登录 shell（需要真 slot）', { skip: support.ok ? false : `跳过：${support.reason}` }, () => {
  let pool
  let slot
  let workRoot

  before(async () => {
    workRoot = await mkdtemp(path.join('/var/tmp', 'ap-noprofile-'))
    const config = loadConfig({
      NODE_ENV: 'test', SANDBOX_TOKEN: 'ns-test-token-0123456789', SANDBOX_SLOTS: '1',
      SANDBOX_WORK_ROOT: workRoot, SANDBOX_NS_BRIDGE: 'nplbr0', SANDBOX_NS_SUBNET: '10.247.0.0/16',
      SANDBOX_NS_CGROUP_ROOT: '/sys/fs/cgroup/ap-noprofile',
      EXEC_DEFAULT_TIMEOUT_MS: '15000', EXEC_MAX_TIMEOUT_MS: '20000',
    })
    const egressPolicy = createEgressPolicyStore({ config, logger: silentLogger })
    pool = createSlotPool({ config, logger: silentLogger, egressPolicy })
    await pool.init()
    slot = pool.acquire('noprofile')
    globalThis.__noProfileConfig = config
  })

  after(async () => {
    await pool?.shutdown().catch(() => {})
    await rm(workRoot, { recursive: true, force: true }).catch(() => {})
  })

  async function run(command) {
    let out = ''
    const result = await execCommand({
      config: globalThis.__noProfileConfig,
      logger: silentLogger,
      workspace: { rootDir: slot.guest.workDir, homeDir: slot.guest.homeDir, tmpDir: slot.guest.tmpDir },
      command,
      timeoutMs: 12000,
      onFrame: (frame) => { out += frame.data },
      slot,
    })
    return { ...result, out }
  }

  test('job 写进 ~/.bash_profile 的代码不会在后续命令里被执行', async () => {
    await run('echo "echo PROFILE_WAS_SOURCED" > "$HOME/.bash_profile"; echo "echo PROFILE_WAS_SOURCED" > "$HOME/.profile"')
    const { out } = await run('echo done')
    assert.ok(
      !out.includes('PROFILE_WAS_SOURCED'),
      `job 写的 profile 被 source 了 —— shell 又变回登录 shell 了。输出：${out}`,
    )
    assert.match(out, /done/)
  })

  test('profile 脚本改不动 buildJobEnv 给的 PATH', async () => {
    await run('echo "export PATH=/hijacked" > "$HOME/.bash_profile"')
    const { out } = await run('echo "$PATH"')
    assert.ok(!out.includes('/hijacked'), `白名单 PATH 被 profile 覆盖了：${out}`)
    assert.match(out, /\/usr\/bin/)
  })
})
