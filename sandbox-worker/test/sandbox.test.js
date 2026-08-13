/**
 * 沙盒 worker 回归测试。
 *
 * 重点不是"命令能跑"，而是那几条**一旦失守就会出事**的性质：
 *   - job 拿不到 worker 的环境变量（里面有 SANDBOX_TOKEN）
 *   - HOME 是 job 级的（有技能往 homedir 写数据，全局 HOME 会跨用户泄漏）
 *   - 杀 job 时孙子进程也一起死（否则下一个用户的 job 期间它还活着）
 *   - 释放租约后工作区真的没了
 *   - 路径逃逸挡得住
 *   - 输出上限挡得住（一条 yes 就能把 agent 撑爆）
 *
 * namespace 隔离是本 worker **唯一**的执行路径，所以牵涉真实 exec 的用例
 * 需要 Linux + CAP_SYS_ADMIN + CAP_NET_ADMIN，在不具备条件的机器上会清楚地跳过
 * （见 [support.js](support.js)），不是静默通过。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, readFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadConfig, validate, detectAdvertiseBase } from '../src/config.js'
import { createLogger } from '../src/logger.js'
import { createLeaseManager } from '../src/leases.js'
import { createSlotPool } from '../src/namespace/slot-pool.js'
import { createEgressPolicyStore } from '../src/egress-policy.js'
import { createServer, resolveInWorkspace } from '../src/server.js'
import { buildJobEnv, buildUlimitPrefix, execCommand, buildNsenterInvocation, buildSlotInvocation, shellQuote } from '../src/executor.js'
import { parseForkSupport } from '../src/namespace/nsenter-compat.js'
import { buildCgroupJoinScript } from '../src/namespace/cgroup.js'
import { probeNamespaceSupport } from './support.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }

describe('纯函数 / 配置校验（任何机器都能跑，不需要真的建 namespace）', () => {
  test('生产环境缺 SANDBOX_TOKEN 拒绝启动', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', SANDBOX_ADVERTISE_BASE: 'http://10.0.0.1:8080' }),
      /SANDBOX_TOKEN/,
    )
  })

  test('没配 SANDBOX_ADVERTISE_BASE 时自动探测容器 IP（无 K8s podIP 注入时的回退）', () => {
    const detected = detectAdvertiseBase(8080)
    const produced = loadConfig({ NODE_ENV: 'test', ALLOW_ANONYMOUS: '1', PORT: '8080' })
    assert.equal(produced.advertiseBase, detected)
    assert.match(produced.advertiseBase, /^http:\/\/\d+\.\d+\.\d+\.\d+:8080$/)
  })

  test('显式配置永远优先于自动探测', () => {
    const produced = loadConfig({
      NODE_ENV: 'test', ALLOW_ANONYMOUS: '1',
      SANDBOX_ADVERTISE_BASE: 'http://10.9.8.7:9999/',
    })
    assert.equal(produced.advertiseBase, 'http://10.9.8.7:9999')
  })

  test('探测不到地址时生产环境拒绝启动', () => {
    // 探测失败 = 租约发出去了但没人能连回来。宁可起不来，也不要跑成半残。
    //
    // 用 loadConfig 造底子再把 advertiseBase 抹掉，而不是手写一个 config 字面量：
    // 手写的那份每次 config.js 加一个被校验的字段就会 TypeError，报出来的还是
    // "Cannot read properties of undefined"，与本用例真正想守的东西毫无关系。
    const broken = loadConfig({ NODE_ENV: 'test', ALLOW_ANONYMOUS: '1' })
    broken.isProduction = true
    broken.allowAnonymous = false
    broken.token = 'x'
    broken.advertiseBase = ''
    assert.throws(() => validate(broken), /SANDBOX_ADVERTISE_BASE/)
  })

  /**
   * 这里曾经还有两条 AP_BRIDGE_HOST 的用例（生产环境缺它就拒绝启动、它要走 config
   * 而不是让 netns.js 直接读 process.env）。Cloud Bridge 已经从这套服务里移除
   * （见 src/tools/http.js 开头：出站改走 Node 原生 fetch），worker 的 config 里
   * 再没有 bridge 这一节，那两条测的是不存在的字段。
   *
   * 它们守的那个意思没有丢：slot 的出站白名单该不该默认拦，现在由
   * SANDBOX_EGRESS_MODE 回答，见 test/egress-policy.test.js。
   */

  test('生产环境禁止匿名', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', SANDBOX_TOKEN: 'x', SANDBOX_ADVERTISE_BASE: 'http://a', ALLOW_ANONYMOUS: '1' }),
      /ALLOW_ANONYMOUS/,
    )
  })

  test('SANDBOX_NS_CPU_MAX_CORES 必须大于 0', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', ALLOW_ANONYMOUS: '1', SANDBOX_NS_CPU_MAX_CORES: '0' }),
      /SANDBOX_NS_CPU_MAX_CORES/,
    )
  })

  test('ulimit 前缀只设 -f，不设 -v（会把 Node/Python 直接打死）', () => {
    const config = loadConfig({ NODE_ENV: 'test', ALLOW_ANONYMOUS: '1' })
    const prefix = buildUlimitPrefix(config)
    assert.ok(!prefix.includes('ulimit -v'))
    assert.match(prefix, /ulimit -f/)
  })

  test('ulimit 不再设 -u —— 进程数上限交给 cgroup 的 pids.max（按 slot 统计）', () => {
    const config = loadConfig({ NODE_ENV: 'test', ALLOW_ANONYMOUS: '1' })
    assert.ok(!buildUlimitPrefix(config).includes('ulimit -u'))
  })

  test('job 的 PATH 不继承 worker 的 —— 否则开发机上一堆目录会被带进沙盒', () => {
    const config = loadConfig({ NODE_ENV: 'test', ALLOW_ANONYMOUS: '1' })
    const { env } = buildJobEnv({
      config,
      workspace: { rootDir: '/w', homeDir: '/w/home', tmpDir: '/w/tmp' },
      extraEnv: {},
    })
    assert.equal(env.PATH, config.jobPath)
  })

  test('worker 自己 PATH 上的目录不会漏进 job', () => {
    // 不能直接断言 env.PATH !== process.env.PATH：容器里 worker 的 PATH 恰好
    // 就等于 jobPath 的默认值，那样断言会因环境而异地假红。改成塞一个只可能
    // 来自 worker 的目录，看它有没有漏过去。
    const original = process.env.PATH
    process.env.PATH = `/opt/only-on-the-worker:${original}`
    try {
      const config = loadConfig({ NODE_ENV: 'test', ALLOW_ANONYMOUS: '1' })
      const { env } = buildJobEnv({
        config,
        workspace: { rootDir: '/w', homeDir: '/w/home', tmpDir: '/w/tmp' },
        extraEnv: {},
      })
      assert.ok(!env.PATH.includes('/opt/only-on-the-worker'), `job 的 PATH 带上了 worker 的目录：${env.PATH}`)
    } finally {
      process.env.PATH = original
    }
  })

  test('buildJobEnv 明确报告被丢弃的键，不静默吞掉', () => {
    const config = loadConfig({ NODE_ENV: 'test', ALLOW_ANONYMOUS: '1' })
    const { env, rejected } = buildJobEnv({
      config,
      workspace: { rootDir: '/w', homeDir: '/w/home', tmpDir: '/w/tmp' },
      extraEnv: { AP_OK: '1', PATH: '/evil' },
    })
    assert.equal(env.AP_OK, '1')
    assert.notEqual(env.PATH, '/evil')
    assert.deepEqual(rejected, ['PATH'])
    assert.equal(env.HOME, '/w/home')
  })

  test('execCommand 没有 slot 就直接拒绝——namespace 隔离是唯一的执行路径', async () => {
    const config = loadConfig({ NODE_ENV: 'test', ALLOW_ANONYMOUS: '1' })
    await assert.rejects(
      execCommand({ config, logger: silentLogger, workspace: { rootDir: '/w', homeDir: '/w/home', tmpDir: '/w/tmp' }, command: 'echo hi', slot: null, onFrame: () => {} }),
      /NO_SLOT|slot/,
    )
  })

  test('nsenter 兼容层：只列出 --no-fork 的版本（实测过的容器节点）不传 --fork', () => {
    // 原样摘自真实节点的 nsenter --help 输出，2026-07-30 在 ai-translate-202-00001 上跑出来的
    const help = [
      'Options:',
      ' -t, --target <pid>     target process to get namespaces from',
      ' -p, --pid[=<file>]     enter pid namespace',
      ' -S, --setuid <uid>     set uid in entered namespace',
      ' -G, --setgid <gid>     set gid in entered namespace',
      ' -w, --wd[=<dir>]       set the working directory',
      ' -F, --no-fork          do not fork before exec\'ing <program>',
    ].join('\n')
    assert.deepEqual(parseForkSupport(help), [], '这个版本带 -p 时默认就 fork，传 --fork 反而会被拒绝')
  })

  test('nsenter 兼容层：明确列出独立 --fork 选项的版本要显式传', () => {
    const help = [
      'Options:',
      ' -t, --target <pid>     target process to get namespaces from',
      ' -p, --pid[=<file>]     enter pid namespace',
      '     --fork             fork before exec\'ing <program>',
    ].join('\n')
    assert.deepEqual(parseForkSupport(help), ['--fork'])
  })

  test('nsenter 兼容层：拿不到 --help 输出时保守地不传（好过传一个可能不存在的 flag）', () => {
    assert.deepEqual(parseForkSupport(''), [])
    assert.deepEqual(parseForkSupport(undefined), [])
  })

  test('buildNsenterInvocation 不能用 --wd —— 它在调用方的 mount namespace 里解析路径', () => {
    // 在特权容器里实测确认：`nsenter --wd=/sandbox-root/work` 必然报
    // "cannot open /sandbox-root/work: No such file or directory"，因为 --wd 是在
    // setns() **之前** open 的，那时还在 worker 自己的 mount namespace 里，
    // 而这个目录只存在于 slot 的 mount namespace 里。
    // 症状很有迷惑性：不是报错退出，而是**每条命令都没有输出**。
    const slot = { sentinel: { pid: 4242 }, uid: 20005, gid: 20005 }
    const { args } = buildNsenterInvocation({ slot, shell: '/bin/bash', fullCommand: 'cd /sandbox-root/work || exit 1\necho hi' })
    assert.ok(!args.some((a) => String(a).startsWith('--wd')), `argv 里不该出现 --wd，实际：${JSON.stringify(args)}`)
    assert.equal(args.at(-3), '/bin/bash')
    assert.equal(args.at(-2), '-c')
    assert.match(args.at(-1), /^cd \/sandbox-root\/work \|\| exit 1/, 'cwd 要由目标 namespace 里的 shell 自己 cd')
  })

  // 线上观察到的回归：曾经用的是 `-lc`，于是每条命令都会 source /etc/profile，
  // 镜像里那个脚本又去读 job 读不到的 /home/admin/env_set.sh，结果**每一次** exec
  // 的 stderr 都固定多一行 "Permission denied"。比噪音更严重的是，登录 shell 会让
  // /etc/profile 和 job 自己可写的 ~/.bash_profile 覆盖 buildJobEnv 的白名单环境。
  test('job 的 shell 不能是登录 shell —— 否则白名单环境会被 profile 脚本覆盖', () => {
    const slot = { sentinel: { pid: 4242 }, uid: 20005, gid: 20005 }
    const { args } = buildNsenterInvocation({ slot, shell: '/bin/bash', fullCommand: 'echo hi' })
    assert.ok(!args.includes('-lc'), 'argv 里不该出现 -lc')
    assert.ok(!args.includes('-l'), 'argv 里不该出现 -l')
    assert.equal(args.at(-2), '-c')
  })

  test('cwd 拼进命令串时要正确转义，不能被路径里的引号撑开', () => {
    assert.equal(shellQuote('/a/b'), "'/a/b'")
    assert.equal(shellQuote("/a'b"), "'/a'\\''b'")
  })

  // ── cgroup 归属 ──────────────────────────────────────────────────
  // 这一组守的是一个已经发生过的 bug：cgroup 建好了、cpu/memory/pids 限额也写进去了，
  // 但**没有任何进程被加进这个 cgroup**（`addProcess` 定义了却没人调用），
  // 于是所有限额都挂在一个空组上，配置看着齐全、实际一条都不生效。
  // 同期 `ulimit -u` 又以"交给 cgroup 管"为由被删掉了，净效果是进程数/内存/CPU
  // 三样限制同时归零。所以这里盯的不是"限额值对不对"，而是"进程到底进没进去"。
  describe('slot cgroup 归属', () => {
    const slotWithCgroup = {
      sentinel: { pid: 4242 },
      uid: 20005,
      gid: 20005,
      cgroup: { procsFiles: ['/sys/fs/cgroup/ap-sandbox/slot-0/cgroup.procs'] },
    }

    test('有 cgroup 时，命令必须先把自己写进 cgroup.procs 再 exec nsenter', () => {
      const { cmd, args } = buildSlotInvocation({ slot: slotWithCgroup, nsenterArgs: ['--target', '4242', '--', '/bin/bash', '-lc', 'echo hi'] })
      assert.equal(cmd, '/bin/sh')
      const script = args[1]
      assert.match(script, /cgroup\.procs/, '脚本里必须有把自己加进 cgroup 的那一步')
      assert.ok(
        script.indexOf('cgroup.procs') < script.indexOf('exec nsenter'),
        '必须在 exec 之前写——exec 之后再由别人搬，中间 fork 出来的进程就漏在限额之外了',
      )
    })

    test('用户命令走位置参数传给 sh，不拼进脚本字符串（否则就是一条 shell 注入路径）', () => {
      const evil = 'echo hi; rm -rf /'
      const { args } = buildSlotInvocation({
        slot: slotWithCgroup,
        nsenterArgs: ['--target', '4242', '--', '/bin/bash', '-lc', evil],
      })
      assert.ok(!args[1].includes(evil), '模型给的命令文本绝不能出现在 sh -c 的脚本里')
      assert.equal(args[2], 'sh', '$0 占位，后面才是 "$@" 收到的真实参数')
      assert.ok(args.includes(evil), '命令应该原样作为位置参数传下去')
      assert.match(args[1], /exec nsenter "\$@"/)
    })

    test('cgroup 写不进去就 exit 而不是继续跑 —— "限额没生效还照跑"正是最初的 bug', () => {
      const script = buildCgroupJoinScript(['/sys/fs/cgroup/x/cgroup.procs'])
      assert.match(script, /\|\|/, '写失败要有分支')
      assert.match(script, /exit 70/)
    })

    test('这台机器没有 cgroup 时不白包一层 sh，直接 nsenter', () => {
      const { cmd, args } = buildSlotInvocation({
        slot: { ...slotWithCgroup, cgroup: { procsFiles: [] } },
        nsenterArgs: ['--target', '4242'],
      })
      assert.equal(cmd, 'nsenter')
      assert.deepEqual(args, ['--target', '4242'])
    })

    test('cgroup 路径含 shell 元字符时拒绝拼脚本', () => {
      assert.throws(() => buildCgroupJoinScript(["/sys/fs/cgroup/'; rm -rf /;'/cgroup.procs"]), /不安全/)
    })

    // 线上事故的回归测试：v1 的共挂 controller 会把逗号写进挂载点名字，
    // 而安全白名单最初漏了逗号，导致 worker 在任何 cgroup v1 节点上直接启动失败。
    // 之前全部验证都在 v2 机器上做的，这条路径一次都没被执行过。
    test('cgroup v1 的共挂挂载点（含逗号）必须被接受', () => {
      for (const file of [
        '/sys/fs/cgroup/cpu,cpuacct/ap-sandbox/slot-0/cgroup.procs',
        '/sys/fs/cgroup/net_cls,net_prio/ap-sandbox/slot-0/cgroup.procs',
        '/sys/fs/cgroup/memory/ap-sandbox/slot-0/cgroup.procs',
      ]) {
        const script = buildCgroupJoinScript([file])
        assert.match(script, /exit 70/)
        assert.ok(script.includes(`'${file}'`), '路径要原样落在单引号里')
      }
    })

    test('逗号放行不等于放松校验：引号/空白/换行/命令替换仍然被拒', () => {
      for (const evil of [
        "/sys/fs/cgroup/cpu,cpuacct/x'/cgroup.procs",
        '/sys/fs/cgroup/cpu,cpuacct/$(id)/cgroup.procs',
        '/sys/fs/cgroup/cpu,cpuacct/`id`/cgroup.procs',
        '/sys/fs/cgroup/cpu, cpuacct/cgroup.procs',
        '/sys/fs/cgroup/cpu,cpuacct/x\n echo pwned/cgroup.procs',
      ]) {
        assert.throws(() => buildCgroupJoinScript([evil]), /不安全/, `应拒绝：${JSON.stringify(evil)}`)
      }
    })

    test('v1 三个 controller 各写一行 —— 少一行那项限额就不生效', () => {
      const files = [
        '/sys/fs/cgroup/cpu,cpuacct/ap-sandbox/slot-0/cgroup.procs',
        '/sys/fs/cgroup/memory/ap-sandbox/slot-0/cgroup.procs',
        '/sys/fs/cgroup/pids/ap-sandbox/slot-0/cgroup.procs',
      ]
      const lines = buildCgroupJoinScript(files).split('\n')
      assert.equal(lines.length, 3)
      files.forEach((f, i) => assert.ok(lines[i].includes(`'${f}'`)))
    })
  })

  test('路径逃逸被挡住', () => {
    /**
     * 根要先 `path.resolve` 一次。
     *
     * resolveInWorkspace 用的是**本平台**的 path（worker 只跑 linux，这是对的），
     * 而它拿 `path.resolve(root, rel)` 的结果去比 `root` 前缀。直接写死 `'/tmp/ws'`
     * 时，Windows 上会解析成 `C:\tmp\ws\a\b.txt`，跟字面量 `/tmp/ws` 一比就成了"逃逸" ——
     * 于是一条完全正常的相对路径把用例判红，报的还是"path 逃出了工作区"。
     * 被测的逻辑没问题，是夹具把 posix 路径写死了。
     */
    const root = path.resolve('/tmp/ws')
    assert.throws(() => resolveInWorkspace(root, '../../etc/passwd'), /逃出/)
    assert.throws(() => resolveInWorkspace(root, path.resolve('/etc/passwd')), /相对/)
    assert.throws(() => resolveInWorkspace(root, ''), /必填/)
    assert.equal(resolveInWorkspace(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'))
  })
})

const support = await probeNamespaceSupport()

describe('沙盒执行（需要 Linux + CAP_SYS_ADMIN + CAP_NET_ADMIN）', { skip: support.ok ? false : `跳过：${support.reason}` }, () => {
  let config
  let slotPool
  let leaseManager
  let app
  let baseUrl
  let workRoot

  before(async () => {
    // 有意用 /var/tmp 而不是 os.tmpdir()：下面「释放租约会中止仍在进行中的 exec」
    // 那条用例的观察点要**同时**被宿主和 slot 里的 job 看见，而 /tmp 现在是每个
    // slot 私有的 tmpfs（见 namespace/slot-pool.js 的 mountPrivateTmp），
    // 放在 /tmp 下面的话 job 写的是它自己那份，宿主这边永远看不到。
    // /var/tmp 没有被私有化，也正是生产默认的 SANDBOX_WORK_ROOT 所在。
    workRoot = await mkdtemp('/var/tmp/sbx-test-')
    // mkdtemp 建出来是 0700 且属主是 root（worker 的身份），而 job 降权到 slot 的
    // 专属 uid 之后连进都进不去。观察点落在这个目录里，所以这里放开权限。
    // 放开的只是测试用的临时根目录，各 slot 自己的工作区仍然是 0700 + 专属 uid，
    // 「两个租约的工作区互不可见」那条用例守着这一点。
    await chmod(workRoot, 0o777)
    config = loadConfig({
      NODE_ENV: 'test',
      SANDBOX_TOKEN: 'test-token-0123456789',
      SANDBOX_SLOTS: '2',
      SANDBOX_WORK_ROOT: workRoot,
      SANDBOX_NS_BRIDGE: 'sbxtestbr0',
      SANDBOX_NS_SUBNET: '10.252.0.0/16',
      EXEC_DEFAULT_TIMEOUT_MS: '5000',
      EXEC_MAX_TIMEOUT_MS: '10000',
      EXEC_MAX_OUTPUT_BYTES: '2048',
      EXEC_KILL_GRACE_MS: '300',
      LEASE_IDLE_TIMEOUT_MS: '60000',
    })
    const egressPolicy = createEgressPolicyStore({ config, logger: silentLogger })
    slotPool = createSlotPool({ config, logger: silentLogger, egressPolicy })
    await slotPool.init()
    leaseManager = createLeaseManager({ config, logger: silentLogger, slotPool })
    app = createServer({ config, logger: silentLogger, leaseManager, slotPool, egressPolicy })
    const address = await app.listen(0)
    baseUrl = `http://127.0.0.1:${address.port}`
    config.advertiseBase = baseUrl
  })

  after(async () => {
    await leaseManager.releaseAll('test')
    await app.close()
    await slotPool.shutdown()
    await rm(workRoot, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await leaseManager.releaseAll('test-reset')
  })

  const TOKEN = 'test-token-0123456789'
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

  async function lease(body = {}) {
    const res = await fetch(`${baseUrl}/v1/leases`, { method: 'POST', headers: auth, body: JSON.stringify({ runId: 'r', username: 'e', ...body }) })
    return { status: res.status, body: await res.json() }
  }

  /** 跑一条命令，把 NDJSON 帧收齐 */
  async function exec(leaseId, payload) {
    const res = await fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, {
      method: 'POST', headers: auth, body: JSON.stringify(payload),
    })
    const text = await res.text()
    const frames = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const stdout = frames.filter((f) => f.type === 'stdout').map((f) => f.data).join('')
    const stderr = frames.filter((f) => f.type === 'stderr').map((f) => f.data).join('')
    return {
      httpStatus: res.status,
      frames,
      stdout,
      stderr,
      exit: frames.find((f) => f.type === 'exit') || null,
      error: frames.find((f) => f.type === 'error') || null,
    }
  }

  describe('鉴权', () => {
    test('没有 token 一律拒绝', async () => {
      const res = await fetch(`${baseUrl}/v1/leases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      assert.equal(res.status, 401)
    })

    test('token 不对也拒绝', async () => {
      const res = await fetch(`${baseUrl}/v1/leases`, {
        method: 'POST', headers: { Authorization: 'Bearer wrong-token-xxxxxxx', 'Content-Type': 'application/json' }, body: '{}',
      })
      assert.equal(res.status, 401)
    })

    test('healthz 不需要鉴权，也不泄露用户信息', async () => {
      const res = await fetch(`${baseUrl}/healthz`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.ok, true)
      assert.ok(!JSON.stringify(body).includes('username'))
    })
  })

  describe('租约与槽位', () => {
    test('租约响应里回报本副本地址（后续 exec 靠它直连）', async () => {
      const { status, body } = await lease()
      assert.equal(status, 200)
      assert.equal(body.workerBase, baseUrl)
      assert.match(body.leaseId, /^lease_[0-9a-f]{24}$/)
    })

    test('槽位满了返回 429，让调用方换副本重试', async () => {
      await lease()
      await lease()
      const third = await lease()
      assert.equal(third.status, 429)
      assert.equal(third.body.error, 'no-free-slot')
    })

    test('释放后槽位放开', async () => {
      const a = await lease()
      await lease()
      assert.equal((await lease()).status, 429)
      await fetch(`${baseUrl}/v1/leases/${a.body.leaseId}`, { method: 'DELETE', headers: auth })
      assert.equal((await lease()).status, 200)
    })

    test('DELETE 幂等，不存在的租约也不报错', async () => {
      const res = await fetch(`${baseUrl}/v1/leases/lease_deadbeef/`, { method: 'DELETE', headers: auth })
      assert.ok(res.status === 200 || res.status === 404)
    })

    test('租约不存在时 exec 返回 404 而不是静默成功', async () => {
      const res = await fetch(`${baseUrl}/v1/leases/lease_nope/exec`, {
        method: 'POST', headers: auth, body: JSON.stringify({ command: 'echo hi' }),
      })
      assert.equal(res.status, 404)
    })

    test('idle 超时的租约会被清扫回收，slot 真的还回来了', async () => {
      // 模拟 agent service 崩了、没来 DELETE。
      //
      // 判据是 expiresAt 而不是 lastUsedAt：到期时刻会随活动往后滑，
      // 它才是"这个租约还能活多久"的唯一真相（见 leases.js 的 extend）。
      // 也不能用 leaseManager.get() 去拿租约再改 —— get 本身就算一次活动，
      // 会把刚拨老的到期时刻又推回去。
      //
      // 时限模型的完整用例在 test/lease-lifetime.test.js（不需要 Linux）；
      // 这里守的是它跑在**真 slot 池**上时槽位确实被交还了。
      const { body } = await lease()
      assert.equal(leaseManager.count(), 1)
      const before = leaseManager.slots().used

      const swept = await leaseManager.sweep(Date.now() + config.lease.maxLifetimeMs + 1)
      assert.equal(swept, 1)
      assert.equal(leaseManager.count(), 0, '槽位被永久占住了')
      assert.equal(leaseManager.slots().used, before - 1)

      // 收回来的槽位必须能立刻再被认领，否则只是账面上放开了
      assert.equal((await lease()).status, 200)
    })
  })

  describe('命令执行', () => {
    test('基本执行与退出码', async () => {
      const { body } = await lease()
      const ok = await exec(body.leaseId, { command: 'echo hello' })
      assert.equal(ok.stdout.trim(), 'hello')
      assert.equal(ok.exit.exitCode, 0)

      const fail = await exec(body.leaseId, { command: 'exit 3' })
      assert.equal(fail.exit.exitCode, 3)
    })

    test('stderr 单独成帧', async () => {
      const { body } = await lease()
      const result = await exec(body.leaseId, { command: 'echo oops >&2' })
      assert.match(result.stderr, /oops/)
      assert.equal(result.stdout, '')
    })

    test('同一租约内文件可跨多次 exec 保留 —— 租约设计的全部理由', async () => {
      const { body } = await lease()
      await exec(body.leaseId, { command: 'echo persisted > data.txt' })
      const read = await exec(body.leaseId, { command: 'cat data.txt' })
      assert.equal(read.stdout.trim(), 'persisted')
    })

    test('超时被中止，并给出 TIMEOUT 帧而不是干断', async () => {
      const { body } = await lease()
      const result = await exec(body.leaseId, { command: 'sleep 30', timeoutMs: 800 })
      assert.equal(result.error?.code, 'TIMEOUT')
      assert.ok(result.exit, '缺少 exit 帧，调用方无从判断结束')
    })

    test('输出超限被截断，而不是把调用方撑爆', async () => {
      const { body } = await lease()
      const result = await exec(body.leaseId, { command: 'head -c 100000 /dev/zero | tr "\\0" "x"' })
      assert.equal(result.exit.truncated, true)
      assert.ok(result.stdout.length <= config.exec.maxOutputBytes, `输出 ${result.stdout.length} 超过上限`)
      assert.match(result.stderr, /输出超过/)
    })

    test('相对 cwd 生效', async () => {
      const { body } = await lease()
      await exec(body.leaseId, { command: 'mkdir -p sub && echo inside > sub/f.txt' })
      const result = await exec(body.leaseId, { command: 'cat f.txt', cwd: 'sub' })
      assert.equal(result.stdout.trim(), 'inside')
    })

    test('绝对路径 cwd 被拒 —— agent 侧的绝对路径在容器里没有意义', async () => {
      const { body } = await lease()
      const result = await exec(body.leaseId, { command: 'pwd', cwd: '/etc' })
      assert.equal(result.error?.code, 'BAD_REQUEST')
    })

    test('cwd 不能用 ../ 逃出工作区', async () => {
      const { body } = await lease()
      const result = await exec(body.leaseId, { command: 'pwd', cwd: '../../..' })
      assert.equal(result.error?.code, 'BAD_REQUEST')
    })
  })

  describe('隔离性质', () => {
    test('job 拿不到 worker 的环境变量 —— SANDBOX_TOKEN 不能落到命令里', async () => {
      process.env.WORKER_ONLY_SECRET = 'worker-secret-value'
      try {
        const { body } = await lease()
        const result = await exec(body.leaseId, { command: 'env' })
        assert.ok(!result.stdout.includes('worker-secret-value'), 'worker 的环境变量泄漏进了 job')
        assert.ok(!result.stdout.includes(TOKEN), 'SANDBOX_TOKEN 泄漏进了 job —— job 可以自己申请租约执行任意命令')
      } finally {
        delete process.env.WORKER_ONLY_SECRET
      }
    })

    test('只有白名单内的环境变量能被调用方追加', async () => {
      const { body } = await lease()
      const result = await exec(body.leaseId, {
        command: 'echo "[$AP_RUN_ID][$LD_PRELOAD][$NODE_OPTIONS]"',
        env: { AP_RUN_ID: 'run-42', LD_PRELOAD: '/tmp/evil.so', NODE_OPTIONS: '--require /tmp/evil.js' },
      })
      assert.match(result.stdout, /\[run-42\]/, 'AP_* 变量应当被透传')
      assert.match(result.stdout, /\[\]\[\]/, 'LD_PRELOAD / NODE_OPTIONS 这类能改执行语义的变量必须被挡掉')
    })

    test('HOME 是 job 级的 —— 否则技能写进 homedir 的数据会跨用户', async () => {
      const a = await lease({ username: 'userA' })
      const b = await lease({ username: 'userB' })

      await exec(a.body.leaseId, { command: 'mkdir -p "$HOME/app" && echo SECRET_OF_A > "$HOME/app/store.txt"' })
      const peek = await exec(b.body.leaseId, { command: 'cat "$HOME/app/store.txt" 2>&1 || true' })

      assert.ok(!peek.stdout.includes('SECRET_OF_A'), 'B 读到了 A 写进 HOME 的数据')

      // namespace 化之后，两个租约的 $HOME **就是同一个路径字符串**（/sandbox-root/home）——
      // 它是每个 slot 私有 mount namespace 里的固定挂载点，路径相同但指向不同的目录。
      // 所以不能再按老办法断言"路径不一样"（那是每租约一个宿主目录时代的写法），
      // 要断言的是"同名不同物"：inode 不同，且宿主侧的真实目录不同。
      const homeA = (await exec(a.body.leaseId, { command: 'echo $HOME' })).stdout.trim()
      const homeB = (await exec(b.body.leaseId, { command: 'echo $HOME' })).stdout.trim()
      assert.equal(homeA, homeB, '两个 slot 看到的 HOME 路径本来就该一样，不一样反而说明挂载点不是固定的')

      const inodeA = (await exec(a.body.leaseId, { command: 'stat -c %i "$HOME"' })).stdout.trim()
      const inodeB = (await exec(b.body.leaseId, { command: 'stat -c %i "$HOME"' })).stdout.trim()
      assert.notEqual(inodeA, inodeB, '同一个路径要指向两个不同的目录，否则就是同一个 HOME')
      assert.notEqual(
        leaseManager.get(a.body.leaseId).workspace.homeDir,
        leaseManager.get(b.body.leaseId).workspace.homeDir,
        '宿主侧的真实 home 目录必须是两个',
      )
    })

    test('两个租约的工作区互不可见', async () => {
      const a = await lease({ username: 'userA' })
      const b = await lease({ username: 'userB' })
      await exec(a.body.leaseId, { command: 'echo SECRET_A > mine.txt' })
      const peek = await exec(b.body.leaseId, { command: 'cat mine.txt 2>&1 || true' })
      assert.ok(!peek.stdout.includes('SECRET_A'))
    })

    test('释放租约后工作区从磁盘上消失', async () => {
      const { body } = await lease()
      const baseDir = leaseManager.get(body.leaseId).workspace.baseDir
      await exec(body.leaseId, { command: 'echo data > f.txt' })
      assert.ok(existsSync(baseDir))

      await fetch(`${baseUrl}/v1/leases/${body.leaseId}`, { method: 'DELETE', headers: auth })
      assert.ok(!existsSync(baseDir), '工作区没删掉，磁盘上残留用户数据')
    })

    /**
     * 观察点放在工作区**外面**（workRoot 下），因为释放租约会把工作区整个删掉，
     * 删掉之后就分不清"进程死了"还是"文件没了"。
     */
    async function sizeOf(file) {
      return existsSync(file) ? (await readFile(file, 'utf8')).length : 0
    }

    test('后台进程不会活过它那次 exec —— 整个 PID namespace 会被回收', async () => {
      const { body } = await lease()
      const watch = path.join(workRoot, `bg-${Date.now()}.txt`)

      await exec(body.leaseId, {
        command: `nohup bash -c 'for i in $(seq 1 200); do echo tick >> ${watch}; sleep 0.05; done' >/dev/null 2>&1 & echo started`,
        timeoutMs: 3000,
      })
      // exec 一返回，它 spawn 的后台进程就该被连坐杀掉
      const atReturn = await sizeOf(watch)
      await new Promise((resolve) => setTimeout(resolve, 700))
      const later = await sizeOf(watch)

      assert.equal(later, atReturn, `后台进程在 exec 返回后仍在写文件（${atReturn} → ${later}）—— 进程组没杀干净，它会活到下一个用户的 job 期间`)
      await rm(watch, { force: true })
    })

    test('释放租约会中止仍在进行中的 exec', async () => {
      const acquired = await leaseManager.acquire({ runId: 'r', username: 'e' })
      const watch = path.join(workRoot, `inflight-${Date.now()}.txt`)

      const controller = new AbortController()
      acquired.running.add(controller)
      const inflight = execCommand({
        config,
        logger: silentLogger,
        workspace: acquired.workspace.guest,
        slot: acquired.slot,
        command: `for i in $(seq 1 200); do echo tick >> ${watch}; sleep 0.05; done`,
        timeoutMs: 20000,
        signal: controller.signal,
        onFrame: () => {},
      })

      await new Promise((resolve) => setTimeout(resolve, 400))
      assert.ok((await sizeOf(watch)) > 0, '命令没跑起来，这条用例就没在测东西')

      await leaseManager.release(acquired.leaseId, { reason: 'test' })
      const result = await inflight
      assert.ok(result.aborted || result.signal, '释放租约后命令没有被中止')

      const atRelease = await sizeOf(watch)
      await new Promise((resolve) => setTimeout(resolve, 600))
      assert.equal(await sizeOf(watch), atRelease, '释放租约后命令仍在写文件')
      await rm(watch, { force: true })
    })
  })

  describe('异步执行：断开 ≠ 放弃', () => {
    /** 起一个异步任务，回 execId */
    async function startAsync(leaseId, payload) {
      const res = await fetch(`${baseUrl}/v1/leases/${leaseId}/exec`, {
        method: 'POST', headers: auth, body: JSON.stringify({ ...payload, async: true }),
      })
      assert.equal(res.status, 200)
      return (await res.json()).execId
    }

    /**
     * 读事件流。`stopAfter` 条帧之后主动断开 —— 模拟网络抖动 / 切标签页。
     * 返回收到的帧；断开的那次不等流结束。
     */
    async function readEvents(leaseId, execId, { fromSeq = 0, stopAfter = 0 } = {}) {
      const controller = new AbortController()
      const res = await fetch(
        `${baseUrl}/v1/leases/${leaseId}/execs/${execId}/events?fromSeq=${fromSeq}&heartbeatMs=1000`,
        { headers: auth, signal: controller.signal },
      )
      assert.equal(res.status, 200)

      const frames = []
      const decoder = new TextDecoder()
      const reader = res.body.getReader()
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.trim()) continue
            const frame = JSON.parse(line)
            if (frame.type === 'heartbeat') continue
            frames.push(frame)
            if (stopAfter && frames.length >= stopAfter) {
              controller.abort()
              return frames
            }
          }
        }
      } catch (error) {
        if (error?.name !== 'AbortError') throw error
      }
      return frames
    }

    test('立刻回 execId，之后能取到完整输出', async () => {
      const { body } = await lease()
      const execId = await startAsync(body.leaseId, { command: 'echo hi; echo bad >&2; exit 7' })
      assert.match(execId, /^exe_[0-9a-f]{16}$/)

      const frames = await readEvents(body.leaseId, execId)
      assert.equal(frames.map((f) => f.data).join('').includes('hi'), true)
      const exit = frames.at(-1)
      assert.equal(exit.type, 'exit')
      assert.equal(exit.exitCode, 7)
      // seq 必须连续，续传全靠它
      assert.deepEqual(frames.map((f) => f.seq), frames.map((_, i) => i + 1))
    })

    test('断开事件流不杀命令 —— 这是异步模式存在的全部理由', async () => {
      // 同步模式下 `req.on('close')` 会直接 abort。切个标签页、网关掐一次
      // 空闲连接，一条跑了四分钟的 npm install 就白跑，而且工作区里留下的是
      // 半装完的 node_modules，比彻底没跑还糟。
      const { body } = await lease()
      const watch = path.join(workRoot, `async-alive-${Date.now()}`)
      // **必须往 stdout 写**，不能只写文件：断点要落在命令**执行中间**才有意义。
      // 只写文件的话第一帧要等到命令结束才出现，那时候再断开什么也证明不了 ——
      // 这条用例最早就是这么写的，注入"断开即杀"的变异它照样绿。
      const execId = await startAsync(body.leaseId, {
        command: `for i in 1 2 3 4 5 6 7 8; do echo tick$i; echo tick$i >> ${watch}; sleep 0.25; done`,
        timeoutMs: 8000,
      })

      // 收到第一帧（此时命令刚开始跑）就断开
      const early = await readEvents(body.leaseId, execId, { stopAfter: 1 })
      assert.equal(early[0].type, 'stdout', '断点没有落在执行中间')
      const linesAtCut = (await readFile(watch, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length

      // 断开期间它必须**继续往前跑**
      await new Promise((resolve) => setTimeout(resolve, 600))
      const linesAfter = (await readFile(watch, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length
      assert.ok(linesAfter > linesAtCut, `断开后命令停了（断开时 ${linesAtCut} 行，600ms 后还是 ${linesAfter} 行）`)

      // 回来接着取，最终能拿到正常的 exit
      const frames = await readEvents(body.leaseId, execId, { fromSeq: early.at(-1).seq })
      const exit = frames.at(-1)
      assert.equal(exit.type, 'exit')
      assert.equal(exit.exitCode, 0, '命令被断开连接误杀了')
      assert.equal(exit.status, 'completed')
      await rm(watch, { force: true })
    })

    test('带 fromSeq 重连：不重不漏', async () => {
      const { body } = await lease()
      const execId = await startAsync(body.leaseId, {
        command: 'for i in 1 2 3 4 5; do echo line$i; sleep 0.15; done',
        timeoutMs: 8000,
      })

      const first = await readEvents(body.leaseId, execId, { stopAfter: 2 })
      assert.equal(first.length, 2)
      const lastSeq = first.at(-1).seq

      const rest = await readEvents(body.leaseId, execId, { fromSeq: lastSeq })
      // 续传的第一帧必须紧接着断点，中间不能少
      assert.equal(rest[0].seq, lastSeq + 1)
      // 也不能把已经收过的重发一遍
      assert.equal(rest.some((f) => f.seq <= lastSeq), false)

      const all = [...first, ...rest]
      const text = all.filter((f) => f.type === 'stdout').map((f) => f.data).join('')
      for (const i of [1, 2, 3, 4, 5]) assert.ok(text.includes(`line${i}`), `丢了 line${i}`)
    })

    test('结束之后再来订阅，历史照样完整', async () => {
      // 最常见的情形：断线期间命令就跑完了。
      const { body } = await lease()
      const execId = await startAsync(body.leaseId, { command: 'echo finished' })
      await new Promise((resolve) => setTimeout(resolve, 500))

      const frames = await readEvents(body.leaseId, execId)
      assert.ok(frames.filter((f) => f.type === 'stdout').map((f) => f.data).join('').includes('finished'))
      assert.equal(frames.at(-1).type, 'exit')
    })

    test('DELETE 才是"放弃"，这时候命令真的被杀', async () => {
      const { body } = await lease()
      const execId = await startAsync(body.leaseId, { command: 'sleep 30', timeoutMs: 20000 })

      const res = await fetch(`${baseUrl}/v1/leases/${body.leaseId}/execs/${execId}`, { method: 'DELETE', headers: auth })
      assert.equal(res.status, 200)
      assert.equal((await res.json()).aborted, true)

      const frames = await readEvents(body.leaseId, execId)
      assert.equal(frames.at(-1).type, 'exit')
      assert.equal(frames.at(-1).status, 'aborted')
    })

    test('异步任务在跑时租约不会被 idle 回收', async () => {
      // 异步任务同样要登记进 lease.running，否则清扫会在它跑着的时候
      // 把整个 slot 销毁重建。
      const { body } = await lease()
      await startAsync(body.leaseId, { command: 'sleep 3', timeoutMs: 10000 })

      const swept = await leaseManager.sweep(Date.now() + config.lease.idleTimeoutMs * 10)
      assert.equal(swept, 0, '正在跑异步任务的租约被回收了')
      assert.equal(leaseManager.count(), 1)
    })

    test('未知 execId 返回 404，不是空流', async () => {
      const { body } = await lease()
      const res = await fetch(`${baseUrl}/v1/leases/${body.leaseId}/execs/exe_00000000000000ff/events`, { headers: auth })
      assert.equal(res.status, 404)
    })
  })

  describe('文件上下行', () => {
    test('上传 → 命令可见 → 取回产物', async () => {
      const { body } = await lease()
      const put = await fetch(`${baseUrl}/v1/leases/${body.leaseId}/files`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ path: 'in/data.txt', contentBase64: Buffer.from('hello file').toString('base64') }),
      })
      assert.equal(put.status, 200)

      const seen = await exec(body.leaseId, { command: 'cat in/data.txt && tr a-z A-Z < in/data.txt > out.txt' })
      assert.equal(seen.stdout.trim(), 'hello file')

      const get = await fetch(`${baseUrl}/v1/leases/${body.leaseId}/files?path=out.txt`, { headers: auth })
      const got = await get.json()
      assert.equal(Buffer.from(got.contentBase64, 'base64').toString('utf8').trim(), 'HELLO FILE')
    })

    test('取不存在的文件返回 404', async () => {
      const { body } = await lease()
      const res = await fetch(`${baseUrl}/v1/leases/${body.leaseId}/files?path=nope.txt`, { headers: auth })
      assert.equal(res.status, 404)
    })
  })
})
