/**
 * 定时任务的凭据来源。
 *
 * ── 问题 ────────────────────────────────────────────────────────────────
 *
 * 现在的凭据模型是**透传**：用调用方带来的登录态去换模型访问权（见
 * docs/ARCHITECTURE.md §4）。这条路有个天花板 —— **只在人坐在浏览器前面时成立**。
 * 凌晨三点触发的定时任务没有浏览器，也就没有登录态，于是根本跑不起来。
 *
 * 正解是服务端代持（tokenGrant / refreshToken 续期），那要平台侧先支持。
 * 在那之前，这里给出两种模式，默认是安全的那种：
 *
 *   none    （默认）不存任何凭据。定时任务只能在不需要用户凭据的部署下跑
 *           （LLM_MODE=faux/direct）。其余情况触发时记一条 needs_credential，
 *           界面上告诉用户"定时任务需要开启凭据留存"。
 *
 *   stored  用户在浏览器里创建/修改定时任务时，把**那一刻**的登录态快照存进
 *           数据库（ap_doc，kind='cron-credential'）。触发时取出来用。
 *
 * ── stored 模式是一道明确的口子，不是疏忽 ───────────────────────────────
 *
 * 它把一份长期有效的登录态**明文**存了下来，性质与 SANDBOX_INJECT_ME_TOKEN 同级：
 *   - 拿到库就等于拿到这些人的登录态；
 *   - 凭据的有效期不再由"浏览器关掉"决定，而是由 cookie 自己的过期时间决定。
 * 所以它默认关闭，且启动时用 error 级别宣告一次。
 *
 * ⚠️ 防护手段变过一次，值得说清楚：从前它是本地磁盘上的 0600 文件，靠**文件权限**
 * 挡住同机器的其他用户；现在它是数据库里的一行，挡它的是**数据库的访问控制**
 * （谁拿得到 MYSQL_USER/MYSQL_PASSWORD，谁就读得到）。换过来是因为本服务的
 * 结构化数据只存库了 —— 留着唯一一个写本地盘的状态，多副本下它又会变成
 * "只在存过凭据的那台机器上，定时任务才跑得起来"。
 * 真要更强的保护，该做的是**加密后再入库**（密钥来自 KMS/环境），
 * 而不是退回文件权限。
 *
 * 登录态过期之后，触发会失败并记成 `needs_reauth` —— 用户下次打开界面就能看到
 * "定时任务已暂停，请重新登录"，而不是任务默默地再也不响。
 */
import { requireStorage } from '../persistence/storage.js'

/** ap_doc 里的 kind。与长期记忆同一张表、不同 kind —— 两者都是"按用户存一整段文本" */
const DOC_KIND = 'cron-credential'

/**
 * 留存的最长时间。
 *
 * 不是安全边界（凭据本身有自己的过期时间），是**清理策略**：一个人半年不用了，
 * 他的登录态不该还躺在盘上。到期后触发会失败并提示重新登录，与 cookie 过期同一条路径。
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function createCronCredentialVault({ config, storage, logger = console }) {
  const mode = config.cron?.credentialMode || 'none'
  // 关着的时候不碰存储 —— 默认部署下这个金库根本不该有任何读写
  if (mode === 'stored') requireStorage(storage, 'createCronCredentialVault(stored)')

  const scopeFor = (username) => ({ username, scope: '', kind: DOC_KIND })

  return {
    mode,
    enabled: mode === 'stored',

    /**
     * 记下这个用户此刻的登录态。
     *
     * 由 HTTP 层在"用户创建/修改定时任务"时调用 —— 那一刻我们确实拿着他的登录态，
     * 而且他刚刚表达了"我要这个任务在我不在的时候跑"的意图。刻意不在每次请求都刷新：
     * 那会让"存了谁的凭据"变成一件说不清的事。
     */
    async remember({ username, credential }) {
      if (mode !== 'stored' || !username || !credential) return false
      await storage.docs.write(scopeFor(username), JSON.stringify({ credential, savedAt: Date.now() }))
      logger.info?.('已留存定时任务凭据', { username })
      return true
    },

    /** 取出来用。过期或没有就回空串 —— 调用方据此记 needs_reauth */
    async resolve({ username }) {
      if (mode !== 'stored' || !username) return ''
      const raw = await storage.docs.read(scopeFor(username))
      if (!raw) return ''
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return ''
      }
      if (!parsed?.credential) return ''
      if (Date.now() - (parsed.savedAt || 0) > MAX_AGE_MS) {
        logger.info?.('定时任务凭据已超过留存期，按未登录处理', { username })
        return ''
      }
      return parsed.credential
    },

    /** 用户删光了自己的定时任务，或显式要求清除 */
    async forget({ username }) {
      if (!username || mode !== 'stored') return false
      await storage.docs.remove(scopeFor(username))
      return true
    },
  }
}
