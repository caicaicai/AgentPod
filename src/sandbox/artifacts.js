/**
 * 向 sandbox-manager 换取沙盒产物的直传地址。
 *
 * ── 为什么禁重定向 ──────────────────────────────────────────────────
 *
 * 请求带着 `X-API-SecurityCode`。`fetch` 默认会跟重定向，而自定义请求头**不会**
 * 像 Authorization 那样在跨源跳转时被剥掉 —— 管理端（或冒充它的东西）回一个 302，
 * 这枚长期令牌就跟着发到别的主机去了。宁可让它明确失败：
 * 管理端是内网固定地址，正常情况下不该有跳转。
 */
import { Errors } from '../errors.js'

export async function requestArtifactUploadUrl({ config, logger, username, runId, fileName, sizeBytes }) {
  const { managerUrl, managerCode } = config.sandbox

  let res
  try {
    res = await fetch(`${managerUrl}/api/v1/sandbox/artifacts/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-SecurityCode': managerCode },
      body: JSON.stringify({ username, runId, fileName, sizeBytes: sizeBytes || undefined }),
      redirect: 'error', // ← 见文件头：别把安全令牌跟着跳转发出去
      signal: AbortSignal.timeout(10000),
    })
  } catch (error) {
    logger.warn('向管理端换取产物地址失败', { runId, err: error?.message })
    // 明确标成"连不上"：与"管理端拒绝"是两种完全不同的处置
    // （前者等一等可能就好了，后者要去改配置）。
    const unreachable = Errors.upstream('连不上管理端，产物上传暂不可用')
    unreachable.code = 'manager-unreachable'
    unreachable.status = 502
    throw unreachable
  }

  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    // 管理端已经区分了"没配"501 / "太大"413，原样透出去 ——
    // 笼统包一层会让沙盒里的人看不出到底该改什么。
    const error = Errors.upstream(body.message || '管理端拒绝签发产物地址')
    error.status = res.status
    error.code = body.error || 'presign-failed'
    throw error
  }
  return body
}
