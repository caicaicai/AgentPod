/**
 * 作品的路由：清单、详情、某一版的原文、删除，以及分享链接的开关。

 * 与 ./routes/accounts.js 同一个契约：回 true 表示这条请求我接了，
 * 回 false 表示交给下一段。

 * 下发文件一律走 `sendArtifactFile`（见 ./artifact-io.js）——
 * 那里守着"本服务从不以 HTML 的身份吐出模型生成的内容"这条不变量，
 * 分享那条路用的是同一个函数。
 */
import { Errors } from '../../errors.js'
import { sendArtifactFile } from './artifact-io.js'

export function createArtifactRoutes({ artifacts, shares, config }) {
  return async function handle({ req, res, url, reqLogger, subject, sendJson, readJsonBody, readArtifactOr404 }) {

  if (url.pathname === '/v1/artifacts' || url.pathname.startsWith('/v1/artifacts/')) {
    if (!artifacts?.enabled) throw Errors.notFound('本部署未启用作品功能（ARTIFACTS_ENABLED=0）')

    if (req.method === 'GET' && url.pathname === '/v1/artifacts') {
      return sendJson(res, 200, {
        artifacts: await artifacts.list({
          username: subject.username,
          // 不传 sessionKey = 这个人的全部作品。界面默认只看当前会话的，
          // 但"我上周做的那个报表在哪"要有地方能翻
          sessionKey: url.searchParams.get('sessionKey') || '',
        }),
        /**
         * 预览环境的约束一并回给前端。
         *
         * 它得拿这个拼预览 iframe 的 CSP —— 前端自己硬编一份的话，改了服务端
         * 配置而前端没跟上，表现是"配了 CDN 却还是加载不到"，两边谁也看不出来。
         */
        preview: { allowedOrigins: config.artifacts.allowedOrigins },
      })
    }

    const rest = decodeURIComponent(url.pathname.slice('/v1/artifacts/'.length) || '')
    const isRaw = rest.endsWith('/raw')
    const isShare = rest.endsWith('/share')
    const artifactId = isRaw ? rest.slice(0, -'/raw'.length)
      : isShare ? rest.slice(0, -'/share'.length)
        : rest
    if (!artifactId || artifactId.includes('/')) throw Errors.notFound('没有这个接口')

    /**
     * ── 作者侧的分享开关 ──
     *
     * 三个动词分得很开，因为它们是三件不同的事：
     *   POST   生成分享链接（幂等，已有就回已有的 —— 见 shares.create）
     *   PATCH  上/下市场、改简介
     *   DELETE 撤销，链接立刻失效
     *
     * 注意 **username 一律取自 subject**，请求体里那个（如果有）看都不看。
     * 反面教材见下面 PATCH /v1/sessions 那段：`{...body}` 把登录态解析出来的
     * username 覆盖掉，于是"改自己的东西"变成了"改任何人的东西"。
     */
    if (isShare) {
      if (!shares?.enabled) throw Errors.notFound('本部署未启用作品分享（ARTIFACT_SHARING_ENABLED=0）')

      if (req.method === 'POST') {
        const meta = await shares.create({ username: subject.username, artifactId })
        if (!meta) throw Errors.notFound('作品不存在')
        reqLogger.info('生成作品分享链接', { username: subject.username, id: artifactId })
        return sendJson(res, 200, { ok: true, artifact: meta })
      }

      if (req.method === 'PATCH') {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        let meta
        try {
          meta = await shares.setMarket({
            username: subject.username,
            artifactId,
            market: body.market,
            summary: body.summary,
          })
        } catch (error) {
          throw Errors.badRequest(error.message)
        }
        if (!meta) throw Errors.notFound('作品不存在')
        return sendJson(res, 200, { ok: true, artifact: meta })
      }

      if (req.method === 'DELETE') {
        const revoked = await shares.revoke({ username: subject.username, artifactId })
        if (!revoked) throw Errors.notFound('这份作品没有在分享')
        reqLogger.info('撤销作品分享', { username: subject.username, id: artifactId })
        return sendJson(res, 200, { ok: true })
      }

      throw Errors.notFound('没有这个接口')
    }

    /** 单个文件的原文。`?path=` 指定哪一个，不传取入口文件。头的讲究见 sendArtifactFile */
    if (req.method === 'GET' && isRaw) {
      return sendArtifactFile(res, {
        current: await readArtifactOr404({
          username: subject.username, id: artifactId, version: url.searchParams.get('v'),
        }),
        wanted: url.searchParams.get('path'),
        download: url.searchParams.get('download') === '1',
      })
    }

    if (req.method === 'GET') {
      const current = await readArtifactOr404({
        username: subject.username, id: artifactId, version: url.searchParams.get('v'),
      })
      return sendJson(res, 200, current)
    }

    if (req.method === 'DELETE') {
      // 分享指针在**删之前**清掉 —— 删完就查不到 share.token 了。
      // 漏了也不会漏数据（公开读那一关会核对作品还在不在），只是盘上多一个孤儿
      await shares?.revokeForArtifact?.({ username: subject.username, artifactId }).catch((error) => {
        reqLogger.warn('作品分享指针清理失败', { id: artifactId, err: error?.message })
      })
      const removed = await artifacts.remove({ username: subject.username, id: artifactId })
      if (!removed) throw Errors.notFound('作品不存在')
      return sendJson(res, 200, { ok: true })
    }
  }
    // 不是这一块的路径，交给下一段
    return false
  }
}
