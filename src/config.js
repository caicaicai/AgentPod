/**
 * 配置：启动时一次性解析 + 校验，配错就不许起来。
 *
 * 原则：任何"开发模式才允许"的开关（信任 X-Username、本进程执行命令、暴露自检端点）
 * 在 NODE_ENV=production 下必须直接拒绝启动，而不是打条警告了事 —— 这类开关一旦
 * 混进生产就是越权与串号事故。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 从文件里补齐环境变量。
 *
 * 找哪个文件：`ENV_FILE`（绝对路径）> `<cwd>/.env`。
 *
 * 有 ENV_FILE 这个口子是为了**容器里挂配置**：把配置挂到应用目录之外
 * （如 /etc/ap/agent.env），避免与应用代码目录耦合。
 * 就完全绕开这两件事。
 *
 * **真实环境变量永远优先**：平台应用配置里设了什么，文件就覆盖不了什么。
 * 反过来的话，"我明明在控制台改了却不生效"会是一个极难查的问题。
 */
function loadDotEnv({ cwd, env }) {
  const explicit = String(env.ENV_FILE || '').trim()
  const file = explicit || path.join(cwd, '.env')

  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    // 显式指定了却读不到，一定是配错了（路径写错、忘了挂）—— 不能静默跳过，
    // 否则现象是"所有配置都退回默认值"，而默认值在生产上多半会被死线拦下，
    // 报出来的却是一堆看不出根因的校验错误。
    if (explicit) {
      const err = new Error(`ENV_FILE 指向的文件读不到：${file}（${error.code || error.message}）`)
      err.code = 'CONFIG_INVALID'
      throw err
    }
    return { path: '', keys: 0 } // 没有 .env 是正常情况，全靠环境变量
  }

  let keys = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    // `export FOO=bar` 也认：从 shell 里复制过来的片段常常带着它，
    // 不认的话那一行会被解析成名为 `export FOO` 的变量，静默地什么都不生效。
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '')
    if (!key) continue
    if (env[key] !== undefined) continue // 真实环境变量优先
    env[key] = unquote(trimmed.slice(eq + 1).trim())
    keys += 1
  }
  return { path: file, keys }
}

/**
 * 去掉值两侧成对的引号。
 *
 * 没有这一步的话 `FOO="http://x"` 会被读成带引号的字符串，
 * 于是拼出来的地址长这样：`"http://x"/?a=1`。而写引号是从 shell 带过来的肌肉记忆，
 * 谁都会犯，报错却完全指不到引号上。
 */
function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
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
const list = (value) => str(value).split(':').map((v) => v.trim()).filter(Boolean)
/**
 * 逗号分隔且**保留大小写**。
 * 不能用下面那个 `csv`：它会转小写（为域名白名单设计的），而模型 id 大小写敏感
 * —— `Qwen/Qwen2.5-72B-Instruct` 被压成小写之后网关就认不出来了。
 */
const csvExact = (value) => str(value).split(',').map((v) => v.trim()).filter(Boolean)
const csv = (value, fallback = []) => {
  const parsed = str(value).split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
  return parsed.length ? parsed : fallback
}

export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const envFile = loadDotEnv({ cwd, env })

  const nodeEnv = str(env.NODE_ENV, 'development')
  const isProduction = nodeEnv === 'production'

  const config = {
    nodeEnv,
    isProduction,
    port: num(env.PORT, 8787),
    logLevel: str(env.LOG_LEVEL, 'info'),

    /**
     * 从哪个文件补的环境变量、补进来几个。**只记路径和条数，绝不记内容** ——
     * 这个文件里躺着 SANDBOX_MANAGER_CODE / MYSQL_PASSWORD。
     * 启动日志里带上它，"挂了配置却没生效"就不用靠猜（多半是挂错了路径）。
     */
    envFile,

    auth: {
      mode: str(env.AUTH_MODE, 'password'), // password | dev

      /**
       * AUTH_MODE=password 用：内置账号密码 + JWT 会话。
       * 实现在 src/identity/password-auth.js。
       */
      password: {
        /**
         * `user1:pass1,user2:pass2`。
         *
         * ⚠️ 接了账号存储之后（STORAGE_DRIVER 无论哪种，账号都进存储），
         * 这个变量退化成**首次播种** —— 启动时把里面的账号补进去，已存在的不动。
         * 于是用户改过的密码不会被一次重启打回原样，而明文密码也不必长期留在
         * 环境变量里。见 src/identity/user-store.js。
         */
        users: str(env.CONSOLE_USERS),
        sessionSecret: str(env.SESSION_SECRET),
        sessionTtlHours: num(env.SESSION_TTL_HOURS, 24),
        /**
         * 开放自助注册。**默认关**。
         *
         * 账号在这里等于"能跑模型、能开沙盒"，所以让陌生人自己开号必须是一个
         * 显式打开的开关，而不是默认能力。打开之后**第一个注册的人是管理员** ——
         * 全新部署里总得有人能管别人，而那时还没有任何管理员可以来授权。
         */
        allowRegister: bool(env.AUTH_ALLOW_REGISTER, false),

        /**
         * 自助注册的细则：要不要留邮箱、要不要用验证码激活。
         *
         * 两个开关分开，因为它们回答的是两个问题：
         *   requireEmail —— "注册时必须留一个邮箱"（找回密码、发通知有人可联系）；
         *   verifyEmail  —— "那个邮箱得证明是他自己的"（发一封带验证码的信，验过才算激活）。
         *
         * 只开前者也说得通（内网部署，人都是同事，留个邮箱备查就够了）；
         * 开后者则必然蕴含前者 —— 没有邮箱就没地方发信，所以下面取 needEmail 时是**或**。
         *
         * verifyEmail 打开后，注册接口**不再当场发令牌**：账号建出来是未激活的，
         * 必须先带着验证码调 /v1/auth/activate。这条是整件事的意义所在 ——
         * 否则"验证"只是发了封信，而人早就进来了。
         */
        register: {
          requireEmail: bool(env.REGISTER_REQUIRE_EMAIL, false),
          verifyEmail: bool(env.REGISTER_VERIFY_EMAIL, false),
          /**
           * 验证码几位、几分钟内有效、最多能试几次。
           *
           * 6 位数字只有一百万种可能，光靠"猜不中"是挡不住的 —— 真正兜底的是
           * **试错次数上限**（试满就把这份验证码作废，必须重发）和有效期。
           * 把位数调大是可以的，但别指望它替代那两道。
           */
          codeLength: num(env.REGISTER_CODE_LENGTH, 6),
          codeTtlMinutes: num(env.REGISTER_CODE_TTL_MINUTES, 15),
          maxAttempts: num(env.REGISTER_CODE_MAX_ATTEMPTS, 5),
          /**
           * 两次发信的最小间隔。挡的不是注册的人，是**拿我们的发信账号去轰炸
           * 别人邮箱**的人：没有这道闸，一个 `/resend` 循环就是一台免费的发信机，
           * 而挨骂（和被拉黑）的是我们那个域名。
           */
          resendIntervalSeconds: num(env.REGISTER_CODE_RESEND_SECONDS, 60),
          /**
           * 邮箱域名白名单（逗号分隔，留空 = 不限）。
           * 内网部署常见的诉求是"只让公司邮箱注册"，而那本来要靠人工审核。
           */
          emailDomains: csv(env.REGISTER_EMAIL_DOMAINS, []),
        },

        /**
         * 登录限流。实现与两种计数口径的理由见 src/http/rate-limit.js。
         *
         * 默认值的取法：按 IP 每分钟 20 次，够任何真人（含几个标签页同时登录、
         * 手滑重试）用，而爆破在这个速率下没有意义；按用户名连续失败 5 次起封，
         * 从 30s 翻倍到 15 分钟封顶 —— 不设成永久封禁是因为那等于把"锁死别人的
         * 账号"这个能力免费送给了任何知道用户名的人。
         */
        rateLimit: {
          enabled: bool(env.AUTH_RATE_LIMIT, true),
          ipWindowMs: num(env.AUTH_RATE_LIMIT_IP_WINDOW_MS, 60 * 1000),
          ipMax: num(env.AUTH_RATE_LIMIT_IP_MAX, 20),
          userWindowMs: num(env.AUTH_RATE_LIMIT_USER_WINDOW_MS, 15 * 60 * 1000),
          userMax: num(env.AUTH_RATE_LIMIT_USER_MAX, 5),
          baseBlockMs: num(env.AUTH_RATE_LIMIT_BLOCK_MS, 30 * 1000),
          maxBlockMs: num(env.AUTH_RATE_LIMIT_MAX_BLOCK_MS, 15 * 60 * 1000),
        },
      },
    },

    /**
     * 前面是不是有一层自己的反向代理。**默认否。**
     *
     * 只影响"客户端 IP 从哪儿取"（见 src/http/rate-limit.js 的 clientIp）。
     * 默认信任 X-Forwarded-For 是危险的：那样按 IP 的限流一改头就绕过去了，
     * 等于没有。直接暴露在公网时保持 0，套了 nginx / 网关再打开。
     */
    trustProxy: bool(env.TRUST_PROXY, false),

    /**
     * 发信账号。今天只有一个用途：注册验证码。
     *
     * ── 为什么自己写 SMTP，而不是装 nodemailer ──────────────────────────
     *
     * 这个服务的依赖只有 pi 那两个包（见 package.json）。为"一封纯文本的信"
     * 引入一棵新的依赖树，换来的是一份要长期跟着升的攻击面 —— 而我们要用的
     * 只是 SMTP 里最老实的那几条命令。实现在 src/mail/smtp.js，约二百行。
     *
     * ── transport ──────────────────────────────────────────────────────
     *
     *   smtp  真的发出去。
     *   log   不发，把整封信打进日志（**含验证码**）。只给本地开发用 ——
     *         生产下配置校验会直接拒绝启动，见 validate()：把验证码打进日志，
     *         等于任何能看日志的人都能激活任何人的账号。
     */
    mail: {
      transport: str(env.MAIL_TRANSPORT, 'smtp'), // smtp | log
      host: str(env.MAIL_SMTP_HOST),
      /**
       * 465 = 连上就是 TLS（隐式）；587 = 先明文再 STARTTLS 升级。
       * secure 默认跟着端口走，配错的表现是握手直接挂 —— 那比"以为加密了其实没有"好。
       */
      port: num(env.MAIL_SMTP_PORT, 465),
      secure: bool(env.MAIL_SMTP_SECURE, num(env.MAIL_SMTP_PORT, 465) === 465),
      user: str(env.MAIL_SMTP_USER),
      pass: str(env.MAIL_SMTP_PASS),
      /** 信封与信头上的发件人。留空就用 MAIL_SMTP_USER —— 多数服务商也只认这一个 */
      from: str(env.MAIL_FROM) || str(env.MAIL_SMTP_USER),
      fromName: str(env.MAIL_FROM_NAME, 'AgentPod'),
      /**
       * ⚠️ 关掉证书校验 = 这条链路可以被中间人接管，而信里带着验证码。
       * 只有自建邮件服务器用自签证书时才该动它，且那时更该做的是把 CA 装进系统。
       */
      rejectUnauthorized: bool(env.MAIL_TLS_REJECT_UNAUTHORIZED, true),
      timeoutMs: num(env.MAIL_TIMEOUT_MS, 15 * 1000),
    },

    platform: {
      speedApiBase: str(env.SPEED_API_BASE).replace(/\/+$/, ''),
      referer: str(env.PLATFORM_REFERER),
      fallbackCookie: str(env.FALLBACK_COOKIE),
    },

    llm: {
      mode: str(env.LLM_MODE, 'platform'), // platform | db | direct | faux
      cacheTtlMs: num(env.LLM_CACHE_TTL_MS, 5 * 60 * 1000),

      /**
       * LLM_MODE=db 时，模型配置里的 API Key 入库前用它加密（AES-256-GCM）。
       *
       * **留空 = 明文入库**，与 cron 的凭据金库同一个取舍：挡它的是数据库的访问
       * 控制。配上之后挡住的是"拿到了库、但没拿到进程环境"的那个人 ——
       * 一份被拖走的备份、一个开着的只读从库。完整边界见 src/credentials/secret-box.js。
       *
       * ⚠️ 换掉或丢掉它，已经加密的那些 key 就解不开了（管理台上会标"Key 解不开"，
       * 那几条模型会被跳过而不是让所有人的对话一起失败）。
       */
      configSecret: str(env.LLM_CONFIG_SECRET),

      /**
       * 强制认为支持读图的模型（逗号分隔，大小写敏感）。
       *
       * 平台的 llminfo 没把某个多模态模型的 `input` 标上 image 时的兜底 ——
       * 不标的后果是 pi 把工具结果里的截图**静默丢掉**，模型只收到一行
       * "Screenshot captured: 11622 bytes"，然后说"我看不见"。
       * 正确的修法是让平台补上元数据；这个开关是等不及时用的。
       */
      imageCapableModels: csvExact(env.LLM_IMAGE_MODELS),

      /**
       * 上限字段名：`max_tokens` 还是 `max_completion_tokens`。
       *
       * 留空 = 用 pi 的探测（它按 baseUrl 白名单认"非标准"实现，我们的网关不在名单里，
       * 于是被当成标准 OpenAI，发 `max_completion_tokens`）。
       * 已知这个上游用的是**老版 OpenAI schema**（连 `developer` 角色都不认），
       * 所以它多半要 `max_tokens` —— 但目前没有直接证据，校验器在 messages[0] 就退出了。
       * 真出现相关的 400 时把这里设成 max_tokens。
       */
      maxTokensField: ['max_tokens', 'max_completion_tokens'].includes(str(env.LLM_MAX_TOKENS_FIELD))
        ? str(env.LLM_MAX_TOKENS_FIELD)
        : '',

      /**
       * 模型调用失败时的退避重试。
       *
       * pi **自带**这套机制（AgentSession._handleRetryableError，指数退避、重试前把失败的
       * 那条助手消息从状态里摘掉所以不会重复输出），默认就是开的。这里只做两件事：
       *   1. 把次数与基准间隔变成可配置的；
       *   2. 补充**本网关特有**的可重试错误特征 —— 见 extraPatterns。
       *
       * 退避是 `baseDelayMs * 2^(n-1)`：默认 2s / 4s / 8s，最坏多等 14 秒。
       * 调大 maxRetries 之前先想清楚：用户是在等一个对话框，不是在跑批。
       */
      retry: {
        enabled: bool(env.LLM_RETRY_ENABLED, true),
        maxRetries: num(env.LLM_RETRY_MAX, 3),
        baseDelayMs: num(env.LLM_RETRY_BASE_MS, 2000),
        /**
         * pi 判可重试靠的是拿正则去匹配错误文本，认的是
         * `429 / 5xx / rate limit / timeout / connection reset` 这些**标准**说法，
         * 而我们的网关会把上游故障包成 **HTTP 400**，落在正则之外。这里做补充。
         *
         * ⚠️ **`模型服务调用失败` 曾经在这个默认值里，后来拿掉了。**
         * 追上游日志才看清：那是网关对**任何**上游失败的统一包装，第一次抓到的实例
         * 是一个彻头彻尾的永久性错误（请求把系统提示发成了 `role: "developer"`，
         * 上游 schema 不认）。拿它当"可重试"特征，等于对着一个必然失败的请求
         * 白等 14 秒再失败一次，还多打三次上游。
         *
         * 教训：**可重试的判据必须是"这次失败与请求内容无关"**，
         * 而网关的通用包装文案恰恰抹掉了这个区分。要加特征就加那些
         * 明确指向服务端瞬时状态的原话。
         *
         * `Already borrowed` 留着：那是 Rust `RefCell` 借用冲突，
         * 只可能来自服务端并发 bug，与我们发了什么无关。
         */
        extraPatterns: csvExact(env.LLM_RETRY_EXTRA_PATTERNS).length
          ? csvExact(env.LLM_RETRY_EXTRA_PATTERNS)
          : ['Already borrowed'],
      },
      /**
       * LLM_MODE=direct 用：直连一个 OpenAI 兼容端点。
       * **仅限本地做真模型联调**，生产拒绝启动 —— 这里的 key 是所有人共用的一把，
       * 与"每个用户用自己的 llmToken"这个前提直接冲突。
       */
      direct: {
        baseUrl: str(env.LLM_DIRECT_BASE_URL).replace(/\/+$/, ''),
        apiKey: str(env.LLM_DIRECT_API_KEY),
        models: csvExact(env.LLM_DIRECT_MODEL),
        contextWindow: num(env.LLM_DIRECT_CONTEXT_WINDOW, 128000),
        maxTokens: num(env.LLM_DIRECT_MAX_TOKENS, 4096),
        input: csv(env.LLM_DIRECT_INPUT, ['text']),
        reasoning: bool(env.LLM_DIRECT_REASONING, false),
      },
    },

    /*
     * 这里曾经有一个 `dataDir`（DATA_DIR）—— 不接数据库时会话、记忆、项目、
     * 定时任务的落地处。结构化数据只存 MySQL 之后它没有任何消费者了，删掉。
     *
     * 仍然写盘的只剩**会话工作区与用户技能**，那套走 USER_WORKSPACE_ROOT
     * （见下面 userWorkspace），与这个变量无关。
     */

    /**
     * MySQL 连接。**必填** —— 本服务的结构化数据只存数据库。
     *
     * 会话、项目、长期记忆、作品、分享/市场、定时任务、账号、定时任务凭据，
     * 全在库里。曾经有过一个 `file` 驱动和一个 `STORAGE_DRIVER` 开关，去掉了：
     * 同时维护两套后端的成本落在**每一处**改动上，而文件那套永远只能是
     * "单副本时能用"。理由展开见 src/persistence/storage.js 的文件头。
     *
     * ⚠️ 不进库的只有一样：**会话工作区与用户技能**（USER_WORKSPACE_ROOT）。
     * 那些要被整目录 stage 进沙盒、大小没有上限，属于共享文件系统的活，
     * 塞进数据库只会把连接池卡死。见 src/workspace/store.js。
     *
     * 整个进程**共用一个连接池**（见 src/persistence/mysql.js）：各建各的池会让
     * connectionLimit 变成一个没人算得清的数字，多副本一乘就把数据库打满。
     */
    mysql: {
      host: str(env.MYSQL_HOST),
      port: num(env.MYSQL_PORT, 3306),
      user: str(env.MYSQL_USER),
      password: str(env.MYSQL_PASSWORD),
      database: str(env.MYSQL_DATABASE),
      connectionLimit: num(env.MYSQL_CONNECTION_LIMIT, 10),
    },

    sessions: {
      /**
       * 只剩这一个值，留着是因为 `/healthz` 与调试信息里都在报它。
       * SESSION_STORE 那个环境变量已经取消 —— 配了也不再有任何效果。
       */
      driver: 'mysql',

      /**
       * 会话第一轮时，让模型看着用户那句话起个标题。
       *
       * 与 MEMORY_CAPTURE 那个默认关掉的开关**不是一个量级**：那个是每轮都额外
       * 调一次模型（等于把全产品调用次数翻倍），这个是**一个会话一次**、几十个
       * token，而且与本轮并行发出，用户感觉不到延迟。所以默认开。
       *
       * 关掉就退回"截取第一句话的前 24 个字"。LLM_MODE=faux 时自动跳过 ——
       * 假模型回的是一段固定的自我介绍，拿它当标题只会让侧栏变成一排一样的字。
       */
      autoTitle: bool(env.SESSION_AUTO_TITLE, true),
    },

    /**
     * 长期记忆（MEMORY.md）。
     *
     * ── 默认是「模型自己决定记什么」，不是「每轮自动抓」 ────────────────────
     *
     * `capture` 曾经默认开着，含义是"每轮跑完再调一次模型，让它挑出值得记的事实"。
     * 那等于**把全产品的模型调用次数翻倍**，换来的是绝大多数轮次的一句 NONE
     * ——"你好"这种一轮也照抓不误。
     *
     * 行业里没人这么做：Claude Code 是 CLAUDE.md + `#` 由人和模型自己维护，
     * ChatGPT 是 `bio` 工具由模型在对话中顺手调，都**不额外起一次调用**。
     * 连我们当初参考的 qm 也不是：它的 per-turn 策略带一个 burst buffer
     * （3 分钟静默或攒够 10 轮才抓一次），另外还专门有一个 `agent-only` 策略
     * —— "Nothing is saved to memory automatically — you are its sole curator"。
     *
     * 所以默认关掉：记忆写入走 `memory` 工具，模型觉得值得记时自己调。
     * 成本是 0（那次调用本来就要发生），用户还能在界面上看到工具卡片，
     * 知道刚刚记了什么 —— 比背地里抓一遍透明得多。
     *
     * 打开 capture 仍然可用（有些场景就是要兜底），但它已经改成**攒批 + 完全异步**：
     * 见 memory/capture.js。
     */
    memory: {
      enabled: bool(env.MEMORY_ENABLED, true),
      capture: bool(env.MEMORY_CAPTURE, false),
      /** 攒批的静默窗口：最后一轮之后安静这么久才抓一次。0 = 不攒批，每轮都抓 */
      captureQuietMs: num(env.MEMORY_CAPTURE_QUIET_MS, 180_000),
      /** 攒够这么多轮就不等静默了，立刻抓 —— 免得长对话一直攒到上下文放不下 */
      captureMaxTurns: num(env.MEMORY_CAPTURE_MAX_TURNS, 10),
    },

    /** 项目（会话分组 + 项目级指令与记忆） */
    projects: {
      enabled: bool(env.PROJECTS_ENABLED, true),
    },

    cron: {
      // 关掉之后接口仍在（能看能改），只是不会自动触发 —— 与"调度副本"分开控制
      enabled: bool(env.CRON_ENABLED, true),
      /**
       * 本副本是否承担调度。**多副本可以同时打开** —— 抢占由数据库行锁保证
       * （见 src/cron/scheduler.js 文件头）。关掉它的用处是让一部分副本
       * 只服务 HTTP 请求，把定时任务的负载圈在另一部分副本上。
       */
      scheduler: bool(env.CRON_SCHEDULER, true),
      tickMs: num(env.CRON_TICK_MS, 30000),
      /**
       * none | stored。默认 none。
       * stored 会把用户登录态写到盘上，让无人值守的触发能拿到凭据 —— 是一道
       * 明确的口子，理由与代价见 src/cron/credentials.js 开头。
       */
      credentialMode: str(env.CRON_CREDENTIAL_MODE, 'none'),
    },

    sandbox: {
      mode: str(env.SANDBOX_MODE, 'http'), // manager | http | local | none
      // http 模式：指向 worker 的 K8s Service。租约响应会回报具体副本地址，之后直连那一个。
      url: str(env.SANDBOX_URL).replace(/\/+$/, ''),
      // 与 worker 共享的密钥。没有它，任何能连到 worker 端口的人都能执行命令。
      // manager 模式下**不再需要**：执行权限来自 manager 签发的短期票据。
      token: str(env.SANDBOX_TOKEN),
      timeoutMs: num(env.SANDBOX_TIMEOUT_MS, 120000),

      /**
       * 把用户的 `me_token` 以 `ME_TOKEN` 环境变量注入沙盒。
       *
       * ⚠️ **这是在隔离契约上显式开一道口子，默认关闭。** 打开之后，沙盒里
       * 模型现写的代码就能读到用户的长期凭据 —— 可以 echo 进回答、写进会同步到
       * 共享存储的工作区文件，而触发它只需要一封诱导邮件（prompt injection）。
       *
       * 存在的理由：部分技能使用 `os.environ["ME_TOKEN"]` 获取用户凭据来调用
       * 外部服务。打开它，这些技能一行不改就能跑。这是一次明确的取舍，不是疏忽。
       * 见 docs/ISOLATION-CONTRACT.md。
       */
      injectMeToken: bool(env.SANDBOX_INJECT_ME_TOKEN, false),

      /**
       * manager 模式：向 sandbox-manager 要一组候选节点，拿票据直连。
       * 协议见 sandbox-manager/docs/PROTOCOL.md §3。
       *
       * 与 http 模式的实质区别是**本进程不再持有长期凭据** —— 拿到的票据绑定
       * 单个节点、60 秒过期、只能换一次租约。
       */
      managerUrl: str(env.SANDBOX_MANAGER_URL).replace(/\/+$/, ''),
      managerCode: str(env.SANDBOX_MANAGER_CODE),
      /** 只调度到这个资源池的节点 */
      pool: str(env.SANDBOX_POOL, 'default'),
      /**
       * 是否要求节点具备浏览器能力。
       *
       * 默认 false，与今天的行为一致（所有节点都装了 Chromium，不需要挑）。
       * 将来混入纯 CPU 节点时再打开——打开之后不具备浏览器的节点会被调度排除，
       * 代价是可用节点变少。不打开的话，调度到无浏览器节点的 run 在真的用到
       * 浏览器时会拿到一个明确的 501，不是静默失败。
       */
      needBrowser: bool(env.SANDBOX_NEED_BROWSER, false),

      /**
       * 持有租约期间周期性续期。
       *
       * worker 侧"活跃即续"只覆盖得住一直在发请求的情况；一轮里模型长思考、
       * 或本地在跑不经沙盒的逻辑时，沙盒会安静十几分钟，正好撞上 idle 回收，
       * 用户回来时工作区已经没了。续期周期由 worker 下发的滑动窗口算出来，
       * 这里只管开关（排查"槽位为什么不释放"时可以临时关掉）。
       */
      keepalive: bool(env.SANDBOX_KEEPALIVE, true),

      /**
       * 命令走异步任务 + 断线续传（节点支持时）。
       *
       * 同步流中途断了这条命令就没了。B/S 之后网络抖一下、网关掐一次空闲连接，
       * 一条跑了四分钟的 `npm install` 就白跑，而且工作区里留下的是半装完的
       * node_modules —— 比彻底没跑还糟。关掉则退回同步流（排查用）。
       */
      execAsync: bool(env.SANDBOX_EXEC_ASYNC, true),

      /**
       * 一轮结束时驻留沙盒，让下一轮接着用（见 docs/SANDBOX-LIFECYCLE.md）。
       *
       * 释放不是删文件，是整个 slot 销毁重建：浏览器登录态、已装的依赖、后台
       * 进程全没。对一次性脚本无所谓，对"打开系统 → 翻到第二页 → 导出"这类
       * 连续任务，等于每轮都从登录页重来。
       *
       *   auto   —— 默认。**只在这一轮真的用过浏览器时**驻留。判据来自已经发生
       *             的事实，不问模型（问它要不要保留，它会永远说要）。
       *             这条足够稀疏，池子不会被驻留吃掉。
       *   always —— 每一轮占过槽位的 run 都驻留。只适合单人调试，多租户下
       *             会让槽位长期被占（虽然有抢占兜底）。
       *   off    —— 今天的行为：用完即释放。
       *
       * 驻留窗口、抢占保护、每用户上限都在 **worker 侧**配（LEASE_PARK_*、
       * MAX_PARKED_PER_USER）—— 容量是节点的事，agent 说了不算。
       */
      park: str(env.SANDBOX_PARK, 'auto'),
    },

    /**
     * 沙盒产物直传对象存储。
     *
     * **agent 不持有任何 OSS 配置。** 凭据与桶配置都在 sandbox-manager，
     * 这里只是替沙盒转一次换取地址的调用。
     * 所以"能不能用"完全取决于接没接管理端。
     *
     * ⚠️ 曾经叫 `artifacts`，与下面那个「作品」撞名了。两者毫无关系：这个是
     * 沙盒里跑出来的大文件往对象存储传，那个是助手产出的、给人看的成品。
     * 一个名字底下两种东西，迟早有人在错的那个上面加开关。
     */
    sandboxArtifacts: {
      enabled: str(env.SANDBOX_MODE, 'http') === 'manager' && Boolean(str(env.SANDBOX_MANAGER_URL)),
    },

    /**
     * 作品（artifact）：助手产出的、独立于对话正文的成品。落 DATA_DIR，
     * 与会话驱动无关（SESSION_STORE=mysql 时一样能用）。见 src/artifacts/store.js。
     */
    artifacts: {
      enabled: bool(env.ARTIFACTS_ENABLED, true),
      /** 单个版本**所有文件加起来**的上限。更大的东西该走沙盒工作区，不该塞进一次工具调用 */
      maxBytes: num(env.ARTIFACT_MAX_BYTES, 512 * 1024),
      /** 一份作品最多几个文件。拆模块是好事，但拆到几十个就该是个仓库而不是作品了 */
      maxFiles: num(env.ARTIFACT_MAX_FILES, 40),
      /** 保留多少份历史。更早的删文件、留元信息 */
      maxVersions: num(env.ARTIFACT_MAX_VERSIONS, 20),
      /**
       * 预览 iframe 允许加载的外部源（逗号分隔，形如 `https://cdn.jsdelivr.net`）。
       *
       * **默认空 = 完全离线**：模型生成的页面连不上任何外部地址。这是刻意的默认值——
       * 那段 HTML 是模型现写的，一旦它能出网，"把页面里的数据 POST 到某处"就成了
       * 一封诱导邮件（prompt injection）能做到的事。要用 CDN 就在这里显式列出来，
       * 列的同时也就知道自己开了什么。
       */
      allowedOrigins: csvExact(env.ARTIFACT_ALLOWED_ORIGINS),
      /**
       * 分享链接：作者可以为某份作品生成 `/s/<token>`，**免登录**即可打开。
       *
       * ⚠️ 这是本服务唯一一条不要求身份的数据通道，所以把它单独做成一个开关：
       * 内网部署里"任何人凭链接可看"可能恰恰是不能接受的（链接会被转发、
       * 会进聊天记录、会被搜索引擎抓到）。关掉之后 `/s/*` 与 `/v1/public/*`
       * 整块 404，已经生成的链接一并失效。
       *
       * 开着也不违反那条核心不变量：分享页是**本服务自己的**页面，
       * 作品正文仍然只走 JSON，由前端塞进不带 allow-same-origin 的 sandbox iframe。
       * 服务端从不以 HTML 的身份吐出模型生成的内容。见 src/artifacts/shares.js。
       */
      sharing: bool(env.ARTIFACT_SHARING_ENABLED, true),
      /**
       * 作品市场：公开的广场，列出所有**显式发布**到市场的作品。
       *
       * 与上面那个是两回事：生成分享链接 ≠ 上广场。关掉它之后分享链接照常，
       * 只是没有那个"所有人都能翻到"的入口。
       */
      market: bool(env.ARTIFACT_MARKET_ENABLED, true),
    },

    /** 联网搜索（`web_search` 工具）。 */
    webSearch: {
      host: str(env.WEB_SEARCH_HOST),
      tenantCode: str(env.WEB_SEARCH_TENANT_CODE),
    },

    skills: {
      dirs: list(env.SKILL_DIRS),
      // 沙盒内 skill-libs（ap_http.mjs/py/sh）所在目录，注入给技能脚本
      libsDir: str(env.SKILL_LIBS_DIR),
    },

    /**
     * 用户工作空间：挂在**所有 agent 节点**上的同一份共享存储。
     *
     * 留空 = 整体关闭，行为与没有这个功能时完全一致（便于灰度）。
     * **worker 上不挂** —— 沙盒保持纯粹，见 src/workspace/store.js 的说明。
     */
    userWorkspace: {
      root: str(env.USER_WORKSPACE_ROOT).replace(/\/+$/, ''),
      // 每人总占用上限。共享盘一般不给 per-user quota，而没有配额就意味着
      // "一个人写满，所有人一起挂"，所以这一层必须 agent 自己算。
      quotaBytes: num(env.USER_WORKSPACE_QUOTA_BYTES, 200 * 1024 * 1024),
      maxFiles: num(env.USER_WORKSPACE_MAX_FILES, 2000),
      // 单轮同步回来的文件数上限，防止一次 `npm install` 把几万个文件搬上共享盘
      maxSyncFiles: num(env.USER_WORKSPACE_MAX_SYNC_FILES, 500),
    },

    limits: {
      maxConcurrentRuns: num(env.MAX_CONCURRENT_RUNS, 8),
      maxRunsPerUser: num(env.MAX_RUNS_PER_USER, 2),
      runTimeoutMs: num(env.RUN_TIMEOUT_MS, 10 * 60 * 1000),
      bodyLimitBytes: num(env.REQUEST_BODY_LIMIT_BYTES, 256 * 1024),
      /**
       * `/v1/chat/stream` 单独一档，因为只有它收附件（图片以 base64 进 JSON，
       * 一张截图就能顶掉上面那个 256KB）。
       *
       * 没有跟着一起放大 bodyLimitBytes：其余端点收的都是几百字节的 JSON，
       * 给它们同样的额度，等于白白多出一片可以被灌数据的面。
       *
       * 这个值要**大于** attachments.js 里那几个上限之和，让先撞上的是
       * 「这张图太大了」这种说得清的报错，而不是「请求体超过 N 字节上限」。
       */
      chatBodyLimitBytes: num(env.REQUEST_BODY_LIMIT_CHAT_BYTES, 12 * 1024 * 1024),
    },

    /**
     * 对话界面（web/index.html）。
     *
     * 与 devConsole 是两个开关，因为性质不同：这是产品自己的前台页面，
     * 生产要开；devConsole 挂的是自检类调试端点，生产必须关。
     * 只有把界面挂到别处（独立前端工程）时才需要把它关掉。
     */
    webUi: bool(env.WEB_UI, true),

    devConsole: bool(env.DEV_CONSOLE, !isProduction),
  }

  validate(config)
  return config
}

function validate(config) {
  const errors = []

  if (!['password', 'dev'].includes(config.auth.mode)) errors.push(`AUTH_MODE 只能是 password|dev，当前 ${config.auth.mode}`)
  if (!['platform', 'db', 'direct', 'faux'].includes(config.llm.mode)) errors.push(`LLM_MODE 只能是 platform|db|direct|faux，当前 ${config.llm.mode}`)
  if (!['none', 'stored'].includes(config.cron.credentialMode)) {
    errors.push(`CRON_CREDENTIAL_MODE 只能是 none|stored，当前 ${config.cron.credentialMode}`)
  }
  if (config.cron.tickMs < 1000) errors.push(`CRON_TICK_MS 不能小于 1000，当前 ${config.cron.tickMs}`)

  /* ── 注册与发信 ── */
  if (!['smtp', 'log'].includes(config.mail.transport)) {
    errors.push(`MAIL_TRANSPORT 只能是 smtp|log，当前 ${config.mail.transport}`)
  }
  const register = config.auth.password.register
  if (register.codeLength < 4 || register.codeLength > 12) {
    errors.push(`REGISTER_CODE_LENGTH 只能是 4~12，当前 ${register.codeLength}`)
  }
  if (register.codeTtlMinutes < 1) errors.push(`REGISTER_CODE_TTL_MINUTES 至少为 1，当前 ${register.codeTtlMinutes}`)
  if (register.maxAttempts < 1) errors.push(`REGISTER_CODE_MAX_ATTEMPTS 至少为 1，当前 ${register.maxAttempts}`)
  /**
   * 开了验证码注册就必须有一个发得出信的账号。
   *
   * 在启动时拦掉，而不是等第一个人来注册：后者的表现是"注册页好好的，
   * 点提交转半天然后报 502"，而运维那边一切正常 —— 没有任何人会立刻想到
   * 是 MAIL_SMTP_HOST 没配。这与下面 MySQL 那条是同一个道理。
   */
  if (config.auth.password.allowRegister && register.verifyEmail && config.mail.transport === 'smtp') {
    if (!config.mail.host) errors.push('开启 REGISTER_VERIFY_EMAIL 时必须配置 MAIL_SMTP_HOST：没有发信账号就发不出验证码，所有人都会卡在激活这一步')
    if (!config.mail.from) errors.push('开启 REGISTER_VERIFY_EMAIL 时必须配置 MAIL_FROM 或 MAIL_SMTP_USER：收信方要知道这封信是谁发的')
  }
  if (config.mail.transport === 'smtp' && config.mail.host && (config.mail.port < 1 || config.mail.port > 65535)) {
    errors.push(`MAIL_SMTP_PORT 不是合法端口，当前 ${config.mail.port}`)
  }
  for (const domain of register.emailDomains) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      errors.push(`REGISTER_EMAIL_DOMAINS 里的 ${domain} 不是合法域名：要形如 example.com，不带 @ 和空格`)
    }
  }
  if (!['manager', 'http', 'local', 'none'].includes(config.sandbox.mode)) errors.push(`SANDBOX_MODE 只能是 manager|http|local|none，当前 ${config.sandbox.mode}`)
  // 拼错了不能静默退化成 auto：那样"我明明关了驻留，槽位怎么还占着"会查很久
  if (!['auto', 'always', 'off'].includes(config.sandbox.park)) errors.push(`SANDBOX_PARK 只能是 auto|always|off，当前 ${config.sandbox.park}`)

  if (config.auth.mode === 'password') {
    const pw = config.auth.password
    /**
     * 必须有**某一条**能产生第一个账号的路子：要么 CONSOLE_USERS 播种，
     * 要么开着自助注册（第一个注册的人就是管理员）。
     *
     * 从前这里只认 CONSOLE_USERS，于是"只开注册、不预置账号"这个完全合理的部署
     * 起不来 —— 而登录接口在没有任何账号时给的提示恰恰是"配 CONSOLE_USERS **或者**
     * 开 AUTH_ALLOW_REGISTER"，两边说的不是一回事。
     */
    if (!pw.users && !pw.allowRegister) {
      errors.push('AUTH_MODE=password 时必须配置 CONSOLE_USERS（格式：user1:pass1,user2:pass2），或者开启 AUTH_ALLOW_REGISTER 让第一个人自己注册（他会是管理员）')
    }
    if (!pw.sessionSecret && !config.platform.fallbackCookie) {
      // 没有显式密钥也没有 FALLBACK_COOKIE 可复用时，用随机值 —— 重启后所有会话失效，
      // 但至少不会起不来。启动日志里会 warn。
    }
  }

  if (config.llm.mode === 'platform' && !config.platform.speedApiBase) errors.push('LLM_MODE=platform 时必须配置 SPEED_API_BASE（平台 API 地址）')
  if (config.llm.mode === 'direct') {
    const d = config.llm.direct
    if (!d.baseUrl) errors.push('LLM_MODE=direct 时必须配置 LLM_DIRECT_BASE_URL（OpenAI 兼容端点，如 https://api.openai.com/v1）')
    if (d.baseUrl && !/^https?:\/\//.test(d.baseUrl)) errors.push(`LLM_DIRECT_BASE_URL 必须是 http:// 或 https:// 开头，当前 ${d.baseUrl}`)
    if (!d.models.length) errors.push('LLM_MODE=direct 时必须配置 LLM_DIRECT_MODEL（逗号分隔，第一个是默认模型）')
    // key 不强制：有些内网网关按来源 IP 放行，不需要 Authorization
  }
  if (config.sandbox.mode === 'http' && !config.sandbox.url) errors.push('SANDBOX_MODE=http 时必须配置 SANDBOX_URL')
  if (config.sandbox.mode === 'manager') {
    if (!config.sandbox.managerUrl) errors.push('SANDBOX_MODE=manager 时必须配置 SANDBOX_MANAGER_URL')
    if (!config.sandbox.managerCode) errors.push('SANDBOX_MODE=manager 时必须配置 SANDBOX_MANAGER_CODE：调度接口靠它鉴权')
    if (config.sandbox.managerUrl && !/^https?:\/\//.test(config.sandbox.managerUrl)) {
      errors.push(`SANDBOX_MANAGER_URL 必须是 http:// 或 https:// 开头的绝对地址，当前 ${config.sandbox.managerUrl}`)
    }
  }
  /**
   * 这几个值会原样拼进预览 iframe 的 CSP。写错一个（带上路径、少个协议头）不会
   * 报错，只会让那条 CSP 指令失效或整体收紧 —— 现象是"预览一片空白"，
   * 而排查的人根本不会想到是环境变量里多打了一个斜杠。
   */
  for (const origin of config.artifacts.allowedOrigins) {
    if (!/^https?:\/\/[^/\s;,']+$/.test(origin)) {
      errors.push(`ARTIFACT_ALLOWED_ORIGINS 里的 ${origin} 不是合法的源：要形如 https://cdn.example.com，不带路径和结尾斜杠`)
    }
  }
  if (config.artifacts.maxBytes < 1024) errors.push(`ARTIFACT_MAX_BYTES 太小（当前 ${config.artifacts.maxBytes}），至少 1024`)
  if (config.artifacts.maxVersions < 1) errors.push(`ARTIFACT_MAX_VERSIONS 至少为 1，当前 ${config.artifacts.maxVersions}`)

  if (config.userWorkspace.root && !path.isAbsolute(config.userWorkspace.root)) {
    errors.push(`USER_WORKSPACE_ROOT 必须是绝对路径，当前 ${config.userWorkspace.root}`)
  }
  /**
   * 连接参数**永远必填** —— 本服务的结构化数据只存数据库，没有"不接库"这条路。
   *
   * 在启动时拦掉，而不是等第一次写数据才报错：后者的表现是服务起来了、
   * /healthz 全绿、用户发第一条消息时炸，而运维在部署日志里什么都没看到。
   */
  const { host, user, database } = config.mysql
  if (!host || !user || !database) {
    errors.push('必须配置 MYSQL_HOST / MYSQL_USER / MYSQL_DATABASE：本服务的会话、项目、记忆、作品、账号都存在数据库里')
  }
  if (config.mysql.connectionLimit < 1) {
    errors.push(`MYSQL_CONNECTION_LIMIT 至少为 1，当前 ${config.mysql.connectionLimit}`)
  }

  // 生产环境的死线
  if (config.isProduction) {
    if (config.auth.mode !== 'password') {
      errors.push(`生产环境 AUTH_MODE 只能是 password：dev 模式信任客户端自称的 X-Username，等于任何人可冒充任何人`)
    }
    if (config.sandbox.mode === 'local') errors.push('生产环境禁止 SANDBOX_MODE=local：那会把用户代码跑在服务进程里，越过全部多租户隔离')
    if (config.llm.mode === 'faux') errors.push('生产环境禁止 LLM_MODE=faux')
    // direct 用的是一把所有人共用的静态 key，与"每个用户用自己的 llmToken"直接冲突：
    // 计费、限流、审计会全部归到同一个主体上，也就答不出"这次调用是谁发起的"。
    if (config.llm.mode === 'direct') errors.push('生产环境禁止 LLM_MODE=direct：它用一把共用的静态 key，用户之间的计费与审计边界会全部消失')
    if (config.devConsole) errors.push('生产环境必须 DEV_CONSOLE=0：它会暴露隔离自检等调试端点')
    /**
     * log 传输会把**验证码原文**打进日志。谁能看日志谁就能激活任意账号 ——
     * 而看日志的人往往比该有这个能力的人多得多（运维、监控、日志平台）。
     */
    if (config.mail.transport === 'log') {
      errors.push('生产环境禁止 MAIL_TRANSPORT=log：它把验证码原文打进日志，等于任何能看日志的人都能激活别人的账号')
    }
    if (!config.mail.rejectUnauthorized && config.mail.transport === 'smtp' && config.mail.host) {
      errors.push('生产环境禁止 MAIL_TLS_REJECT_UNAUTHORIZED=0：信里带着验证码，这条链路被中间人接管就等于账号被接管')
    }
    if (config.platform.fallbackCookie) errors.push('生产环境禁止配置 FALLBACK_COOKIE：那是把某个人的登录态当成全服务的身份')
    if (config.sandbox.mode === 'http' && !config.sandbox.token) {
      errors.push('生产环境 SANDBOX_MODE=http 时必须配置 SANDBOX_TOKEN：没有它，任何能连到 worker 端口的人都能在沙盒里执行命令')
    }
  }

  if (errors.length) {
    const error = new Error(`配置校验失败：\n  - ${errors.join('\n  - ')}`)
    error.code = 'CONFIG_INVALID'
    throw error
  }
}
