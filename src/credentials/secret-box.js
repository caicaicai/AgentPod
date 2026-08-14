/**
 * 入库前给一小段机密（目前只有模型的 API Key）加一层壳。
 *
 * ── 为什么是"可选加密"而不是"一律加密" ──────────────────────────────────
 *
 * 加密能挡住的是**拿到了库、但没拿到进程环境**的那个人：一份被拖走的备份、
 * 一个开着的只读从库、一次误发到群里的 dump。它挡不住拿到机器的人 ——
 * 密钥就在同一台机器的环境变量里。这个边界必须写清楚，否则"已加密"三个字
 * 会被当成比它实际强得多的保证。
 *
 * 而**强制**加密的代价是：LLM_CONFIG_SECRET 一旦丢了或者换了，库里所有模型
 * 配置一起变砖 —— 管理员看到的是一排"解不开"的模型，而这时候他多半正在
 * 处理另一件事故。cron 那个金库（src/cron/credentials.js）在同一个问题上
 * 选了明文 + 启动时 error 级别宣告一次，它的文件头写着"真要更强的保护，
 * 该做的是加密后再入库"。这里就是把那句话兑现掉，同时保留没配密钥也能跑。
 *
 * ── 存储格式 ────────────────────────────────────────────────────────────
 *
 *   明文    `plain:<原文>`
 *   加密    `gcm1:<iv base64>:<authTag base64>:<密文 base64>`
 *
 * 前缀是必须的：没有它就没法回答"库里这一串到底是原文还是密文"，
 * 而那正是"配上密钥之后老数据还读不读得出来"的分水岭。带上前缀之后：
 *   - 没配密钥时读到 gcm1: → 明确报"这条是加密的，请配回 LLM_CONFIG_SECRET"，
 *     而不是把密文当 key 发给上游，换回一个看不懂的 401；
 *   - 配了密钥时读到 plain: → 照常读出来，下次保存自动升级成密文。
 *
 * ⚠️ AES-256-GCM 而不是 CBC：GCM 自带完整性校验，库里的密文被改过一个字节
 * 就解不开（抛错），而 CBC 会安静地解出一段乱码再发给上游。
 */
import crypto from 'node:crypto'

const PLAIN_PREFIX = 'plain:'
const CIPHER_PREFIX = 'gcm1:'
const IV_BYTES = 12 // GCM 的标准长度

/**
 * 从任意长度的口令派生 32 字节密钥。
 *
 * 用 scrypt 而不是直接 sha256(passphrase)：口令多半是人手打的，
 * 强度有限，scrypt 的内存硬特性让"拿到密文再爆破口令"这条路贵得多。
 * 盐是固定串 —— 这里不是密码校验（不需要每条不同的盐），
 * 而是"同一个口令必须每次派生出同一把密钥"，否则重启就解不开自己写的东西。
 */
function deriveKey(passphrase) {
  return crypto.scryptSync(String(passphrase), 'agentpod/llm-config/v1', 32, {
    N: 16384, r: 8, p: 1, maxmem: 256 * 16384 * 8,
  })
}

/**
 * @param {string} passphrase LLM_CONFIG_SECRET；空串 = 不加密
 * @returns {{enabled: boolean, seal: (plain: string) => string, open: (stored: string) => string}}
 */
export function createSecretBox({ passphrase = '' } = {}) {
  const secret = String(passphrase || '').trim()
  // 密钥只派生一次：scrypt 一次约 50~100ms，每存一个模型都派生一遍是白扔的
  const key = secret ? deriveKey(secret) : null

  return {
    enabled: Boolean(key),

    /** 明文 → 可入库的字符串。空串原样返回（"没有配 key"是合法状态） */
    seal(plain) {
      const value = String(plain ?? '')
      if (!value) return ''
      if (!key) return `${PLAIN_PREFIX}${value}`
      const iv = crypto.randomBytes(IV_BYTES)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return [
        CIPHER_PREFIX.slice(0, -1),
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        encrypted.toString('base64'),
      ].join(':')
    },

    /**
     * 库里的字符串 → 明文。
     *
     * 解不开时**抛错**而不是返回空串：空串会一路走到上游，换回一句
     * "invalid api key"，然后所有人开始怀疑是模型服务挂了。
     */
    open(stored) {
      const value = String(stored ?? '')
      if (!value) return ''
      if (value.startsWith(PLAIN_PREFIX)) return value.slice(PLAIN_PREFIX.length)
      if (!value.startsWith(CIPHER_PREFIX)) {
        // 没有前缀 = 这一行是在加壳这套东西之前写进去的，按明文读
        return value
      }
      if (!key) {
        throw new Error('这条模型配置的 Key 是加密存储的，但本进程没有配置 LLM_CONFIG_SECRET')
      }
      const [, ivB64, tagB64, dataB64] = value.split(':')
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
        return Buffer.concat([
          decipher.update(Buffer.from(dataB64, 'base64')),
          decipher.final(),
        ]).toString('utf8')
      } catch {
        // GCM 校验没过：要么换过 LLM_CONFIG_SECRET，要么有人手工改过这一行
        throw new Error('模型 Key 解密失败：LLM_CONFIG_SECRET 与写入时不一致，或这条记录被改动过')
      }
    },
  }
}

/**
 * 给界面看的掩码。**永远不要把明文 key 下发给浏览器** ——
 * 管理员在界面上要回答的问题只有"这条配没配 key、是不是我以为的那一把"，
 * 前四位加后四位足够回答，而完整的 key 一旦渲染出来就会进浏览器缓存、
 * 进截图、进录屏。
 */
export function maskKey(plain) {
  const value = String(plain ?? '')
  if (!value) return ''
  if (value.length <= 8) return '•'.repeat(value.length)
  return `${value.slice(0, 4)}${'•'.repeat(6)}${value.slice(-4)}`
}
