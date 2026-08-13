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

export function assertUsername(input) {
  const name = String(input || '').trim()
  if (!USERNAME_RE.test(name)) {
    throw new Error('用户名只能是字母、数字、点、下划线、连字符，且不超过 64 字符')
  }
  return name
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
    createdAt: record.createdAt || 0,
    updatedAt: record.updatedAt || 0,
  }
}

/**
 * @param {object} params
 * @param {object} params.storage 结构化存储后端。账号用 **globalMap** —— 它按定义
 *   就不属于某一个用户，而是"这个部署有哪些用户"。这是隔离契约那条
 *   "只能拿某个人的表"的合理例外，与分享指针表同理。
 */
export function createUserStore({ config, storage, logger = console }) {
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
    // 已经有人了就不再自动给管理员 —— 那属于提权，得由现有管理员显式操作
    const fresh = (await map.all()).length === 0
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
    return { ok: true, user: toPublicUser(record) }
  }

  /** 换一副新盐重新派生。改密与管理员重置共用，别写两遍 */
  async function setPassword(name, secret) {
    const salt = crypto.randomBytes(SALT_BYTES).toString('hex')
    return map.merge(name, {
      salt,
      passwordHash: await derive(secret, salt),
      updatedAt: Date.now(),
    })
  }

  async function create({ username, password, role = 'user', enforcePolicy = true }) {
    const name = assertUsername(username)
    const secret = enforcePolicy ? assertPassword(password) : String(password ?? '')
    if (!secret) throw new Error('密码不能为空')

    const salt = crypto.randomBytes(SALT_BYTES).toString('hex')
    const now = Date.now()
    const record = {
      username: name,
      passwordHash: await derive(secret, salt),
      salt,
      role: role === 'admin' ? 'admin' : 'user',
      disabled: false,
      createdAt: now,
      updatedAt: now,
    }
    // putIfAbsent 而不是 put：并发两个注册请求撞同一个用户名时，
    // 后到的那个应当失败，而不是把先到的那个覆盖掉
    const stored = await map.putIfAbsent(name, record)
    if (stored !== record) throw new Error(`用户名 ${name} 已被占用`)
    return toPublicUser(record)
  }

  return {
    seedFromEnv,
    create,

    async get(username) {
      if (!USERNAME_RE.test(String(username || ''))) return null
      return toPublicUser(await map.get(String(username)))
    },

    async list() {
      const all = await map.all()
      return all.map(toPublicUser).sort((a, b) => a.username.localeCompare(b.username))
    },

    async count() {
      return (await map.all()).length
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
      const updated = await map.merge(name, { disabled: Boolean(disabled), updatedAt: Date.now() })
      return updated ? toPublicUser(updated) : null
    },

    async setRole({ username, role }) {
      const name = assertUsername(username)
      const updated = await map.merge(name, { role: role === 'admin' ? 'admin' : 'user', updatedAt: Date.now() })
      return updated ? toPublicUser(updated) : null
    },
  }
}
