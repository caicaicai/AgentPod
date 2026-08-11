/**
 * 访问平台后端（SpeedLoop）的统一出口。
 *
 * 与桌面端 `modules/ap/src/main/auth/auth-service.js` 的 buildPlatformHeaders() 保持一致，
 * 否则后端的登录态校验会以各种奇怪方式失败（跳登录页、返回 HTML）。
 */
import { Errors } from '../errors.js'

export function createPlatformClient({ config, logger }) {
  const base = config.platform.speedApiBase

  function buildHeaders(credential) {
    const headers = {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: config.platform.referer,
      Accept: 'application/json',
    }
    if (credential) headers.Cookie = credential
    return headers
  }

  /**
   * 返回 { ok, data, status, error }。
   * 三种"看起来不同其实都是没登录"的情况在这里统一识别，别让调用方对着 JSON 解析错误猜：
   *   1. 302 跳登录页
   *   2. 返回 HTML（登录页正文）
   *   3. 返回 JSON 但 success=false
   */
  async function getJson(pathname, { credential, timeoutMs = 15000 } = {}) {
    const url = `${base}${pathname}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(url, { headers: buildHeaders(credential), signal: controller.signal, redirect: 'manual' })

      if (res.status >= 300 && res.status < 400) {
        return { ok: false, status: res.status, error: `未登录：${pathname} 返回 ${res.status} 重定向到登录页`, unauthenticated: true }
      }

      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        const hint = text.slice(0, 80).replace(/\s+/g, ' ')
        return { ok: false, status: res.status, error: `${pathname} 返回的不是 JSON（HTTP ${res.status}）：${hint}…（多半是登录态失效被跳到登录页）`, unauthenticated: true }
      }

      if (!res.ok || data?.success === false) {
        const message = data?.message || data?.error || `${pathname} 请求失败`
        const unauthenticated = res.status === 401 || /登录|login|未授权|unauthor/i.test(message)
        return { ok: false, status: res.status, error: `${message}（HTTP ${res.status}）`, unauthenticated, data }
      }

      return { ok: true, status: res.status, data }
    } catch (error) {
      if (error?.name === 'AbortError') return { ok: false, error: `${pathname} 请求超时（${timeoutMs}ms）`, timeout: true }
      logger.warn('平台接口请求异常', { pathname, err: error?.message })
      return { ok: false, error: `${pathname} 请求异常：${error?.message || error}` }
    } finally {
      clearTimeout(timer)
    }
  }

  return { getJson, buildHeaders, base }
}

export function platformFailureToError(result) {
  if (result.unauthenticated) return Errors.unauthenticated(result.error)
  if (result.timeout) return Errors.timeout(result.error)
  return Errors.upstream(result.error)
}
