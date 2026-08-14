/**
 * 错误分类。目的：调用方（页面 / 定时任务 / 京ME 通道）能据此决定"重试、让用户重新授权、还是直接失败"。
 * PoC 阶段所有失败都是一句字符串，排查全靠猜 —— 正式项目不能这样。
 */
export class AppError extends Error {
  constructor(message, { code = 'INTERNAL', status = 500, retryable = false, cause, details } = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
    this.retryable = retryable
    this.details = details
    if (cause) this.cause = cause
  }

  toJSON() {
    return { error: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) }
  }
}

export const Errors = {
  /** 没登录态 / 登录态过期 —— 调用方应引导用户重新授权 */
  unauthenticated: (message, details) => new AppError(message, { code: 'UNAUTHENTICATED', status: 401, details }),
  /** 身份合法但没权限 */
  forbidden: (message, details) => new AppError(message, { code: 'FORBIDDEN', status: 403, details }),
  badRequest: (message, details) => new AppError(message, { code: 'BAD_REQUEST', status: 400, details }),
  notFound: (message, details) => new AppError(message, { code: 'NOT_FOUND', status: 404, details }),
  /**
   * 乐观锁撞车：读到之后、写回之前，有别人改过了。
   * 与 400 分开是因为调用方的处理方式完全不同 —— 这个要"重新加载再改"，不是"参数写错了"。
   */
  conflict: (message, details) => new AppError(message, { code: 'CONFLICT', status: 409, details }),
  /** 并发预算打满 —— 可重试 */
  busy: (message, details) => new AppError(message, { code: 'BUSY', status: 429, retryable: true, details }),
  /**
   * 被限流挡下。与 busy 同为 429 但**分开一个 code**：busy 是"服务器这会儿忙，
   * 马上重试就行"，这个是"你请求得太频繁，再打还会更久" —— 界面要说的话
   * 和调用方该做的退避完全不同。details.retryAfterMs 告诉对方等多久。
   */
  rateLimited: (message, details) => new AppError(message, { code: 'RATE_LIMITED', status: 429, retryable: true, details }),
  /** 上游（平台后端 / 模型网关 / 沙盒）故障 —— 可重试 */
  upstream: (message, details) => new AppError(message, { code: 'UPSTREAM', status: 502, retryable: true, details }),
  timeout: (message, details) => new AppError(message, { code: 'TIMEOUT', status: 504, retryable: true, details }),
  internal: (message, details) => new AppError(message, { code: 'INTERNAL', status: 500, details }),
}

export function toAppError(error) {
  if (error instanceof AppError) return error
  if (error?.name === 'AbortError') return Errors.timeout(error.message || '请求被中止')
  /**
   * 自带 status 的领域错误（如 SkillManagerError）按它说的报。
   *
   * 不认的话，"技能不存在"会变成 500 —— 客户端据此重试、日志里堆一片 error 级，
   * 而它其实是个再正常不过的 404。只认 4xx/5xx 区间的整数，免得一个脏字段
   * 把 status 变成 undefined 让 res.writeHead 抛错。
   */
  const status = Number(error?.status)
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return new AppError(error?.message || String(error), { code: error?.name || 'ERROR', status, cause: error })
  }
  return new AppError(error?.message || String(error), { code: 'INTERNAL', status: 500, cause: error })
}
