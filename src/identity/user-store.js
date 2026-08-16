/**
 * 账号存储。
 *
 * ── 从环境变量搬到存储里，解决什么 ──────────────────────────────────────
 *
 * 从前账号只存在于 `CONSOLE_USERS=alice:pass1,bob:pass2` 这一个环境变量里：
 *   - 密码是**明文**，躺在 .env、docker-compose、CI 的变量面板、以及任何一次
 *     `docker inspect` 的输出里；
 *   - 加一个人要改配置再重启整个服务；
 *   - 改密码同理，而且改完之后旧密码在 shell history 里还留着。
 *
 * 现在账号是一条正经记录，密码只留 **scrypt 派生结果 + 每人独立的盐**。
 * CONSOLE_USERS 退化成**首次播种**：启动时把里面的账号补进存储（已存在就跳过），
 * 于是老部署升级上来不用做任何事，而新账号从此走接口创建。
 *
 * ── 为什么是 scrypt ────────────────────────────────────────────────────
 *
 * Node 标准库自带（`crypto.scrypt`），不引第三方依赖；它是内存硬的，
 * 比 PBKDF2 更能抵抗 GPU 爆破。参数写在下面的 SCRYPT 里，与派生结果一起存 ——
 * 不存的话，将来调高成本参数就没法校验老密码了（老记录用老参数，新记录用新的）。
 *
 * ⚠️ 校验一律走 `timingSafeEqual`，且**用户不存在时也要跑一遍完整的派生**：
 * 直接 return false 会让"这个用户名存不存在"从响应时间上露出来，
 * 而那正是撞库的第一步（先枚举出哪些账号是真的，再集中猜它们的密码）。
 */
import crypto from 'node:crypto'
import { promisify } from 'node:util'

import { PAGE_DEFAULT, PAGE_MAX } from '../persistence/page.js'
import { parseUsers } from './password-auth.js'

const scrypt = promisify(crypto.scrypt)

/**
 * scrypt 成本参数。N=16384 在普通服务器上一次派生约 50~100ms ——
 * 登录路径上可以接受，而爆破方要为每一次猜测付同样的代价。
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }
const SALT_BYTES = 16

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/
/**
 * 密码长度下限。
 *
 * 8 位不是什么强要求，但它挡住的是"把密码设成 1234"这类 ——
 * 而这个服务的账号一旦被撞开，拿到的是对方全部的对话、记忆和作品。
 */
const PASSWORD_MIN = 8
const PASSWORD_MAX = 200

/**
 * 邮箱。**故意写得宽松**：`local@domain.tld`，不含空格，总长不超过 254（RFC 5321）。
 *
 * 不去追求"完全符合 RFC 5322 的正则" —— 那个正则长得没人看得懂，而且它判对了
 * 也说明不了这个邮箱**存在**。真正的判据只有一个：那封验证码信收不收得到。
 * 这里挡的只是明显打错的（少个 @、带空格、末尾没有点）。
 */
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}$/
const EMAIL_MAX = 254

export function assertUsername(input) {
  const name = String(input || '').trim()
  if (!USERNAME_RE.test(name)) {
    throw new Error('用户名只能是字母、数字、点、下划线、连字符，且不超过 64 字符')
  }
  return name
}

/**
 * 校验并**归一化**邮箱：去空格、转小写。
 *
 * 归一化不是洁癖：不转小写的话 `Alice@x.com` 和 `alice@x.com` 会是两条互不相干的
 * 记录，于是"这个邮箱已经注册过了"这道检查形同虚设 —— 域名部分本来就大小写不敏感。
 *
 * @param {string[]} [allowedDomains] 非空时只放行这些域名（内网部署常见的"只让公司邮箱注册"）
 */
export function assertEmail(input, allowedDomains = []) {
  const email = String(input || '').trim().toLowerCase()
  if (!email) throw new Error('邮箱不能为空')
  if (email.length > EMAIL_MAX) throw new Error(`邮箱不能超过 ${EMAIL_MAX} 字符`)
  if (!EMAIL_RE.test(email)) throw new Error('邮箱格式不正确')
  if (allowedDomains.length) {
    const domain = email.slice(email.lastIndexOf('@') + 1)
    if (!allowedDomains.includes(domain)) {
      throw new Error(`只允许使用这些邮箱域名注册：${allowedDomains.join('、')}`)
    }
  }
  return email
}

export function assertPassword(input) {
  const password = String(input ?? '')
  if (password.length < PASSWORD_MIN) throw new Error(`密码至少 ${PASSWORD_MIN} 位`)
  if (password.length > PASSWORD_MAX) throw new Error(`密码不能超过 ${PASSWORD_MAX} 位`)
  return password
}

async function derive(password, salt) {
  const key = await scrypt(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    // scrypt 的内存开销约 128*N*r 字节；不放宽这个上限，N=16384 会直接抛
    maxmem: 256 * SCRYPT.N * SCRYPT.r,
  })
  return key.toString('hex')
}

/** 一次性的假派生，用来把"用户不存在"的耗时抹平到与真校验一致 */
async function burnTime() {
  await derive('dummy-password', 'dummy-salt-0000')
}

export function toPublicUser(record) {
  if (!record) return null
  return {
    username: record.username,
    role: record.role || 'user',
    disabled: Boolean(record.disabled),
    /**
     * 所属分组，决定他能用哪些模型（见 src/identity/group-store.js）。
     * **空串是合法状态**（"没分组"），不是"数据缺失" —— 老账号升级上来全是空的，
     * 而它们照样能用那些没有限制可用范围的模型。
     */
    groupId: record.groupId || '',
    /**
     * 邮箱。**可以是空串** —— 只有开了 REGISTER_REQUIRE_EMAIL / REGISTER_VERIFY_EMAIL
     * 的部署才强制要，而管理员创建的账号和 CONSOLE_USERS 播种进来的从来没有。
     */
    email: record.email || '',
    /**
     * 激活状态。**只有"明确是 false"才算未激活**。
     *
     * 这条判据是故意写成这样的：老记录里根本没有这个字段，当成 undefined→未激活
     * 的话，一次升级就会把全部存量账号锁在门外，而且现象是"密码明明是对的"。
     * 新账号一律显式写 true/false，于是这里的宽容只作用于升级那一次。
     */
    activated: record.activated !== false,
    createdAt: record.createdAt || 0,
    updatedAt: record.updatedAt || 0,
  }
}

/**
 * @param {object} params
 * @param {object} params.storage 结构化存储后端。账号用 **globalMap** —— 它按定义
 *   就不属于某一个用户，而是"这个部署有哪些用户"。这是隔离契约那条
 *   "只能拿某个人的表"的合理例外，与分享指针表同理。
 * @param {object} [params.groups] 分组 store。传了的话，**新账号自动进默认分组**。
 *   做成依赖而不是让每个调用方自己查一次：建账号的入口有三个（管理员创建、
 *   自助注册、CONSOLE_USERS 播种），漏掉任何一个的表现都是"那个人打开对话框
 *   一个模型都没有"，而那个现象完全看不出是在哪儿漏的。
 */
export function createUserStore({ config, storage, groups = null, logger = console, now = () => Date.now() }) {
  /**
   * 注册细则（要不要邮箱、验证码几位、多久过期）。
   * 单测里构造的 config 未必带这一段，所以给一份与 config.js 默认值一致的兜底。
   */
  const registerPolicy = {
    codeLength: 6,
    codeTtlMinutes: 15,
    maxAttempts: 5,
    resendIntervalSeconds: 60,
    emailDomains: [],
    ...(config.auth?.password?.register || {}),
  }
  /**
   * 集合名是 `accounts` 而不是 `users`。
   *
   * 文件驱动下 globalMap 落在 `<dataDir>/<collection>/`，而按用户分区的数据
   * 已经占着 `<dataDir>/users/<username>/` —— 叫 users 的话，账号记录会变成
   * `<dataDir>/users/zhangsan.json`，和那个人的数据目录 `users/zhangsan/` 并排躺着。
   * 文件系统能分得开（一个是文件一个是目录），但任何一次"把 users/ 拷走"
   * 或"清掉某个人的数据"都会连账号一起碰到。换个名字比记住这件事便宜。
   */
  const map = storage.globalMap('accounts')

  /**
   * 首次播种：把 CONSOLE_USERS 里的账号补进存储。
   *
   * **只补不改**（putIfAbsent 语义）：已经存在的账号不会被环境变量覆盖回去 ——
   * 否则用户在界面上改完密码，一次重启就被打回原样，而且没有任何提示。
   */
  async function seedFromEnv() {
    const seeds = [...parseUsers(config.auth.password.users)]
    if (!seeds.length) return { seeded: 0, skipped: 0 }
    // 库里一个人都没有 = 全新部署，那么 CONSOLE_USERS 的**第一个**就是管理员。
    // 已经有人了就不再自动给管理员 —— 那属于提权，得由现有管理员显式操作。
    // 用 count() 而不是 `all().length`：这一句只想知道"是不是空的"，
    // 而它跑在**每次启动**上 —— 没必要为一个布尔把整张账号表读出来
    const fresh = (await map.count()) === 0
    let seeded = 0
    let skipped = 0
    for (const [index, [username, password]] of seeds.entries()) {
      if (await map.get(username)) { skipped += 1; continue }
      try {
        // 播种的密码来自环境变量，不受 PASSWORD_MIN 约束 —— 老部署里可能就是短的，
        // 为此拒绝启动会把一个本来能用的部署直接锁在门外
        await create({
          username,
          password,
          role: fresh && index === 0 ? 'admin' : 'user',
          enforcePolicy: false,
        })
        seeded += 1
      } catch (error) {
        logger.warn?.('CONSOLE_USERS 播种失败', { username, err: error?.message })
      }
    }
    if (seeded) logger.info?.('已从 CONSOLE_USERS 播种账号', { seeded, skipped })
    return { seeded, skipped }
  }

  /**
   * 校验密码。
   *
   * @returns {Promise<{ok: boolean, reason?: string, user?: object}>}
   *   `reason` 只给日志用 —— **对外一律回同一句"用户名或密码错误"**，
   *   区分开就等于告诉撞库的人"这个用户名是对的，继续猜密码"。
   */
  async function verify(username, password) {
    const name = String(username || '')
    const record = USERNAME_RE.test(name) ? await map.get(name) : null
    if (!record) {
      await burnTime() // 抹平时间差，见文件头
      return { ok: false, reason: 'no-such-user' }
    }
    const actual = Buffer.from(await derive(String(password ?? ''), record.salt), 'hex')
    const expected = Buffer.from(record.passwordHash, 'hex')
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return { ok: false, reason: 'bad-password' }
    }
    if (record.disabled) return { ok: false, reason: 'disabled' }
    /**
     * 密码是对的，但账号还没激活。
     *
     * 放在密码校验**之后**判，不是随手排的顺序：先判激活状态的话，任何人报一个
     * 用户名就能问出"这个账号存不存在、激活没有"。放在后面，能看到这条的人
     * 已经证明他知道密码 —— 那对他不是新信息。
     */
    if (record.activated === false) return { ok: false, reason: 'inactive', user: toPublicUser(record) }
    return { ok: true, user: toPublicUser(record) }
  }

  /* ═══════════ 注册验证码 ═══════════ */

  /**
   * 验证码只存**摘要**，不存原文。
   *
   * 说清楚这一步挡得住什么、挡不住什么：6 位数字一共一百万种，谁拿到摘要都能
   * 在一秒内枚举回来 —— 所以这**不是**"即使库被拖走验证码也安全"。它挡的是
   * 顺手一眼（备份、慢查询日志、DBA 的临时导出里不会躺着一串能直接用的码）。
   * 真正兜底的是有效期和试错次数上限，见 verifyActivationCode。
   *
   * 掺上用户名一起哈希：否则同一时刻发出去的两个 `000000` 摘要一模一样，
   * 库里一眼就能看出谁和谁的码是同一个。
   */
  function hashCode(username, code) {
    return crypto.createHash('sha256').update(`${username}:${code}`).digest('hex')
  }

  /** 定长的数字验证码。用 randomInt 而不是 Math.random —— 后者可预测，而这是一次性凭据 */
  function generateCode(length) {
    let code = ''
    while (code.length < length) code += String(crypto.randomInt(0, 10))
    return code
  }

  /** 摘要比对也走 timingSafeEqual：长度固定，直接比 */
  function sameHash(a, b) {
    const left = Buffer.from(String(a || ''), 'utf8')
    const right = Buffer.from(String(b || ''), 'utf8')
    return left.length === right.length && crypto.timingSafeEqual(left, right)
  }

  /**
   * 换一副新盐重新派生。改密与管理员重置共用，别写两遍。
   *
   * ⚠️ **必须同时把 tokenVersion 加一**，见文件头关于令牌回收那段：
   * 不加的话"改密码"只挡住了未来的登录，而已经签发出去的那些令牌
   * 照样能用到过期（默认 24 小时）—— 也就是说，发现密码泄露之后改密码，
   * 并不能把已经拿着令牌的人踢下去。这正是改密码的人以为自己做到的事。
   */
  async function setPassword(name, secret) {
    const salt = crypto.randomBytes(SALT_BYTES).toString('hex')
    const passwordHash = await derive(secret, salt)
    return map.update(name, (current) => ({
      ...current,
      salt,
      passwordHash,
      tokenVersion: (Number(current.tokenVersion) || 0) + 1,
      updatedAt: Date.now(),
    }))
  }

  /**
   * @param {object} params
   * @param {string} [params.email] 留空 = 这个账号没有邮箱（管理员创建、CONSOLE_USERS 播种
   *   一直都是这样）。要不要强制留，是 HTTP 层按配置决定的事。
   * @param {boolean} [params.activated] 账号建出来算不算激活。**默认 true** ——
   *   未激活是自助注册 + 邮箱验证码这一条路上的特例，其余入口（管理员创建、播种）
   *   建出来就该能用。默认成 false 的话，一次配置疏忽就会让管理员创建的账号
   *   全都登不进去，而管理台上看起来一切正常。
   * @param {boolean} [params.replacePending] 用户名已存在**且那个账号还没激活**时，
   *   允许覆盖它。见下面 putIfAbsent 那一段。
   */
  async function create({
    username, password, role = 'user', groupId, enforcePolicy = true,
    email = '', activated = true, replacePending = false,
  }) {
    const name = assertUsername(username)
    const secret = enforcePolicy ? assertPassword(password) : String(password ?? '')
    if (!secret) throw new Error('密码不能为空')
    const mail = email ? assertEmail(email, registerPolicy.emailDomains) : ''

    /**
     * 一个邮箱只能注册一个账号。
     *
     * ⚠️ 这是**尽力而为**，不是数据库唯一约束：两个并发的注册请求可能都查不到对方，
     * 于是双双写进去。这里认了 —— 邮箱重复不是一条安全边界（它既不影响谁能登录，
     * 也不影响谁能看到什么），而为它上一把跨行的锁，代价远大于它挡住的那点混乱。
     * 用户名的唯一性不一样，那个是硬的，靠下面的 putIfAbsent 保证。
     */
    if (mail) {
      const taken = await findByEmail(mail)
      if (taken && taken.username !== name) throw new Error(`邮箱 ${mail} 已经注册过了`)
    }

    /**
     * 没显式指定分组就用默认分组。**取不到默认分组不是错误** ——
     * 一个还没建过任何分组的部署里，所有人都是无分组，那是合法状态。
     */
    const group = groupId === undefined
      ? (await groups?.defaultGroupId().catch(() => '')) || ''
      : String(groupId || '')

    const salt = crypto.randomBytes(SALT_BYTES).toString('hex')
    const at = now()
    const record = {
      username: name,
      passwordHash: await derive(secret, salt),
      salt,
      role: role === 'admin' ? 'admin' : 'user',
      disabled: false,
      groupId: group,
      email: mail,
      activated: Boolean(activated),
      /**
       * 令牌代数。签发时写进 JWT，每次请求比对（见 src/identity/index.js）。
       * 改密 / 禁用会把它推一格，于是旧令牌当场作废。
       *
       * 老账号记录里没有这个字段，读的时候一律当 0 —— 所以这次升级不需要
       * 数据迁移，也不会把所有人踢下线。
       */
      tokenVersion: 0,
      createdAt: at,
      updatedAt: at,
    }
    // putIfAbsent 而不是 put：并发两个注册请求撞同一个用户名时，
    // 后到的那个应当失败，而不是把先到的那个覆盖掉
    const stored = await map.putIfAbsent(name, record)
    if (stored !== record) {
      /**
       * 用户名被占了。**如果占着它的那个账号从来没激活过**，允许这次注册顶掉它。
       *
       * 为什么这是对的：未激活的账号没有主人 —— 没人用它登录过，它名下没有任何
       * 会话、作品、记忆。不让顶的话，随便谁提交一次注册就能把一个用户名**永久**
       * 占住（他自己也用不了），而真正想用这个名字的人只能去找管理员。
       *
       * 代价是：A 正等着收验证码时，B 可以用同一个用户名重新注册，A 手里那个码
       * 就作废了。A 什么也没丢（那个账号还不属于他），重新注册一次即可。
       * 这条路本来就只在开放注册的部署上存在，而那里用户名先到先得。
       */
      if (!(replacePending && stored?.activated === false)) {
        throw new Error(`用户名 ${name} 已被占用`)
      }
      // 保留最初的创建时间：这个用户名从那时起就在被人尝试注册，账上留个痕
      await map.put(name, { ...record, createdAt: stored.createdAt || at })
    }
    return toPublicUser(record)
  }

  /**
   * 按邮箱找账号。**仍然是全表扫**（邮箱住在 JSON 里，没有索引可走），
   * 但**一页一页地扫**，而不是先把全部账号读进内存再遍历。
   *
   * 两者的复杂度一样，差别在峰值内存和"找到就停"：绝大多数情况下要找的那个人
   * 排在前几页，翻到就返回，后面的页根本不会去查。从前那种写法必须先把最后一个
   * 账号也读出来，才能开始比第一个。
   *
   * 只在注册和找回这类低频路径上调。真到了需要索引的规模，该做的是给账号
   * 拆一张有 email 列和唯一索引的正经表，而不是在这里塞一层会和主表漂移的缓存。
   */
  async function findByEmail(email) {
    const target = String(email || '').trim().toLowerCase()
    if (!target) return null
    let cursor = ''
    for (;;) {
      const { items, hasMore, nextCursor } = await map.page({ cursor, limit: PAGE_MAX })
      for (const record of items) {
        if (String(record.email || '').toLowerCase() === target) return toPublicUser(record)
      }
      if (!hasMore) return null
      cursor = nextCursor
    }
  }

  return {
    seedFromEnv,
    create,
    findByEmail,

    /**
     * 发一份新的验证码（注册时第一次发、以及后来的"重发"走的是同一个方法）。
     *
     * **回的是验证码原文**，只交给发信那一步用，绝不能进日志、进响应体。
     * 存进库里的是它的摘要，见 hashCode。
     *
     * @returns {Promise<{ok: boolean, reason?: string, code?: string, expiresAt?: number, retryAfterMs?: number}>}
     */
    async issueActivationCode({ username }) {
      const name = String(username || '')
      if (!USERNAME_RE.test(name)) return { ok: false, reason: 'no-such-user' }
      const record = await map.get(name)
      if (!record) return { ok: false, reason: 'no-such-user' }
      if (record.activated !== false) return { ok: false, reason: 'already-active' }
      if (!record.email) return { ok: false, reason: 'no-email' }

      const at = now()
      /**
       * 两次发信之间要隔一会儿。挡的不是注册的人，是拿我们的发信账号去轰炸
       * 别人邮箱的人 —— 没有这道闸，一个 `/resend` 循环就是一台免费的发信机。
       */
      const interval = registerPolicy.resendIntervalSeconds * 1000
      const sentAt = Number(record.activation?.sentAt) || 0
      if (sentAt && at - sentAt < interval) {
        return { ok: false, reason: 'too-soon', retryAfterMs: interval - (at - sentAt) }
      }

      const code = generateCode(registerPolicy.codeLength)
      const expiresAt = at + registerPolicy.codeTtlMinutes * 60 * 1000
      const updated = await map.merge(name, {
        // 整份换掉而不是改字段：重发要把试错次数一起清零，
        // 否则前一份码被试满之后，重发出来的新码一进门就是"次数已用尽"
        activation: { codeHash: hashCode(name, code), expiresAt, attempts: 0, sentAt: at },
        updatedAt: at,
      })
      if (!updated) return { ok: false, reason: 'no-such-user' }
      return { ok: true, code, expiresAt, email: record.email, ttlMinutes: registerPolicy.codeTtlMinutes }
    },

    /**
     * 拿验证码换激活。
     *
     * 整件事在**一次 update 里**完成（存储层是 SELECT ... FOR UPDATE + 事务），
     * 而不是"读出来判断、再写回去"：后者在并发下，两个请求会读到同一个
     * attempts，于是试错次数上限可以靠并发绕过 —— 一次发 50 个猜测只算 1 次。
     *
     * @returns {Promise<{ok: boolean, reason?: string, user?: object, attemptsLeft?: number}>}
     *   reason: no-such-user | already-active | no-code | expired | too-many-attempts | bad-code
     */
    async verifyActivationCode({ username, code }) {
      const name = String(username || '')
      if (!USERNAME_RE.test(name)) return { ok: false, reason: 'no-such-user' }

      const at = now()
      let outcome = { ok: false, reason: 'no-such-user' }
      const updated = await map.update(name, (current) => {
        if (current.activated !== false) {
          outcome = { ok: false, reason: 'already-active' }
          return current
        }
        const activation = current.activation
        if (!activation?.codeHash) {
          outcome = { ok: false, reason: 'no-code' }
          return current
        }
        if (Number(activation.expiresAt) <= at) {
          // 过期的码直接摘掉：留着只会让下一次请求再判一遍同样的过期
          outcome = { ok: false, reason: 'expired' }
          return { ...current, activation: undefined, updatedAt: at }
        }
        const attempts = Number(activation.attempts) || 0
        if (attempts >= registerPolicy.maxAttempts) {
          outcome = { ok: false, reason: 'too-many-attempts' }
          return { ...current, activation: undefined, updatedAt: at }
        }
        if (!sameHash(activation.codeHash, hashCode(name, String(code ?? '')))) {
          const used = attempts + 1
          const left = registerPolicy.maxAttempts - used
          outcome = { ok: false, reason: left > 0 ? 'bad-code' : 'too-many-attempts', attemptsLeft: Math.max(0, left) }
          /**
           * 试满就把这份码作废（必须重发）。
           *
           * 这才是 6 位数字真正的护栏：一百万种可能里，允许试 5 次意味着
           * 单份验证码被猜中的概率是二十万分之一，而重发还要过上面那道间隔闸。
           */
          return {
            ...current,
            activation: left > 0 ? { ...activation, attempts: used } : undefined,
            updatedAt: at,
          }
        }
        // 对了：激活，并且把验证码摘掉 —— 一次性的东西不留第二次机会
        outcome = { ok: true }
        return { ...current, activated: true, activation: undefined, updatedAt: at }
      })

      if (!updated) return { ok: false, reason: 'no-such-user' }
      return outcome.ok ? { ok: true, user: toPublicUser(updated) } : outcome
    },

    async get(username) {
      if (!USERNAME_RE.test(String(username || ''))) return null
      return toPublicUser(await map.get(String(username)))
    },

    /**
     * 账号清单，**一页一页取**。
     *
     * ── 为什么这里必须是真的分页 ────────────────────────────────────────
     *
     * 从前是 `map.all()` 整取再在 JS 里排序。账号是这个部署里**唯一一个跟着使用量
     * 无上限增长**的全局集合（模型十几条、分组几条，那两个整取是有依据的），
     * 所以那句话的实际含义是：管理员每打开一次账号页，就把每个人的完整记录
     * —— 包括 scrypt 派生结果和盐 —— 从库里搬进 Node，再排一遍序，然后丢掉
     * 其中除了这一屏之外的全部。
     *
     * 现在走存储层的 `page()`：`ap_kv` 的主键是 `(collection, owner, id)`，
     * 而**账号的 id 就是用户名**，也就是排序键本身 —— 于是"按用户名升序翻页"
     * 正好是主键上的一次范围扫描，翻到第几页都一样快。
     *
     * ⚠️ 排序从 `localeCompare` 换成了 SQL 的排序（utf8mb4 的默认校对）。
     * 中文用户名的相对次序可能与从前不同，这是把排序交给数据库的必然代价 ——
     * 而它是唯一能与翻页自洽的选择：在 Node 里重排一页，只会让第二页的第一条
     * 排到第一页的中间去。
     *
     * @param {string} [params.search] 用户名的子串筛选。**服务端做** ——
     *   从前是前端在已加载的清单上 filter，分页之后那等于"只搜当前这一页"，
     *   而搜不到的人看起来就像不存在。
     * @returns {Promise<{items, hasMore, nextCursor}>}
     */
    async page({ cursor = '', limit = PAGE_DEFAULT, search = '' } = {}) {
      const found = await map.page({ cursor, limit, contains: String(search || '').trim() })
      return { ...found, items: found.items.map(toPublicUser) }
    },

    /** 取一批账号（一页的量）。给用量页那些行补 role / disabled 用 */
    async getMany(usernames) {
      const names = (usernames || []).map((name) => String(name || '')).filter((name) => USERNAME_RE.test(name))
      return (await map.many(names)).map(toPublicUser)
    },

    /** 符合这个搜索词的账号有多少个。表头那句"共 N 个账号"用它，不再靠数组长度 */
    async count({ search = '' } = {}) {
      return map.count({ contains: String(search || '').trim() })
    },

    /**
     * 每个分组各有多少人（外加 `''` 那一档 = 无分组）。
     *
     * 存在的理由是分组页上那两个数。从前它们是把**全部账号**取回来在 JS 里
     * filter 出来的，也就是说打开一次分组页 = 一次全表搬运，
     * 而页面上真正要显示的只有每组一个整数。
     */
    async countByGroup() {
      return map.countByField('groupId')
    },

    /**
     * 账号总数 + **在岗管理员数**。
     *
     * 后面这个数是有具体用处的，不是装饰：界面靠它判断"这是不是最后一个管理员"
     * （最后一个不能降级也不能禁用，降完就没人能再改回来）。从前它是
     * `adminUsers.filter(...)` 从**已加载的那一页**算的 —— 分页之后那个算法会
     * 在第二页上告诉你"管理员只剩一个了"，而实际上第一页里还有三个。
     *
     * ⚠️ 这一句仍然是全表扫（role 住在 JSON 里，见 mysql-map.countByField 的说明）。
     * 它只在管理台打开时走一次，回来的是两个整数。
     */
    async stats() {
      /**
       * 被禁用的管理员不算数：他登不进来，也就救不了场。所以判据是
       * **role = admin 且 disabled ≠ true**，两个条件一句 SQL 里数完。
       *
       * 写成"不等于 true"而不是"等于 false"，是为了老记录：`disabled` 这个字段
       * 不是从第一天就有的，缺了它的行在业务上是"没被禁"（toPublicUser 里
       * `Boolean(record.disabled)` 就是这么读的），而 `= 'false'` 会把它们漏掉 ——
       * 现象是界面认定"这是最后一个管理员"，把几个本来能操作的按钮全禁掉。
       */
      const [total, admins] = await Promise.all([
        map.count(),
        map.countMatching({ role: 'admin' }, { disabled: true }),
      ])
      return { total, admins }
    },

    /**
     * 校验令牌时要看的那几样，一次取齐。
     *
     * 单独开一个方法而不是复用 `get()`：这条路**每个请求都会走**，
     * 而 `get()` 回的是给界面看的完整账号。分开之后，将来给公开账号形状
     * 加字段时不会顺手加到这条热路径上。
     *
     * 账号不存在回 null —— 调用方据此把令牌判成失效（删号即下线）。
     */
    async authState(username) {
      const name = String(username || '')
      if (!USERNAME_RE.test(name)) return null
      const record = await map.get(name)
      if (!record) return null
      return {
        username: record.username,
        // 老记录没有这个字段，当 0 —— 见 create() 里的说明
        tokenVersion: Number(record.tokenVersion) || 0,
        disabled: Boolean(record.disabled),
        role: record.role || 'user',
      }
    },

    verify,

    /**
     * 改密码。**必须先验旧密码** —— 令牌可能是从别人电脑上拿到的，
     * 只凭令牌就能改密等于把"临时借用"变成"永久接管"。
     */
    async changePassword({ username, oldPassword, newPassword }) {
      const name = assertUsername(username)
      const check = await verify(name, oldPassword)
      if (!check.ok) return { ok: false, error: '原密码不正确' }
      const updated = await setPassword(name, assertPassword(newPassword))
      return { ok: Boolean(updated) }
    },

    /** 管理员重置某人的密码：不需要旧密码，但需要调用方已经是 admin（由 HTTP 层判定） */
    async resetPassword({ username, newPassword }) {
      const name = assertUsername(username)
      return Boolean(await setPassword(name, assertPassword(newPassword)))
    },

    /**
     * 禁用/启用。**不删数据** —— 删账号会留下一堆没有主人的会话、作品、分享链接，
     * 而"这个人离职了，别让他再登录"想要的只是关掉入口。
     */
    async setDisabled({ username, disabled }) {
      const name = assertUsername(username)
      const off = Boolean(disabled)
      /**
       * 禁用要把 tokenVersion 也推一格，理由与改密码相同（见 setPassword）：
       * 只改 disabled 标记的话，那个人手里的令牌照样能用到过期 ——
       * 而"禁用某人"要的显然是**现在就把他挡在外面**，不是"最多 24 小时后"。
       *
       * 启用不推：那时并没有什么令牌需要作废，推一格只会顺手把这个人在别的
       * 设备上的登录态一起踢掉，而他什么也没做错。
       */
      const updated = await map.update(name, (current) => ({
        ...current,
        disabled: off,
        tokenVersion: (Number(current.tokenVersion) || 0) + (off ? 1 : 0),
        updatedAt: Date.now(),
      }))
      return updated ? toPublicUser(updated) : null
    },

    async setRole({ username, role }) {
      const name = assertUsername(username)
      const updated = await map.merge(name, { role: role === 'admin' ? 'admin' : 'user', updatedAt: Date.now() })
      return updated ? toPublicUser(updated) : null
    },

    /**
     * 换分组（空串 = 退出分组）。
     *
     * **不校验这个分组存不存在** —— 那是 HTTP 层的事，它才知道要回 400 还是 404。
     * 这里校验的话，"分组刚被别的管理员删掉"会让一次正常的改组抛一个存储层的
     * 裸 Error，最后表现成 500。
     */
    async setGroup({ username, groupId }) {
      const name = assertUsername(username)
      const updated = await map.merge(name, { groupId: String(groupId || ''), updatedAt: Date.now() })
      return updated ? toPublicUser(updated) : null
    },

    /**
     * 这个分组没了：把所有属于它的人退回无分组。
     *
     * 不这么做的话，库里会留下一批指向不存在分组的账号 —— 他们能用的模型
     * 与无分组的人**碰巧**一样（因为按 id 匹配匹配不上），
     * 但界面上会显示一个空白的分组名，谁也说不清那是什么。
     */
    async clearGroup(groupId) {
      const target = String(groupId || '')
      if (!target) return 0
      let touched = 0
      /**
       * 一页一页地翻着改，不把全部账号读进内存。
       *
       * 按 id（= 用户名）翻页在这里是**安全的**：这个循环只改 `groupId`，
       * 不改也不删 id，所以序列不会在翻页途中重排 —— 而那正是 keyset 翻页
       * 唯一怕的事。
       */
      let cursor = ''
      for (;;) {
        const { items, hasMore, nextCursor } = await map.page({ cursor, limit: PAGE_MAX })
        for (const record of items) {
          if (record.groupId !== target) continue
          await map.merge(record.username, { groupId: '', updatedAt: Date.now() })
          touched += 1
        }
        if (!hasMore) return touched
        cursor = nextCursor
      }
    },
  }
}
