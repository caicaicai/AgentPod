/**
 * 每个 slot 一张独立虚拟网卡 + 独立 network namespace。
 *
 * 白名单规则直接挂在**每个 slot 自己的 network namespace**内部（`OUTPUT` 链），
 * 不依赖 uid 匹配——按 uid 过滤（`iptables -m owner --uid-owner`）在多个 slot
 * 并发时分不清是哪个 slot 发的包，只能保证"大家都只能连 DNS+Bridge"，保证不了
 * "slot 之间互相隔离"。netns 本身就是隔离边界，规则天然只对这一个 slot 生效，
 * 不需要用 uid 去"猜"是谁发的包。
 *
 * 拓扑：host 侧一个网桥（sandbr0）+ 每个 slot 一对 veth，一端进 slot 的 netns，
 * 一端接网桥。host 侧对网桥子网做 MASQUERADE，这样 slot 才能经由 worker 容器
 * 本身的出口访问到 Cloud Bridge（否则 slot 的 netns 只是个孤岛，连自己都出不去）。
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

function run(cmd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0 || allowFail) resolve({ code, stdout, stderr })
      else reject(Object.assign(new Error(`${cmd} ${args.join(' ')} 失败 (code=${code}): ${stderr.trim()}`), { code: 'CMD_FAILED', stdout, stderr }))
    })
  })
}

/** 在某个 sentinel 的 network namespace 内跑一条命令 */
function runInNetns(sentinelPid, cmd, args, opts) {
  return run('nsenter', ['--target', String(sentinelPid), '--net', '--', cmd, ...args], opts)
}

/** 把 `10.250.0.0/16` 这样的 CIDR 拆成 { base, prefix } */
function parseCidr(cidr) {
  const [base, prefixStr] = String(cidr).split('/')
  return { base, prefix: Number(prefixStr) }
}

/** 桥的地址固定用子网里的 .1；slot 的地址用 index+2 起（.1 留给桥，.0 是网络号） */
function bridgeIp(config) {
  const { base, prefix } = parseCidr(config.namespace.subnetCidr)
  const parts = base.split('.').map(Number)
  parts[3] = 1
  return { ip: parts.join('.'), prefix }
}

function slotIp(config, index) {
  const { base, prefix } = parseCidr(config.namespace.subnetCidr)
  const parts = base.split('.').map(Number)
  // 简单起见只处理 /16 及以内、slot 数不超过 253 的场景——够用，
  // 真要支持更大规模再扩成多字节进位。
  parts[3] = 2 + index
  return { ip: parts.join('.'), prefix }
}

/** 找容器对外的主网卡名——egress 的 MASQUERADE 要靠它出去 */
async function findEgressInterface() {
  const { stdout } = await run('ip', ['route', 'show', 'default'])
  const match = stdout.match(/dev\s+(\S+)/)
  return match ? match[1] : null
}

/** 幂等地在 FORWARD 链头部插入一条放行规则——用 -I 而不是 -A，见下面的说明 */
async function ensureForwardAccept(args) {
  const check = await run('iptables', ['-C', 'FORWARD', ...args], { allowFail: true })
  if (check.code !== 0) {
    await run('iptables', ['-I', 'FORWARD', ...args])
  }
}

/**
 * 建 host 侧网桥（幂等）：所有 slot 的 veth 都接在这上面。
 * 顺带打开 ip_forward + 给桥子网做 MASQUERADE——没有这一步，slot 的 netns
 * 只是个连自己都出不去的孤岛，桥接是通了但没有到外面的路。
 *
 * **在已经跑着 Docker/K8s 的机器上，这还不够。** 实测踩过：veth/netns/IP
 * 全部配置成功，但 slot 连网桥自己的地址都 ping 不通——原因是这类机器的
 * `iptables FORWARD` 链默认策略通常已经是 `DROP`（只给 `docker0`/`cni0` 这类
 * "认识的"网桥放行），而网桥一旦挂了 `br_netfilter`，桥内转发的包也要过宿主机
 * 的 `FORWARD` 链。我们新建的网桥不在别人的放行名单里，包就在这一步被丢了，
 * 且**不会有任何错误提示**——veth/netns 层面看起来一切正常，只有实际转发不通。
 * 所以必须显式给自己的网桥加 FORWARD 放行规则，不能假设网桥转发默认就通。
 * 用 `-I`（插到链头）而不是 `-A`（追加到链尾）：如果 FORWARD 链默认策略是
 * DROP 且前面还有别的规则，追加到最后可能永远轮不到。
 */
export async function ensureBridge({ config, logger }) {
  const name = config.namespace.bridgeName
  const { ip, prefix } = bridgeIp(config)

  const existing = await run('ip', ['link', 'show', name], { allowFail: true })
  if (existing.code !== 0) {
    await run('ip', ['link', 'add', name, 'type', 'bridge'])
    await run('ip', ['addr', 'add', `${ip}/${prefix}`, 'dev', name])
    await run('ip', ['link', 'set', name, 'up'])
    logger.info('网桥已创建', { name, ip: `${ip}/${prefix}` })
  } else {
    logger.info('网桥已存在，复用', { name })
  }

  await run('sh', ['-c', 'echo 1 > /proc/sys/net/ipv4/ip_forward'], { allowFail: true })

  await ensureForwardAccept(['-i', name, '-j', 'ACCEPT'])
  await ensureForwardAccept(['-o', name, '-j', 'ACCEPT'])
  logger.info('已放行 FORWARD 链上本网桥的转发流量', { name })

  const egressIf = await findEgressInterface()
  if (!egressIf) {
    logger.error('找不到默认路由网卡，slot 的出站 MASQUERADE 规则无法配置', {})
    return { name, ip, prefix, egressIf: null }
  }

  const { base, prefix: subnetPrefix } = parseCidr(config.namespace.subnetCidr)
  const subnet = `${base}/${subnetPrefix}`
  // 幂等：先删再加，避免重复启动时叠加规则
  await run('iptables', ['-t', 'nat', '-D', 'POSTROUTING', '-s', subnet, '-o', egressIf, '-j', 'MASQUERADE'], { allowFail: true })
  await run('iptables', ['-t', 'nat', '-A', 'POSTROUTING', '-s', subnet, '-o', egressIf, '-j', 'MASQUERADE'])
  logger.info('已配置 slot 子网到宿主出口的 MASQUERADE', { subnet, egressIf })

  return { name, ip, prefix, egressIf }
}

/**
 * 给一个 slot 建 veth + 接进它的 netns + 配 IP/路由 + 挂出站白名单。
 * 出站白名单规则直接写在 slot 自己的 netns 里，不依赖 uid。
 */
export async function setupSlotNetwork({ config, logger, index, sentinelPid, policy, persistent = [] }) {
  const bridgeName = config.namespace.bridgeName
  const vethHost = `veth-s${index}`
  const vethGuest = `veth-s${index}p`
  const { ip, prefix } = slotIp(config, index)
  const { ip: gatewayIp } = bridgeIp(config)

  // 幂等：万一上次没清干净，先删掉同名的
  await run('ip', ['link', 'del', vethHost], { allowFail: true })

  await run('ip', ['link', 'add', vethHost, 'type', 'veth', 'peer', 'name', vethGuest])
  await run('ip', ['link', 'set', vethHost, 'master', bridgeName])
  await run('ip', ['link', 'set', vethHost, 'up'])
  // 把另一端丢进 slot 的 netns——之后这张网卡就只能从里面看到了
  await run('ip', ['link', 'set', vethGuest, 'netns', String(sentinelPid)])

  await runInNetns(sentinelPid, 'ip', ['link', 'set', 'lo', 'up'])
  await runInNetns(sentinelPid, 'ip', ['link', 'set', vethGuest, 'name', 'eth0'])
  await runInNetns(sentinelPid, 'ip', ['addr', 'add', `${ip}/${prefix}`, 'dev', 'eth0'])
  await runInNetns(sentinelPid, 'ip', ['link', 'set', 'eth0', 'up'])
  await runInNetns(sentinelPid, 'ip', ['route', 'add', 'default', 'via', gatewayIp])

  const egress = await programSlotEgress({ config, logger, sentinelPid, policy, persistent })

  // slot 有独立的 mount namespace，需要写入正确的 /etc/resolv.conf
  // 使之指向真实可达的 DNS 服务器（而非容器原始的 127.0.0.11）。
  //
  // 关键：不能直接 `printf > /etc/resolv.conf`——虽然 sentinel 有独立 mount namespace，
  // 但 unshare --mount 只是克隆了 mount table，底层文件系统仍与父（容器）共享。
  // 直接写会覆盖容器自己的 /etc/resolv.conf，导致容器丢失 Docker 内部 DNS (127.0.0.11)，
  // 无法解析其他容器的服务名。
  // 正确做法：先写到临时文件，再 bind mount 到 /etc/resolv.conf 上。
  // mount namespace 是 rprivate 的，bind mount 只在 slot 内可见。
  if (egress.nameservers?.length) {
    const content = egress.nameservers.map((ns) => `nameserver ${ns}`).join('\\n')
    await run('nsenter', [
      '--target', String(sentinelPid), '--mount', '--',
      'sh', '-c',
      `printf '${content}\\n' > /tmp/.resolv.conf.slot && mount --bind /tmp/.resolv.conf.slot /etc/resolv.conf`,
    ])
  }

  logger.info('slot 网络已就绪', {
    index,
    ip,
    vethHost,
    enforced: egress.enforced,
    dns: egress.nameservers,
  })
  return { vethHost, vethGuest, ip, egress }
}

/**
 * 确定 slot 使用的 DNS 服务器。优先级：
 *   1. SANDBOX_DNS_SERVERS 环境变量（显式指定）
 *   2. /etc/resolv.conf 中的 nameserver（自动探测）
 *
 * Docker Desktop 的内嵌 DNS（127.0.0.11）在 slot 的 network namespace 里
 * 连不上——回环地址指向 slot 自己的 lo。遇到这种情况会自动回退到公共 DNS。
 */
async function resolveNameservers(logger, config) {
  const explicit = config?.namespace?.dnsServers
  if (explicit?.length) {
    const valid = explicit.filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip))
    if (valid.length) {
      logger.info('使用 SANDBOX_DNS_SERVERS 指定的 DNS 服务器', { servers: valid })
      return valid
    }
  }

  const raw = await readFile('/etc/resolv.conf', 'utf8').catch(() => '')
  const ips = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('nameserver'))
    .map((line) => line.split(/\s+/)[1])
    .filter((ip) => ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip))

  const loopback = ips.filter((ip) => ip.startsWith('127.'))
  const real = ips.filter((ip) => !ip.startsWith('127.'))

  if (loopback.length && !real.length) {
    const fallback = ['8.8.8.8', '1.1.1.1']
    logger.warn('resolv.conf 里的 nameserver 全是回环地址，slot 里连不上，自动回退到公共 DNS', {
      loopback, fallback,
      fix: '设置 SANDBOX_DNS_SERVERS 环境变量可指定自定义 DNS',
    })
    return fallback
  }

  if (!ips.length) {
    logger.warn('/etc/resolv.conf 里没读到 IPv4 nameserver，将放行到任意主机的 53 端口', {})
  }
  return [...new Set(real.length ? real : ips)]
}

/**
 * 编排一个 slot 的整条 OUTPUT 链。**建 slot 与运行时改策略走的是同一个函数** ——
 * 两条路径各写一份的话，"新建的 slot 和重编程过的 slot 规则不一样"会是一个
 * 只在特定时序下出现、且 `iptables -S` 看起来都正常的差异。
 *
 * 拦截模式（`policy.enforce`）下只放行：已建立连接的回包、DNS、Cloud Bridge、
 * 策略里的常开目标，其余 REJECT。整个 netns 里除了这一个 slot 的 job 不会有
 * 任何别的东西，不需要再靠 uid 匹配去区分"这个包是不是该被管"。
 *
 * **两条路径都先把链清空，且清空时策略停在收紧的那一侧**，任何时刻都不存在
 * "短暂全开"的窗口：
 *   - 要拦 → 先 `-P DROP` 再 `-F`，中间是"全关"；
 *   - 不拦 → 先 `-F` 再 `-P ACCEPT`，中间还是"全关"。
 * 反过来写（先放开再收紧）在重编程时就是一个真实的逃逸窗口，而且宽度取决于
 * 几条 iptables 命令的执行时间 —— 不可观测、不可复现。
 *
 * @returns {{enforced: boolean, allowedIps: string[], host: string, port: number}}
 *   实际放行了哪些地址。调用方把它挂到 slot 上，`/healthz` 才能如实报告
 *   "白名单里到底有没有东西"—— 规则挂上了但一条放行都没有（配错 host、
 *   DNS 解析不出来）的话，出站是锁死了，可用的目标却是零，每个技能的网络请求
 *   都会失败。这种"锁得很成功但没用"必须能从外面看见，不能只留一条启动日志。
 */
export async function programSlotEgress({ config, logger, sentinelPid, policy, persistent = [] }) {
  const enforce = policy?.enforce !== false
  const nameservers = await resolveNameservers(logger, config)

  if (!enforce) {
    for (const args of buildEgressPlan({ enforce: false })) {
      await runInNetns(sentinelPid, 'iptables', args)
    }
    logger.info('本 slot 的出站拦截已关闭，沙盒可自由访问网络', {
      source: policy?.source || 'unknown',
      revision: policy?.revision || '',
    })
    return { enforced: false, allowedIps: [], nameservers, extra: [] }
  }

  const extra = await resolveTargets({ logger, entries: policy?.allow || [], reason: '策略常开' })
  const persistentResolved = await resolveTargets({ logger, entries: persistent, reason: '管理端长期放行' })
  const allExtra = [...extra, ...persistentResolved]
  if (allExtra.length) {
    logger.warn('已在 slot 出站白名单上额外开放目标', {
      targets: allExtra.map((a) => `${a.host}:${a.ports.join('/')}`),
    })
  }

  for (const args of buildEgressPlan({ enforce: true, nameservers, extra: allExtra })) {
    await runInNetns(sentinelPid, 'iptables', args)
  }
  return { enforced: true, allowedIps: [], nameservers, extra: allExtra }
}

/**
 * 整条 OUTPUT 链的**命令清单**（纯函数，不碰网络也不碰 iptables）。
 *
 * 拆出来是因为这里的正确性几乎全在**顺序**上，而顺序错了的样子和对的样子在
 * `iptables -S` 里几乎一模一样。同一个坑这个文件里已经踩过一次：`applyLeaseEgress`
 * 当初用 `-A` 追加，结果规则落在兜底 REJECT **后面**，挂上了却一个包也放不过去。
 * 做成纯函数之后，这些不变量可以在任何机器上直接断言，不需要 Linux + 特权容器。
 *
 * 两条不变量：
 *
 *   1. **任何时刻都不存在"短暂全开"的窗口。** 要拦 → 先 `-P DROP` 再 `-F`；
 *      不拦 → 先 `-F` 再 `-P ACCEPT`。两条路径中间那一瞬都是"全关"。
 *      反过来写（先放开再收紧）在重编排一个 slot 时就是真实的逃逸窗口，
 *      宽度取决于几条命令的执行时间 —— 不可观测、不可复现。
 *   2. **兜底 REJECT 永远是最后一条。** 它前面的都是放行，它后面的一律进不来。
 */
export function buildEgressPlan({ enforce, nameservers = [], extra = [] }) {
  if (!enforce) return [['-F', 'OUTPUT'], ['-P', 'OUTPUT', 'ACCEPT']]

  const plan = [
    ['-P', 'OUTPUT', 'DROP'],
    ['-F', 'OUTPUT'],
    ['-A', 'OUTPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'],
  ]

  if (nameservers.length) {
    for (const dns of nameservers) {
      plan.push(['-A', 'OUTPUT', '-p', 'udp', '-d', dns, '--dport', '53', '-j', 'ACCEPT'])
      plan.push(['-A', 'OUTPUT', '-p', 'tcp', '-d', dns, '--dport', '53', '-j', 'ACCEPT'])
    }
  } else {
    plan.push(['-A', 'OUTPUT', '-p', 'udp', '--dport', '53', '-j', 'ACCEPT'])
    plan.push(['-A', 'OUTPUT', '-p', 'tcp', '--dport', '53', '-j', 'ACCEPT'])
  }

  // 常开目标用 `-A` 追加在兜底 REJECT **之前** —— 这条链是刚刚清空重建的，
  // 顺序由 push 顺序决定，不需要 `-I` 那套"插到链首"的技巧。
  for (const target of extra) {
    for (const ip of target.ips || []) {
      for (const p of target.ports) {
        plan.push(['-A', 'OUTPUT', '-p', 'tcp', '-d', ip, '--dport', String(p), '-j', 'ACCEPT'])
      }
    }
  }

  // 兜底 REJECT。用 REJECT 而不是靠 -P DROP 兜底是有意的：DROP 会让被拦的连接
  // 一直挂到超时，技能表现为"卡住"，排查时看不出是被墙了还是对端慢；REJECT
  // 立刻回 ICMP port unreachable，curl 直接报 `Connection refused`（exit 7），
  // 一眼就知道是被本地规则拦下的。**这条报错正是白名单在生效的证据。**
  plan.push(['-A', 'OUTPUT', '-j', 'REJECT', '--reject-with', 'icmp-port-unreachable'])
  return plan
}

/**
 * 出站目标的合法字符集：主机名或 IPv4 字面量，且首尾必须是字母数字。
 *
 * **这条校验在配置有了远端来源之后才从"锦上添花"变成必需品。** host 会被原样
 * 交给 `getent`（`spawn`，无 shell，所以从来不存在注入），但一个带空格或奇怪
 * 字符的 host 只会静默解析失败 —— 现象是"下发了却没生效"，而 `iptables -S`
 * 里连痕迹都没有。宁可在解析这一步就丢掉。
 */
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

function validHost(host) {
  return typeof host === 'string' && host.length > 0 && host.length <= 253 && HOST_RE.test(host)
}

const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535

/** `host` / `host:port` → `{ host, ports }`，不写端口按 80+443 放行（浏览器要用）。 */
export function parseEgressAllow(raw) {
  const out = []
  for (const item of String(raw || '').split(',')) {
    const entry = item.trim()
    if (!entry) continue
    const [host, portRaw] = entry.split(':')
    if (!validHost(host)) continue
    if (portRaw === undefined) {
      out.push({ host, ports: [80, 443] })
      continue
    }
    const port = Number(portRaw)
    if (!validPort(port)) continue
    out.push({ host, ports: [port] })
  }
  return out
}

/**
 * 管理端下发的结构化条目 → 与 `parseEgressAllow` 同形的清单。
 *
 * **不因为来源是管理端就少校验一遍。** 管理端是控制面，不是可信输入源：
 * 它的配置同样是人手写的，而这里每接受一条就是在承重墙上开一道门。
 *
 * 与字符串形式有一处**故意的不同**：端口缺失时整条丢弃，不补 80+443。
 * 补默认值在字符串形式里是"运维少打几个字"，在这里则是"对着一条读不懂的
 * 下发内容猜它想开哪些端口"—— 猜错的方向是多开，没有任何现象。
 */
export function normalizeEgressEntries(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const host = typeof item?.host === 'string' ? item.host.trim() : ''
    if (!validHost(host)) continue
    const ports = [...new Set((Array.isArray(item?.ports) ? item.ports : []).map(Number).filter(validPort))]
    if (!ports.length) continue
    out.push({ host, ports: ports.sort((a, b) => a - b) })
  }
  return out
}

/**
 * 把调用方申请的放行目标与节点的准入清单比对。
 *
 * **主机名必须完全相同**，不做通配、不做后缀匹配：`allowed=xiaocaicai.com` 若能匹配
 * `evil-xiaocaicai.com` 或 `a.xiaocaicai.com`，这份清单就形同虚设，而写清单的人多半意识不到。
 * 端口必须是清单里那条允许的端口的子集。
 *
 * @returns {{allowed: Array, rejected: string[]}} rejected 里是原样的申请项，
 *   要回给调用方 —— 静默丢弃会让它以为开了，然后对着 `Connection refused`
 *   往技能自己身上找原因。
 */
export function screenEgressRequest(requested, menu) {
  const byHost = new Map()
  for (const entry of menu) {
    const ports = new Set([...(byHost.get(entry.host)?.ports || []), ...entry.ports])
    byHost.set(entry.host, { host: entry.host, ports })
  }

  const allowed = []
  const rejected = []
  for (const entry of requested) {
    const permitted = byHost.get(entry.host)
    if (!permitted) {
      rejected.push(`${entry.host}:${entry.ports.join('/')}`)
      continue
    }
    const ports = entry.ports.filter((p) => permitted.ports.has(p))
    if (!ports.length) {
      rejected.push(`${entry.host}:${entry.ports.join('/')}`)
      continue
    }
    allowed.push({ host: entry.host, ports })
  }
  return { allowed, rejected }
}

/** 主机名 → IPv4 列表。解析不出来回空数组，由调用方决定怎么说这件事。 */
async function resolveHost(host) {
  const { stdout } = await run('getent', ['ahostsv4', host], { allowFail: true })
  return [...new Set(stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean))]
}

/**
 * 把额外放行目标解析成 IP。默认为空 —— 出站白名单是承重墙，加一条就是开一道门。
 *
 * 只解析、不挂规则：规则由 `buildEgressPlan` 统一按顺序排。
 */
async function resolveTargets({ logger, entries, reason }) {
  const resolved = []
  for (const { host, ports } of entries || []) {
    const ips = await resolveHost(host)
    if (!ips.length) {
      // 解析不出来就是这条规则没生效，必须说出来：否则表现是"配了却还是打不开"，
      // 而 iptables 里看不到任何痕迹，很难想到是 DNS 的问题。
      logger.error('额外放行目标解析不出地址，该规则未生效', { host, reason })
      continue
    }
    resolved.push({ host, ips, ports })
  }
  return resolved
}

/**
 * 租约期临时放行。与节点级的 `SANDBOX_EGRESS_ALLOW` 的差别：
 * 那份对**所有 slot 永远**生效，这份只对**要了它的那一个租约**生效，
 * 而且租约一释放、slot 整体销毁重建，规则跟着一起没了 —— 不需要任何清理路径，
 * 也就不存在"忘了收回"这个选项。
 *
 * **必须用 `-I` 插到链首，不能用 `-A`。** 兜底 REJECT 是建 slot 时用 `-A` 追加的
 * 最后一条，租约期再 `-A` 会落在它**后面**，规则挂上了却一个包也放不过去 ——
 * 而 `iptables -S` 看起来完全正常。
 */
export async function applyLeaseEgress({ logger, sentinelPid, entries }) {
  const applied = []
  for (const { host, ports } of entries) {
    const { stdout } = await run('getent', ['ahostsv4', host], { allowFail: true })
    const ips = [...new Set(stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean))]
    if (!ips.length) {
      logger.error('租约级放行目标解析不出地址，该规则未生效', { host })
      continue
    }
    for (const ip of ips) {
      for (const p of ports) {
        await runInNetns(sentinelPid, 'iptables',
          ['-I', 'OUTPUT', '1', '-p', 'tcp', '-d', ip, '--dport', String(p), '-j', 'ACCEPT'])
      }
    }
    applied.push({ host, ips, ports })
  }
  return applied
}

/** 释放 slot 时清掉 host 侧的 veth 端——netns 那一端随 sentinel 进程死亡自动消失，不用管 */
export async function teardownSlotNetwork({ index }) {
  await run('ip', ['link', 'del', `veth-s${index}`], { allowFail: true })
}

/** 供 /healthz 与探测脚本复用：判断当前环境是否具备建 veth 的能力 */
export async function probeNetnsCapable() {
  try {
    await run('ip', ['link', 'add', '__nsprobe0', 'type', 'veth', 'peer', 'name', '__nsprobe1'])
    await run('ip', ['link', 'del', '__nsprobe0'], { allowFail: true })
    return true
  } catch {
    return false
  }
}

export const _internal = { parseCidr, bridgeIp, slotIp }
