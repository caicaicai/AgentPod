/**
 * 沙盒 worker 配置。与 agent service 一样：启动时校验，配错拒绝启动。
 *
 * 隔离只有一种模式：每个 slot 独立的 PID/mount/network/uts/ipc namespace + 独立 cgroup
 * （见 [namespace/slot-pool.js](namespace/slot-pool.js)）。没有"按 uid+目录分离"的旧模式可退——
 * 那种模式在 `SLOTS>1` 时隔离性名存实亡，与其留着一条容易被误用的退路，
 * 不如直接删掉，逼着部署环境必须满足 namespace 的前提条件
 * （`CAP_SYS_ADMIN`+`CAP_NET_ADMIN`，上线前用 `bin/check-namespace-caps.sh` 验证）。
 */
import path from 'node:path'
import { networkInterfaces, hostname } from 'node:os'
import { createHash } from 'node:crypto'

/**
 * 密钥指纹：sha256 前 8 位。用来和 manager 侧日志比对 SANDBOX_TICKET_SECRET
 * 是否配成了同一个 —— 两边不一致的现象是"调度成功但所有租约申请 401"，
 * 各自的日志都显示正常，不打指纹很难定位。**永远不要打印密钥本身。**
 */
function fingerprint(secret) {
  if (!secret) return 'none'
  return createHash('sha256').update(secret).digest('hex').slice(0, 8)
}

/** SANDBOX_LABELS 形如 `zone=lf09,tier=gold`，解析失败当没配，不让它挡住启动 */
function parseLabels(raw) {
  const labels = {}
  for (const pair of String(raw || '').split(',')) {
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (key) labels[key] = value
  }
  return labels
}

/**
 * 探测本容器的对外 IP。
 *
 * K8s 上这件事由 `fieldRef: status.podIP` 注入；没有 K8s 时
 * 退而求其次：挑第一个非回环的 IPv4。容器一般只有一张业务网卡，够用；
 * 多网卡场景请显式配 SANDBOX_ADVERTISE_BASE，别赌探测结果。
 */
export function detectAdvertiseBase(port) {
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (name === 'lo' || name.startsWith('docker') || name.startsWith('veth')) continue
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return `http://${address.address}:${port}`
    }
  }
  return ''
}

const num = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}
const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback
  return value === '1' || String(value).toLowerCase() === 'true'
}
const str = (value, fallback = '') => String(value ?? fallback).trim()

export function loadConfig(env = process.env) {
  const nodeEnv = str(env.NODE_ENV, 'development')
  const isProduction = nodeEnv === 'production'

  const config = {
    nodeEnv,
    isProduction,
    port: num(env.PORT, 8080),
    logLevel: str(env.LOG_LEVEL, 'info'),

    /** 与 agent service 共享的密钥。worker 只该被它调用。 */
    token: str(env.SANDBOX_TOKEN),

    /**
     * 本副本对外地址，租约响应里回给 agent service，之后所有请求直连这里。
     * 没有 K8s 的 fieldRef.status.podIP 时，留空可**自动探测**容器 IP
     * （见 detectAdvertiseBase）。显式配置永远优先。
     */
    advertiseBase: str(env.SANDBOX_ADVERTISE_BASE).replace(/\/+$/, ''),

    /** 并发槽位数 = 预建的 slot 数量，也就是这个副本能同时安全服务的用户数上限。 */
    slots: num(env.SANDBOX_SLOTS, 1),

    // 必须绝对：工作区逃逸检查靠字符串前缀比较，相对路径会让 path.resolve 的结果
    // 与 rootDir 对不上，正常命令都会被误判成「逃出工作区」
    workRoot: path.resolve(str(env.SANDBOX_WORK_ROOT, '/var/tmp/ap-sandbox')),

    /**
     * 租约的三个时限，各回答一个不同的问题。**顺序不能乱：滑动窗口 ≤ 单次续期上限
     * ≤ 硬顶**，否则总有一个永远轮不到生效。
     *
     * 从前只有前两个，而且 `ttlMs` 是**从创建那一刻算死的绝对墙** —— 一个正干着活
     * 的会话跑到第 30 分钟会被直接砍掉，slot 销毁重建，工作区连同用户数据一起没了。
     * 现在到期时刻会随活动往后滑（见 leases.js 的 `extend`），硬顶另立一个变量。
     */
    lease: {
      /** 一次显式续期（或创建时请求的 ttlMs）最多能买多久。不是"租约总时长"。 */
      ttlMs: num(env.LEASE_TTL_MS, 30 * 60 * 1000),
      /** 滑动窗口：最后一次活动之后还能活多久。调用方消失时靠它把槽位收回来。 */
      idleTimeoutMs: num(env.LEASE_IDLE_TIMEOUT_MS, 10 * 60 * 1000),
      /**
       * 硬顶：从创建算起的绝对上限，**续期推不过去**。
       * 没有它的话"活跃即续"就等于"只要一直发请求就能永久占住一个 slot"。
       */
      maxLifetimeMs: num(env.LEASE_MAX_LIFETIME_MS, 4 * 60 * 60 * 1000),
      sweepIntervalMs: num(env.LEASE_SWEEP_INTERVAL_MS, 30 * 1000),

      /**
       * ── 驻留（park）──────────────────────────────────────────────
       *
       * 一轮结束时调用方可以选择不释放，而是把租约**驻留**下来等下一轮
       * attach 回来（见 docs/SANDBOX-LIFECYCLE.md）。浏览器登录态、已装的
       * 依赖、后台进程都在 slot 里，释放就是销毁重建，连续型任务每轮都要重做。
       *
       * 驻留窗口。**必须比 idleTimeoutMs 短**：驻留的 slot 一个人都没在用，
       * 它不该比正在用的租约命还长。
       */
      parkTtlMs: num(env.LEASE_PARK_TTL_MS, 10 * 60 * 1000),
      /**
       * 抢占保护窗。池子满时最老的驻留租约会被杀掉腾位（见 leases.js 的
       * `acquire`），但刚 park 下来几秒就被抢走，用户的体感是"我按了发送，
       * 登录态就没了" —— 那比压根不做驻留更难解释。
       */
      parkGraceMs: num(env.LEASE_PARK_GRACE_MS, 60 * 1000),
      /**
       * 每个 username 最多驻留几个租约。**默认 1。**
       * 没有这条，一个人开五个会话就能长期占住五个 slot；而浏览器节点
       * （`need: { browser: true }` 筛过一遍）本来就比普通节点少。
       * 超了顶掉他**自己**最老的那个 —— 顶自己的，不顶别人的。
       * 设成 0 等于在这个节点上关掉驻留。
       */
      maxParkedPerUser: num(env.MAX_PARKED_PER_USER, 1),
    },

    exec: {
      defaultTimeoutMs: num(env.EXEC_DEFAULT_TIMEOUT_MS, 120 * 1000),
      maxTimeoutMs: num(env.EXEC_MAX_TIMEOUT_MS, 10 * 60 * 1000),
      /** 单次 exec 回传给模型的输出上限。超了截断 —— 不能让一条 `yes` 把 agent 撑爆 */
      maxOutputBytes: num(env.EXEC_MAX_OUTPUT_BYTES, 1024 * 1024),
      /** SIGTERM 之后等多久上 SIGKILL */
      killGraceMs: num(env.EXEC_KILL_GRACE_MS, 3000),
      /** 单文件写入上限（ulimit -f，单位 KB）。0 = 不设。进程数上限交给 cgroup 的 pids.max，不再用 ulimit -u —— 后者按 uid 统计，cgroup 按 slot 统计，语义更准确，两套并存只会让人分不清哪个生效了 */
      maxFileSizeKb: num(env.EXEC_MAX_FILE_SIZE_KB, 512 * 1024),
      shell: str(env.EXEC_SHELL, '/bin/bash'),
      /**
       * 异步任务结束后保留多少个的输出，供断线的调用方回来取。
       *
       * 内存上界 = 本值 × `EXEC_MAX_OUTPUT_BYTES`（默认 8 × 1 MiB）**每租约**，
       * 而租约数又受 slot 数约束，所以整体是封死的。
       * 正在跑的任务永远不淘汰 —— 淘汰它等于让它的输出凭空消失。
       */
      retainJobs: num(env.EXEC_RETAIN_JOBS, 8),
    },

    files: {
      maxBytes: num(env.MAX_FILE_BYTES, 32 * 1024 * 1024),
      /** 批量读写一次最多几个文件 */
      maxBatch: num(env.MAX_FILE_BATCH, 100),
      /**
       * 列目录一次最多回多少条。
       *
       * 不是可选的礼貌：`node_modules` 递归下来轻松十万条，一次性 JSON 化会把
       * worker 的内存和调用方的上下文一起打爆。到顶就停并**明确报 truncated** ——
       * 静默截断会让调用方以为自己看到了全部。
       */
      maxListEntries: num(env.MAX_LIST_ENTRIES, 2000),
    },

    /**
     * 调用方能追加的环境变量键名。默认放 `AP_*` 与 `ME_TOKEN`。
     *
     * `ME_TOKEN` 在这里放行，**不等于**沙盒就会拿到它：真正的闸门在 agent 侧的
     * `SANDBOX_INJECT_ME_TOKEN`（默认关），关着的时候 payload 里根本没有这个键。
     * 这层白名单挡的是"键名乱传"，不是凭据边界本身。
     *
     * 之所以不让它保持严格、逼运维再配一次：三个开关（agent 的注入开关、这里的
     * 键名白名单、netns 的出站白名单）任何一个没对齐，现象都不一样 —— 这一个
     * 没对齐时，token 会被**静默丢掉**，技能报的是鉴权失败，而线索只在 worker
     * 日志里的一行 warn。少一个必须对齐的开关，就少一种查不出来的失败。
     */
    envKeyAllow: str(env.ENV_KEY_ALLOW, '^(AP_[A-Z0-9_]+|ME_TOKEN)$'),

    /**
     * job 的 PATH。**不继承 worker 的 PATH** —— 那会把开发机上一堆乱七八糟的目录
     * （以及里面的可执行文件）带进沙盒。容器里的默认值就够用（node 在 /usr/local/bin）；
     * 本地开发要跑 node/python 时按需覆盖。
     *
     * `/opt/ap/venv/bin` 必须排在最前面，这不是可选的美化：底包故意把 `requests`
     * 只装进那个 venv（"不污染系统 python"），而 `managed-skills/meeting/SKILL.md`
     * 从头到尾写的都是 `python3 scripts/huiji_cli.py`。venv 不在 PATH 上，
     * `python3` 就解析成 `/usr/bin/python3`，技能第一句就 `ModuleNotFoundError:
     * No module named 'requests'` —— 而 `AP_PYTHON_BIN` 明明指对了地方。
     * 排在最前面，SKILL.md 里的 `python3` 一个字都不用改就是对的那个。
     */
    jobPath: str(env.JOB_PATH, '/opt/ap/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'),

    runtime: {
      nodeBin: str(env.AP_NODE_BIN, process.execPath),
      skillLibsDir: str(env.AP_SKILL_LIBS_DIR),
      userSkillsDir: str(env.AP_USER_SKILLS_DIR),
      pythonBin: str(env.AP_PYTHON_BIN, '/opt/ap/venv/bin/python3'),
    },

    namespace: {
      /**
       * 显式指定 slot 内使用的 DNS 服务器（逗号分隔的 IPv4）。
       *
       * Docker Desktop 的内嵌 DNS（127.0.0.11）在 slot 的 network namespace 里
       * 连不上——回环地址指向的是 slot 自己的 lo，那上面什么都没有。
       * 设置此变量后 slot 会使用这些真实 DNS 服务器，绕过 resolv.conf 的限制。
       * 留空则从 /etc/resolv.conf 自动读取（裸机 / 非 Docker Desktop 环境通常能用）。
       */
      dnsServers: str(env.SANDBOX_DNS_SERVERS).split(',').map(s => s.trim()).filter(Boolean),
      /** 每个 slot 的 job uid/gid = jobUidBase + slot 序号，每个 slot 独占一个 uid，互不共享 */
      jobUidBase: num(env.SANDBOX_NS_JOB_UID_BASE, 20000),
      /** host 侧网桥名，所有 slot 的 veth 都接在这上面 */
      bridgeName: str(env.SANDBOX_NS_BRIDGE, 'sandbr0'),
      /** 分给各 slot veth 的私有网段，与宿主机/集群网段不冲突即可 */
      subnetCidr: str(env.SANDBOX_NS_SUBNET, '10.250.0.0/16'),
      /** cgroup v2 根目录下给本 worker 建的子树；v1 环境会自动改用各 controller 的独立挂载点 */
      cgroupRoot: str(env.SANDBOX_NS_CGROUP_ROOT, '/sys/fs/cgroup/ap-sandbox'),
      /** 单 slot CPU 上限（核，0.5 = 半核） */
      cpuMaxCores: Number(env.SANDBOX_NS_CPU_MAX_CORES ?? 1),
      /** 单 slot 内存上限（MB）。超了直接被 OOM kill，好过拖垮整个节点 */
      memoryMaxMb: num(env.SANDBOX_NS_MEMORY_MAX_MB, 1024),
      /** 单 slot 进程数上限（cgroup pids.max）。按 slot 而非按 uid 统计，多 slot 互不影响 */
      pidsMax: num(env.SANDBOX_NS_PIDS_MAX, 256),
      /**
       * 每个 slot 私有 /tmp 的大小（MB）。挂 tmpfs 是为了断掉 slot 之间经 /tmp
       * 的互通（mount namespace 是克隆容器挂载表，不是 chroot，/tmp 默认是共享的）。
       * 占的是内存，但写进去的页记在该 slot 的 memory cgroup 账上，撑爆的是自己。
       */
      tmpfsSizeMb: num(env.SANDBOX_NS_TMPFS_SIZE_MB, 512),
      /** 每个 slot 私有 /dev/shm 的大小（MB）。Chromium 带了 --disable-dev-shm-usage，不用给大 */
      shmSizeMb: num(env.SANDBOX_NS_SHM_SIZE_MB, 64),

      /**
       * 出站拦截开关的**启动默认值**：`allowlist`（拦，默认）| `open`（不拦）。
       *
       * ⚠️ **接了管理端之后这个变量不再生效** —— 注册/心跳响应里下发的策略会整体
       * 覆盖它（见 src/egress-policy.js）。它只回答一个问题：**在第一次收到下发
       * 之前**（以及完全不接管理端的单机/本地部署）按什么跑。默认拦，所以管理端
       * 不可达时节点停在收紧的一侧。
       *
       * 生产环境禁止在这里写 `open`：关掉一个集群的出站拦截是控制面的决定，
       * 逐台机器改环境变量既不可审计、也没有单一答案说得清"到底哪几台还开着"。
       */
      /**
       * ⚠️ 默认值是 `allowlist`，不是 `open`。
       *
       * 这里曾经写的是 `'open'` —— 与上面那三段说明（"默认拦"、"管理端不可达时
       * 停在收紧的一侧"）正好相反。后果不是报错，而是**一台没配这个变量的节点
       * 直接不拦出站**：沙盒里的技能拿得到用户登录态，能连出去就能把凭据带走，
       * 而整套凭据边界正是靠"带不走"这条结构性保证撑着的。
       *
       * 失败方向必须朝收紧那一侧：漏配一个环境变量的代价应该是"某些请求出不去
       * （看得见、查得出）"，而不是"什么都出得去（没有任何现象）"。
       */
      egressMode: str(env.SANDBOX_EGRESS_MODE, 'allowlist'),

      /**
       * 额外放行的出站目标，逗号分隔的 `host` 或 `host:port`，不写端口则放行 80 和 443。
       *
       * 同样只是启动默认值，接了管理端之后以下发为准。
       *
       * **这是在承重墙上开门，每加一条都要想清楚。** 出站白名单是整套凭据边界
       * 的基础：技能拿得到用户登录态，只要它能连出去，凭据就能被带走。默认只有
       * DNS 和 Cloud Bridge 两个目标，正是为了让"带不走"成为结构性保证而不是约定。
       *
       * 真正需要它的场景是浏览器：页面要自己去加载 HTML/JS/CSS，服务端代发替代
       * 不了（见 README「浏览器为什么能拿到 cookie」）。所以要让沙盒里的浏览器
       * 打开某个内网系统，就必须把那个域名列进来。
       *
       * 与 Cloud Bridge 同样的限制：**解析只在建 slot 时做一次**。目标换 IP
       * （CDN、多活切换）之后白名单就过期了，worker 不重启不会自愈，表现是
       * 那个站点突然打不开。域名背后 IP 经常变的目标不适合走这里。
       */
      egressAllow: str(env.SANDBOX_EGRESS_ALLOW),

      /**
       * 租约**可以申请**放行的目标清单（不是自动放行）。格式同上。
       *
       * 与 `SANDBOX_EGRESS_ALLOW` 的关系是"菜单"与"默认菜"：
       *   - `SANDBOX_EGRESS_ALLOW` 里的目标对**所有 slot 永远**开着；
       *   - 这一份只是**允许调用方点**，点了才对**它那一个租约**开，租约一释放
       *     slot 整体销毁重建，规则跟着没。
       *
       * 所以它其实比前者更严：一个只有某类任务才需要的域名，与其为它给全节点
       * 常开一道门，不如放进这份清单让需要的租约自己申请。
       *
       * **默认空 = 租约一律不能申请。** 调用方申请清单之外的目标会被 400 挡回去，
       * 而不是静默忽略 —— 静默的话调用方会以为开了，然后对着 `Connection refused`
       * 一路往技能自己身上找原因。
       */
      egressLeaseAllow: str(env.SANDBOX_EGRESS_LEASE_ALLOW),
    },

    browser: {
      enabled: bool(env.BROWSER_ENABLED, true),
      headless: bool(env.BROWSER_HEADLESS, true),
      /** 底包里 chromium 的路径。留空则用 playwright 自己解析 */
      executablePath: str(env.BROWSER_EXECUTABLE_PATH),
      ignoreHttpsErrors: bool(env.BROWSER_IGNORE_HTTPS_ERRORS, false),
      /**
       * slot 私有 Chromium 降权后是否重新启用它自己的沙盒。默认关闭（仍加 `--no-sandbox`）——
       * 降权+namespace 隔离已经在外层给了一道边界，双层沙盒嵌套（Chromium 自己也用
       * PID/user namespace）有已知兼容性坑，需要先在目标环境实测过再打开。
       */
      innerSandbox: bool(env.BROWSER_INNER_SANDBOX, false),
    },

    /** 仅供本地开发：跳过 token 校验（namespace 隔离本身仍然需要，跳不过） */
    allowAnonymous: bool(env.ALLOW_ANONYMOUS, false),

    /**
     * 接入 sandbox-manager（集群注册与调度）。协议见 sandbox-manager/docs/PROTOCOL.md。
     *
     * **整块由 `SANDBOX_MANAGER_URL` 是否配置来开关。** 不配就完全是今天的行为：
     * 不注册、不心跳、只认静态 token。这样单节点部署和本地开发不受任何影响，
     * 也让"接管理端"这件事可以随时回滚——把这个变量删掉重启即可。
     */
    manager: {
      url: str(env.SANDBOX_MANAGER_URL).replace(/\/+$/, ''),
      code: str(env.SANDBOX_MANAGER_CODE),
      /** 与 manager 共享的票据密钥。manager 用它签发，本节点用它校验。 */
      ticketSecret: str(env.SANDBOX_TICKET_SECRET),
      /** 缺省取 hostname：K8s 里就是 pod 名，天然唯一，重启换名也正好对应一个新节点 */
      nodeId: str(env.SANDBOX_NODE_ID, hostname()),
      pool: str(env.SANDBOX_POOL, 'default'),
      labels: parseLabels(env.SANDBOX_LABELS),
      version: str(env.SANDBOX_NODE_VERSION),
      /** 只是初始值：manager 会在注册/心跳响应里下发真实间隔，以它为准 */
      heartbeatIntervalMs: num(env.SANDBOX_HEARTBEAT_MS, 10000),
      /**
       * 迁移开关：是否继续接受旧的静态 SANDBOX_TOKEN 换租约。
       *
       * 默认 true，所以接上管理端不会打断任何现有调用方。
       * **切换完成后必须置 false** —— 在那之前"调用方持有长期凭据"这个问题
       * 并没有被解决，只是多了一条新路径。见 PROTOCOL.md §8。
       */
      acceptStaticToken: bool(env.SANDBOX_ACCEPT_STATIC_TOKEN, true),
    },
  }

  config.manager.enabled = Boolean(config.manager.url)
  config.manager.ticketSecretFingerprint = fingerprint(config.manager.ticketSecret)

  // 没有 K8s podIP 注入时，自己探
  if (!config.advertiseBase) config.advertiseBase = detectAdvertiseBase(config.port)

  config.warnings = validate(config)
  return config
}

/** 导出给测试用：自动探测依赖本机网卡，没法在用例里造出"探测失败"，只能直接验校验逻辑 */
export function validate(config) {
  const errors = []
  // 校验期的警告：不阻止启动，但要能被启动流程拿到打进日志。
  // 直接在这里 console 会让这个纯函数变得不好测。
  const warnings = []

  if (config.slots < 1) errors.push('SANDBOX_SLOTS 至少为 1')
  if (config.exec.maxTimeoutMs < config.exec.defaultTimeoutMs) {
    errors.push('EXEC_MAX_TIMEOUT_MS 不能小于 EXEC_DEFAULT_TIMEOUT_MS')
  }
  try {
    new RegExp(config.envKeyAllow)
  } catch {
    errors.push(`ENV_KEY_ALLOW 不是合法正则：${config.envKeyAllow}`)
  }
  if (config.namespace.cpuMaxCores <= 0) errors.push('SANDBOX_NS_CPU_MAX_CORES 必须大于 0')

  // 拼错的值绝不能退化成"不拦"。这里拦下来是为了让写错的人立刻知道，
  // 而不是让它变成一个看起来配好了、实际全开的节点。
  if (!['allowlist', 'open'].includes(config.namespace.egressMode)) {
    errors.push(`SANDBOX_EGRESS_MODE 只能是 allowlist|open，当前 ${config.namespace.egressMode}`)
  }

  // 三个时限的大小关系配反了不会报错，只会让其中一个永远轮不到生效 —— 而现象是
  // "租约莫名其妙提前/永远不过期"，很难联想到是配置写反了。
  if (config.lease.idleTimeoutMs > config.lease.ttlMs) {
    errors.push(`LEASE_IDLE_TIMEOUT_MS(${config.lease.idleTimeoutMs}) 不能大于 LEASE_TTL_MS(${config.lease.ttlMs})：滑动窗口比单次续期上限还长，等于续期接口没用`)
  }
  if (config.lease.maxLifetimeMs < config.lease.ttlMs) {
    errors.push(`LEASE_MAX_LIFETIME_MS(${config.lease.maxLifetimeMs}) 不能小于 LEASE_TTL_MS(${config.lease.ttlMs})：硬顶比一次续期还短，租约会在创建后立刻到期`)
  }
  // 驻留的两个时限同理：配反了不会报错，只会让"驻留"变成一个占着 slot 又收不回来
  // 的东西，而那正是这个功能唯一不能出的事故。
  if (config.lease.parkTtlMs > config.lease.idleTimeoutMs) {
    errors.push(`LEASE_PARK_TTL_MS(${config.lease.parkTtlMs}) 不能大于 LEASE_IDLE_TIMEOUT_MS(${config.lease.idleTimeoutMs})：驻留的租约没有人在用，不该比正在用的活得还久`)
  }
  if (config.lease.parkGraceMs >= config.lease.parkTtlMs) {
    errors.push(`LEASE_PARK_GRACE_MS(${config.lease.parkGraceMs}) 必须小于 LEASE_PARK_TTL_MS(${config.lease.parkTtlMs})：保护窗盖满整个驻留窗口时，驻留租约永远抢不动，池子满了只能干等`)
  }
  if (config.lease.maxParkedPerUser < 0) {
    errors.push('MAX_PARKED_PER_USER 不能是负数（0 表示在本节点关闭驻留）')
  }

  if (config.isProduction) {
    if (!config.token) errors.push('生产环境必须配置 SANDBOX_TOKEN：没有它，任何能连到本端口的人都能在沙盒里执行命令')
    if (config.allowAnonymous) errors.push('生产环境禁止 ALLOW_ANONYMOUS=1')
    if (!config.advertiseBase) errors.push('生产环境必须能确定 SANDBOX_ADVERTISE_BASE：自动探测没找到非回环 IPv4，请显式配置（租约要靠它把后续请求引回本副本）')
    /**
     * 这一条 egressMode 上面的说明里写了、却一直没实现。
     *
     * 关掉一个集群的出站拦截是**控制面的决定**：逐台机器改环境变量既不可审计，
     * 也没有单一答案说得清"到底哪几台还开着"。真要关，从管理端下发
     * （下发会整体覆盖本地 env，见 src/egress-policy.js）。
     */
    if (config.namespace.egressMode === 'open') {
      errors.push('生产环境禁止 SANDBOX_EGRESS_MODE=open：关掉出站拦截是控制面的决定，请从管理端下发，逐台改环境变量既不可审计也说不清哪几台还开着')
    }
  }

  // 接管理端是"要么整套配齐、要么完全不配"。半配是最难排查的状态：
  // 比如配了 URL 没配票据密钥，节点会正常注册、正常出现在集群里、被正常调度到，
  // 然后每一个租约申请都 401 —— 而 /healthz 全绿。
  if (config.manager.enabled) {
    if (!config.manager.code) {
      errors.push('配置了 SANDBOX_MANAGER_URL 就必须配 SANDBOX_MANAGER_CODE：注册与心跳要靠它鉴权')
    }
    if (!config.manager.ticketSecret) {
      errors.push('配置了 SANDBOX_MANAGER_URL 就必须配 SANDBOX_TICKET_SECRET：没有它，manager 签发的票据一张都验不过，节点会被调度到却拒绝所有租约')
    }
    if (!/^https?:\/\//.test(config.manager.url)) {
      errors.push(`SANDBOX_MANAGER_URL 必须是 http:// 或 https:// 开头的绝对地址，当前 ${config.manager.url}`)
    }
    if (!config.advertiseBase) {
      errors.push('接入 manager 时必须能确定 SANDBOX_ADVERTISE_BASE：它是注册给调度器的直连地址，探测不到就得显式配')
    }
  } else if (config.manager.code || config.manager.ticketSecret) {
    // 反过来也拦：配了密钥却没配 URL，多半是漏了一个变量，而表现是"接管理端
    // 这件事悄无声息地没生效"。
    errors.push('配置了 SANDBOX_MANAGER_CODE / SANDBOX_TICKET_SECRET 但没配 SANDBOX_MANAGER_URL：管理端接入不会生效，请确认是否漏配')
  }

  if (config.isProduction && config.manager.enabled && config.manager.acceptStaticToken) {
    // 不是错误，是提醒：迁移没走完时这是正常状态。
    // 但它必须能被看见，否则很容易停在第 2 步就当作完成了。
    warnings.push('SANDBOX_ACCEPT_STATIC_TOKEN=true：仍然接受长期静态 token 换租约。迁移完成后应置为 false，否则"调用方持有长期凭据"这个问题并没有真的解决')
  }

  if (!config.token && !config.allowAnonymous && !config.manager.enabled) {
    errors.push('未配置 SANDBOX_TOKEN；本地开发请显式设置 ALLOW_ANONYMOUS=1')
  }
  if (!config.token && !config.allowAnonymous && config.manager.enabled && config.manager.acceptStaticToken) {
    errors.push('SANDBOX_ACCEPT_STATIC_TOKEN=true 但没有 SANDBOX_TOKEN：要么配上 token，要么置 SANDBOX_ACCEPT_STATIC_TOKEN=false 只走票据')
  }

  if (errors.length) {
    const error = new Error(`配置校验失败：\n  - ${errors.join('\n  - ')}`)
    error.code = 'CONFIG_INVALID'
    throw error
  }
  return warnings
}
