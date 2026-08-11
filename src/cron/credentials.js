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
 *   stored  用户在浏览器里创建/修改定时任务时，把**那一刻**的登录态快照存到
 *           他自己的数据目录（0600）。触发时取出来用。
 *
 * ── stored 模式是一道明确的口子，不是疏忽 ───────────────────────────────
 *
 * 它把一份长期有效的登录态写到了磁盘上，性质与 SANDBOX_INJECT_ME_TOKEN 同级：
 *   - 拿到盘就等于拿到这些人的登录态；
 *   - 凭据的有效期不再由"浏览器关掉"决定，而是由 cookie 自己的过期时间决定。
 * 所以它默认关闭、启动时用 error 级别宣告一次，且文件权限收到 0600。
 *
 * 登录态过期之后，触发会失败并记成 `needs_reauth` —— 用户下次打开界面就能看到
 * "定时任务已暂停，请重新登录"，而不是任务默默地再也不响。
 */
import { readFile, writeFile, rm, chmod, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { safeJoin, userRoot } from '../persistence/paths.js'

const FILE = 'cron-credential.json'

/**
 * 留存的最长时间。
 *
 * 不是安全边界（凭据本身有自己的过期时间），是**清理策略**：一个人半年不用了，
 * 他的登录态不该还躺在盘上。到期后触发会失败并提示重新登录，与 cookie 过期同一条路径。
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function createCronCredentialVault({ config, logger = console }) {
  const mode = config.cron?.credentialMode || 'none'
  const dataDir = config.dataDir

  function fileFor(username) {
    return safeJoin(userRoot(dataDir, username), FILE)
  }

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
      const file = fileFor(username)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify({ credential, savedAt: Date.now() }), { mode: 0o600 })
      // 已存在的文件 writeFile 不会改权限，显式收一次
      await chmod(file, 0o600).catch(() => {})
      logger.info?.('已留存定时任务凭据', { username })
      return true
    },

    /** 取出来用。过期或没有就回空串 —— 调用方据此记 needs_reauth */
    async resolve({ username }) {
      if (mode !== 'stored' || !username) return ''
      let raw
      try {
        raw = await readFile(fileFor(username), 'utf8')
      } catch (error) {
        if (error.code === 'ENOENT') return ''
        throw error
      }
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
      if (!username) return false
      await rm(fileFor(username), { force: true })
      return true
    },
  }
}
