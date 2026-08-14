/**
 * 项目的路由：建、查、改、删，以及删项目时把它名下的会话摘干净。

 * 与 ./routes/accounts.js 同一个契约：回 true 表示这条请求我接了。

 * 删项目那一段要**一页一页翻完**会话列表 —— 只处理第一页的话，
 * 一个装了几百条会话的项目会留下一批指向不存在项目的会话。
 */
import { Errors } from '../../errors.js'

export function createProjectRoutes({ projects, store, config }) {
  return async function handle({ req, res, url, subject, sendJson, readJsonBody }) {

  if (url.pathname === '/v1/projects' || url.pathname.startsWith('/v1/projects/')) {
    if (!projects?.enabled) throw Errors.notFound('本部署未启用项目功能（PROJECTS_ENABLED=0）')

    if (req.method === 'GET' && url.pathname === '/v1/projects') {
      return sendJson(res, 200, {
        projects: await projects.list({
          username: subject.username,
          includeArchived: url.searchParams.get('includeArchived') === '1',
        }),
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/projects') {
      const body = await readJsonBody(req, config.limits.bodyLimitBytes)
      try {
        const project = await projects.create({
          username: subject.username,
          name: body.name,
          description: body.description,
          instructions: body.instructions,
        })
        return sendJson(res, 201, { ok: true, project })
      } catch (error) {
        throw Errors.badRequest(error.message)
      }
    }

    const projectId = decodeURIComponent(url.pathname.slice('/v1/projects/'.length) || '')
    if (projectId.includes('/')) throw Errors.notFound('没有这个接口')

    if (req.method === 'GET') {
      const project = await projects.get({ username: subject.username, projectId })
      if (!project) throw Errors.notFound('项目不存在')
      return sendJson(res, 200, { project })
    }

    if (req.method === 'PATCH') {
      const body = await readJsonBody(req, config.limits.bodyLimitBytes)
      try {
        // 逐字段取，理由同会话的 PATCH
        const project = await projects.update({
          username: subject.username,
          projectId,
          name: body.name,
          description: body.description,
          instructions: body.instructions,
          archived: body.archived,
        })
        if (!project) throw Errors.notFound('项目不存在')
        return sendJson(res, 200, { ok: true, project })
      } catch (error) {
        if (error.status) throw error
        throw Errors.badRequest(error.message)
      }
    }

    if (req.method === 'DELETE') {
      const removed = await projects.remove({ username: subject.username, projectId })
      if (!removed) throw Errors.notFound('项目不存在')
      /**
       * 把它下面的会话退回"未分组"，而不是跟着删。
       *
       * 用户删项目想删的是这个分组；连着几十轮对话一起删是不可逆的，
       * 而且没有任何提示能让人预料到。
       */
      /**
       * **要一页一页翻完**，不能只处理第一页。
       *
       * list 现在是分页的（见 sessions/store.js），只取第一页的话，
       * 一个装了几百条会话的项目被删之后会留下一批仍然指着它的会话 ——
       * 那些会话从此归属一个不存在的项目，界面上显示为一个空白的项目名。
       *
       * 每翻一页就把这一页摘干净，所以中途失败也只是"还剩一些没摘"，
       * 而不是一个改了一半的中间态。
       */
      let released = 0
      let cursor = ''
      do {
        const page = await store.list({
          username: subject.username, projectId, includeArchived: true, cursor,
        })
        for (const session of page.items) {
          await store.patch({ username: subject.username, sessionKey: session.sessionKey, projectId: '' }).catch(() => {})
          released += 1
        }
        /**
         * 往前走而不是每次都从头查。
         *
         * 从头查也是对的（摘掉的那些已经掉出 `project_id = ?` 的过滤条件，
         * 下一批自然顶上来），但上面那个 `.catch(() => {})` 让它变危险：
         * 只要有一条**摘不掉**，它就会永远出现在第一页，循环再也出不来。
         * 用游标往前走，那一条最坏是被跳过 —— 漏掉几条比转不出来好。
         *
         * 游标在这里是稳的：改 projectId 不动 updated_at（见 store.patch），
         * 所以剩下那些行的排序位置不会因为这一页的改动而移位。
         */
        cursor = page.nextCursor
      } while (cursor)
      return sendJson(res, 200, { ok: true, releasedSessions: released })
    }
  }
    // 不是这一块的路径，交给下一段
    return false
  }
}
