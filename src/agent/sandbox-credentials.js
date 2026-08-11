/**
 * 往沙盒里注入 ME_TOKEN —— **这是隔离契约上一道显式开的口子**。
 *
 * ── 为什么会有这个文件 ────────────────────────────────────────────────
 *
 * 一批技能是这么写的：
 *
 *     me_token = os.environ["ME_TOKEN"]
 *     requests.post(gateway, headers={"cookie": f"me_token={me_token}"})
 *
 * 为了让这些技能零改动跑起来，选择**按桌面端的样子把 ME_TOKEN 喂进沙盒**。
 *
 * ── 这道口子有多大，必须说清楚 ────────────────────────────────────────
 *
 * 沙盒里跑的是模型现写的代码，而模型的输入（邮件正文、网页、工坊里别人发布的
 * 技能）全是不可信输入。ME_TOKEN 一旦进了沙盒环境变量：
 *
 *   * 模型可以 `echo $ME_TOKEN` 把它写进回答；
 *   * 可以写进工作区文件，而工作区会同步到共享存储；
 *   * 一封诱导邮件就足以触发上面两件事（prompt injection）。
 *
 * 所以这里的每一条限制都是有意的，别顺手放宽：
 *
 *   1. **只抽 me_token 一个 cookie**，不是整串。整串里还有其他凭据，
 *      技能不需要它们，就不该看见。
 *   2. **默认关闭**（SANDBOX_INJECT_ME_TOKEN）。开这道口子是部署决定，
 *      不是代码默认值。
 *   3. **一次 run 一份**。沙盒是 per-run 的，env 不会串到别的用户 ——
 *      这是它与桌面端 `process.env.ME_TOKEN` 那种进程级全局的关键区别。
 *   4. **绝不进日志**。调用方只能拿到长度和指纹（见 logger.js 的铁律）。
 *
 */

/**
 * 从整串 Cookie 里取出指定名称的值。
 *
 * 按 `;` 切开逐段比对，不在整串上搜正则。
 *
 * @param {string} cookieStr 完整 Cookie 字符串
 * @param {string} name      Cookie 名称
 * @returns {string} Cookie 值；没有则空串
 */
function extractCookieValue(cookieStr, name) {
  if (!cookieStr || !name) return ''
  const prefix = `${name}=`
  for (const segment of cookieStr.split(';')) {
    const trimmed = segment.trim()
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length)
  }
  return ''
}

/**
 * 从整串 Cookie 里取出 `me_token`。
 *
 * @param {string} credential 用户登录态（整串 Cookie）
 * @returns {string} me_token 的值；没有则空串
 */
export function extractMeToken(credential) {
  return extractCookieValue(credential, 'me_token')
}

/**
 * 这一次 run 要注入沙盒的凭据类环境变量。
 *
 * 关掉开关、或者这个用户的 Cookie 里本来就没有 me_token 时，返回空对象 ——
 * **不要注入一个空的 ME_TOKEN**。空值会让技能里 `if me_token:` 那种判断
 * 走进"没注入"的分支，行为与不设是一样的；但一个存在却为空的环境变量
 * 会让排查的人以为注入生效了，方向就歪了。
 *
 * @returns {{ME_TOKEN?: string}}
 */
export function buildSandboxCredentialEnv({ credential = '', injectMeToken = false } = {}) {
  if (!injectMeToken) return {}
  const meToken = extractMeToken(credential)
  if (!meToken) return {}
  return { ME_TOKEN: meToken }
}
