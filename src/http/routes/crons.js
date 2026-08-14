/**
 * 定时任务的路由：建、查、改、删、立刻跑一次，以及凭据金库那几个开关。

 * 与 ./routes/accounts.js 同一个契约：回 true 表示这条请求我接了。
 */
import { Errors } from '../../errors.js'

export function createCronRoutes({ crons, scheduler, cronVault, config }) {
  return async function handle({ req, res, url, reqLogger, subject, sendJson, readJsonBody }) {

  if (url.pathname === '/v1/crons' || url.pathname.startsWith('/v1/crons/')) {
    if (!crons?.enabled) throw Errors.notFound('本部署未启用定时任务（CRON_ENABLED=0）')

    /**
     * 每次写操作都刷新一次留存的登录态。
     *
     * 时机是有讲究的：用户此刻**正在浏览器里**（我们确实拿着他的登录态），而且
     * 刚刚表达了"我要这个任务在我不在的时候跑"的意图。放在别处（比如每个请求都刷）
     * 会让"到底存了谁的凭据、什么时候存的"变成一件说不清的事。
     * CRON_CREDENTIAL_MODE=none 时这里是个空操作。
     */
    const rememberCredential = () => cronVault?.remember({ username: subject.username, credential: subject.credential || '' })
      .catch((error) => reqLogger.warn('定时任务凭据留存失败', { err: error?.message }))

    if (req.method === 'GET' && url.pathname === '/v1/crons') {
      return sendJson(res, 200, {
        crons: await crons.list({ username: subject.username, includeArchived: url.searchParams.get('includeArchived') === '1' }),
        scheduler: { running: Boolean(scheduler?.enabled), credentialMode: config.cron.credentialMode },
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/crons') {
      const body = await readJsonBody(req, config.limits.bodyLimitBytes)
      try {
        const cron = await crons.create({
          username: subject.username,
          title: body.title,
          task: body.task,
          schedule: body.schedule,
          sessionMode: body.sessionMode,
          projectId: body.projectId,
          enabled: body.enabled,
        })
        await rememberCredential()
        return sendJson(res, 201, { ok: true, cron })
      } catch (error) {
        throw Errors.badRequest(error.message)
      }
    }

    const rest = decodeURIComponent(url.pathname.slice('/v1/crons/'.length) || '')
    const isRun = rest.endsWith('/run')
    const cronId = isRun ? rest.slice(0, -'/run'.length) : rest
    if (cronId.includes('/')) throw Errors.notFound('没有这个接口')

    // 立即执行一次。不占排期格，也不影响 nextFireAt —— 它是"试一下对不对"，
    // 不是"提前触发这一拍"
    if (req.method === 'POST' && isRun) {
      if (!scheduler) throw Errors.notFound('本副本没有调度能力')
      await rememberCredential()
      const outcome = await scheduler.runNow({ username: subject.username, id: cronId })
      return sendJson(res, 200, { ok: outcome.ok, status: outcome.status || 'ok' })
    }

    if (req.method === 'GET') {
      const cron = await crons.get({ username: subject.username, id: cronId })
      if (!cron) throw Errors.notFound('定时任务不存在')
      return sendJson(res, 200, { cron })
    }

    if (req.method === 'PATCH') {
      const body = await readJsonBody(req, config.limits.bodyLimitBytes)
      try {
        const cron = await crons.update({
          username: subject.username,
          id: cronId,
          title: body.title,
          task: body.task,
          schedule: body.schedule,
          sessionMode: body.sessionMode,
          projectId: body.projectId,
          enabled: body.enabled,
          archived: body.archived,
        })
        if (!cron) throw Errors.notFound('定时任务不存在')
        await rememberCredential()
        return sendJson(res, 200, { ok: true, cron })
      } catch (error) {
        if (error.status) throw error
        throw Errors.badRequest(error.message)
      }
    }

    if (req.method === 'DELETE') {
      await crons.remove({ username: subject.username, id: cronId })
      // 最后一条任务被删掉之后，留着的登录态就没有任何用途了 —— 顺手清掉，
      // 别让它在盘上一直躺到过期
      const left = await crons.list({ username: subject.username, includeArchived: true })
      if (!left.length) await cronVault?.forget({ username: subject.username }).catch(() => {})
      return sendJson(res, 200, { ok: true })
    }
  }
    // 不是这一块的路径，交给下一段
    return false
  }
}
