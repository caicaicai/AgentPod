/**
 * 账号与管理台的路由：改自己的密码，以及 `/v1/admin/*` 那一整块
 * （管人、管分组、管模型、看用量）。
 *
 * ── 为什么把它从 server.js 里搬出来 ────────────────────────────────────
 *
 * 它是那个文件里最大的一块（三百多行），而且**与其余路由没有任何共享逻辑** ——
 * 剩下那些回答的是"这个用户的会话、作品、记忆"，这一块回答的是"所有用户"。
 * 混在一起的结果是：改一行用量统计的口径，diff 落在一个一千七百行、
 * 每条路由都要从头读起才敢动的文件上。
 *
 * ── 调用契约 ────────────────────────────────────────────────────────────
 *
 * 回 `true` = 这条请求我接了（响应已经写出去，或者已经抛了 AppError）；
 * 回 `false` = 不是我的，交给下一段。
 *
 * ⚠️ **必须在鉴权之后调用**：这里每一条都要 `subject`，而且 `/v1/admin/*`
 * 还要再判一次管理员。次序错了不会报错，只会变成一组不要求身份的管理接口。
 */
import { AppError, Errors } from '../../errors.js'
import { signToken } from '../../identity/password-auth.js'
import { normalizeLimit } from '../../persistence/page.js'
import { assertSegment } from '../../persistence/paths.js'
import { DEFAULT_TIMEZONE } from '../../telemetry/quota.js'

/**
 * @param {object} deps createServer 注入进来的那些
 * @returns {(ctx) => Promise<boolean>} ctx 带 req / res / url / reqLogger / subject
 *   以及 server.js 里那两个响应辅助函数
 */
export function createAccountRoutes({ config, identity, users, groups, modelStore, usage }) {
  /**
   * 用量接口要用的价目表 + 币种，查一次拼成参数。
   *
   * **一条都没定价时整个不传** —— usage-store 收不到 `prices` 就完全按从前的形状回，
   * 界面据此一列金额都不画。这比回一堆 `cost: null` 好：那样界面得先扫一遍
   * 才知道"到底是没定价，还是这些人真没花钱"。
   *
   * 没有 modelStore（LLM_MODE 不是 db、或者部署压根没启用它）时同理 ——
   * 那种部署的价住在平台侧，我们这边无从得知，就不该在页面上留一列空着的金额。
   */
  async function pricingArgs() {
    if (!modelStore?.prices) return {}
    const prices = await modelStore.prices()
    if (!prices.size) return {}
    return { prices, currency: config.limits?.usageCurrency || 'USD' }
  }

  return async function handleAccountRoutes({ req, res, url, reqLogger, subject, sendJson, readJsonBody }) {
  /* ─────────────── 账号（改密 / 管理）─────────────── */

  /**
   * `/v1/admin/` 整个前缀都收在这一块里（管人、看用量）。
   *
   * 前缀匹配在这儿是安全的，而在鉴权**之前**那块 auth 路由里不行 ——
   * 区别在于：那边前缀一宽就会把需要登录的路由当成匿名的未知接口吃掉（真发生过，
   * 见下面 /v1/auth/password 那段的注释）；这边前缀一宽只会让新的 /v1/admin/*
   * 自动继承"必须是管理员"这条判定，而那正是我们要的默认值。
   */
  if (url.pathname === '/v1/auth/password' || url.pathname.startsWith('/v1/admin/')) {
    if (!users) throw Errors.notFound('本部署未启用账号存储（AUTH_MODE 不是 password）')

    /**
     * 改自己的密码。**必须带旧密码**。
     *
     * 令牌可能是从别人电脑上、从一次共享屏幕里拿到的；只凭令牌就能改密，
     * 等于把"临时借用"直接变成"永久接管"，而真正的主人连登录都做不到了。
     */
    if (req.method === 'POST' && url.pathname === '/v1/auth/password') {
      const body = await readJsonBody(req, config.limits.bodyLimitBytes)
      try {
        const result = await users.changePassword({
          username: subject.username,
          oldPassword: body.oldPassword,
          newPassword: body.newPassword,
        })
        if (!result.ok) throw Errors.badRequest(result.error || '改密失败')

        /**
         * 改密会把 tokenVersion 推一格（见 user-store.setPassword），于是
         * **所有已签发的令牌当场作废** —— 包括发起这次请求的这一张。
         * 本副本上的缓存要立刻踢掉，否则最长还有一个 TTL 的窗口。
         */
        identity.invalidateUser?.(subject.username)

        /**
         * 给当前这条会话换一张新令牌。
         *
         * 不换的话，一个人改完自己的密码就会被自己踢下线 —— 而他刚刚证明过
         * 自己知道旧密码，是这台设备上最不该被怀疑的那个人。要作废的是
         * **别处**那些令牌，不是眼前这一张。
         */
        const version = (await users.authState(subject.username))?.tokenVersion || 0
        const ttl = config.auth.password.sessionTtlHours * 3600
        const fresh = signToken(subject.username, identity.passwordSecret, ttl, version)

        reqLogger.info('用户改密成功，其余会话已失效', { username: subject.username })
        return sendJson(res, 200, {
          ok: true,
          // 这个字段从前一直是 false（那时确实收不回来）。现在是真的了 ——
          // 前端据它提示"其他设备上的登录已退出"
          tokensRevoked: true,
          token: fresh.token,
          expiresAt: fresh.expiresAt,
        })
      } catch (error) {
        if (error instanceof AppError) throw error
        throw Errors.badRequest(error.message)
      }
    }

    /* ── 以下要管理员 ── */
    const me = await users.get(subject.username)
    if (me?.role !== 'admin') throw Errors.forbidden('需要管理员权限')

    /**
     * 账号清单，**分页**。
     *
     *   limit   一页几条（默认 50，上限 200）
     *   cursor  上一页回的 nextCursor（就是那一页最后一个用户名）
     *   q       用户名的子串筛选。**服务端做** —— 从前是前端在已加载的清单上
     *           filter，那在分页之后等于"只搜当前这一页"，而搜不到的人
     *           看起来就像不存在。
     *
     * `stats` 是两个整数，跟着每一页回：
     *
     *   total   这个部署一共几个账号。表头那句"N 个账号"用它 ——
     *           从前是数组长度，分页之后那个数会变成"当前加载了几条"。
     *   admins  在岗管理员数。界面靠它判断"这是不是最后一个管理员"
     *           （最后一个不能降级也不能禁用）。**这个必须是全局的**：
     *           从已加载的那一页去数，翻到第二页就会告诉你只剩一个了，
     *           而实际上第一页里还有三个 —— 现象是几个本该能点的按钮
     *           无缘无故变灰。
     */
    if (req.method === 'GET' && url.pathname === '/v1/admin/users') {
      const [found, stats] = await Promise.all([
        users.page({
          cursor: url.searchParams.get('cursor') || '',
          limit: normalizeLimit(url.searchParams.get('limit')),
          search: url.searchParams.get('q') || '',
        }),
        users.stats(),
      ])
      return sendJson(res, 200, {
        users: found.items,
        hasMore: found.hasMore,
        nextCursor: found.nextCursor,
        stats,
        /** 带着搜索词回：界面据它判断"这一页是搜出来的还是全部" */
        query: (url.searchParams.get('q') || '').trim(),
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/admin/users') {
      const body = await readJsonBody(req, config.limits.bodyLimitBytes)
      try {
        // groupId 不传 = 进默认分组（user-store 去查）；传空串 = 明确不进任何分组
        if (typeof body.groupId === 'string' && body.groupId && !(await groups?.get(body.groupId))) {
          throw Errors.badRequest('分组不存在')
        }
        const created = await users.create({
          username: body.username,
          password: body.password,
          role: body.role,
          /**
           * 邮箱选填。管理员建的账号**一律直接可用**（create 默认 activated=true）——
           * 让他去等一封验证码没有意义：他人就在管理员面前，身份已经被确认过了。
           */
          ...(typeof body.email === 'string' ? { email: body.email.trim() } : {}),
          ...(typeof body.groupId === 'string' ? { groupId: body.groupId } : {}),
        })
        reqLogger.info('管理员创建账号', { by: subject.username, username: created.username, group: created.groupId })
        return sendJson(res, 201, { ok: true, user: created })
      } catch (error) {
        throw Errors.badRequest(error.message)
      }
    }

    /* ── Token 用量 ── */

    /**
     * 谁在用多少 token、花在哪个模型上。
     *
     * 只回聚合数：次数、输入/输出/缓存读入的 token、最近一次的时间。
     * **一个字的对话内容都不经过这里** —— 管理员该看得见成本，不该顺带看见
     * 别人写了什么，而"顺带能看见"迟早会有人真的去看。
     *
     *   days   时间窗（默认 30，0 = 全部）
     *   group  `user`（默认）每个账号一行、带他用过的模型；`model` 每个模型一行、
     *          带用了它的人。同一份交叉表的两种转置，所以两页合计相等。
     *
     * 台账里没有的账号也会出现在 `group=user` 的清单里（一行 0），否则"没用过"
     * 和"不存在"在界面上长得一样。模型那一维没有这层补零：服务端没有"本部署有
     * 哪些模型"的权威清单（每个用户的可用模型是各自从 llminfo 拿的）。
     *
     * **行是分页的**（limit / cursor），但**顶上那几个合计不是** —— 它们始终是
     * 整个时间窗的数。一张"合计只算了当前这一页"的用量表会让管理员每翻一页
     * 看到一个不同的总数，而他没有任何办法看出哪个是对的（细节见 usage-store）。
     */
    if (req.method === 'GET' && url.pathname === '/v1/admin/usage') {
      if (!usage?.enabled) {
        return sendJson(res, 200, { enabled: false, users: [], models: [], total: null, hasMore: false, nextCursor: '' })
      }
      return sendJson(res, 200, await usage.summary({
        /**
         * 账号那一侧传的是**两个回调**，不是一份取好的清单。
         *
         * 从前这里是 `accounts: await users.list()` —— 也就是说，打开一次用量页
         * 就要先把全部账号取回来。回调让用量那一层按需一页一页地要，
         * 同时它照旧不需要知道账号存在哪张表里。
         */
        accounts: {
          page: (query) => users.page(query),
          many: (names) => users.getMany(names),
        },
        days: url.searchParams.get('days'),
        group: url.searchParams.get('group') || 'user',
        cursor: url.searchParams.get('cursor') || '',
        limit: normalizeLimit(url.searchParams.get('limit')),
        ...(await pricingArgs()),
      }))
    }

    /**
     * 展开一行看趋势（按天）。
     *
     * 路径分成 `.../usage/user/<名字>` 与 `.../usage/model/<模型>` 两条，而不是
     * 共用一个 `.../usage/<谁>`：模型 id 和用户名住在同一层的话，一个叫 `model`
     * 的账号就能把另一条路由遮掉。多一段前缀换掉这类**取决于命名巧合**的歧义。
     *
     * 汇总不在这两条路由上 —— 它已经在总表每一行里带下来了，展开时不再打一次，
     * 也就不会出现"表里 450,092、展开后 450,091"这种对不上。
     */
    if (req.method === 'GET' && url.pathname.startsWith('/v1/admin/usage/user/')) {
      /**
       * 名字先过一遍字符集再往下传。
       *
       * 用的是**存储层那一个** assertSegment，不是账号那一个 assertUsername：
       * 后者允许 `..`（当用户名它没问题），而存储层会拒绝它并抛一个普通 Error ——
       * 于是一个打错的名字会表现成 500。两处用同一个判据，过了这里就一定过那边。
       */
      let who
      try {
        who = assertSegment(decodeURIComponent(url.pathname.slice('/v1/admin/usage/user/'.length) || ''), '用户名')
      } catch (error) {
        throw Errors.badRequest(error.message)
      }
      if (!usage?.enabled) return sendJson(res, 200, { enabled: false, username: who, daily: [] })
      const trend = await usage.trend({
        username: who,
        // 带上模型就只看他在这个模型上的曲线（换模型前后的对比）
        modelId: url.searchParams.get('modelId') || '',
        days: url.searchParams.get('days'),
        ...(await pricingArgs()),
      })
      /**
       * 名字既不是一个账号、台账里也一行都没有 → 404。
       *
       * 不能只判"是不是账号"：账号删掉之后它的账还在台账里（总表上那一行标着
       * orphan），点开来该看得到明细。也不能不判：那样一个打错的名字会回一张
       * 全是 0 的表，看起来像"这个人没用过"。
       */
      if (!trend.total.runs && !(await users.get(who))) throw Errors.notFound('用户不存在')
      return sendJson(res, 200, trend)
    }

    if (req.method === 'GET' && url.pathname.startsWith('/v1/admin/usage/model/')) {
      /**
       * 模型 id **不过 assertSegment**：那是给路径段用的（≤64 字符、不许有 `/`），
       * 而模型 id 是网关给的一个字符串，`vendor/name:tag` 这种写法完全合法。
       * 它在这里只当查询参数用（参数化 SQL，不拼路径），所以只收口长度。
       */
      const modelId = decodeURIComponent(url.pathname.slice('/v1/admin/usage/model/'.length) || '')
      if (!modelId || modelId.length > 128) throw Errors.badRequest('模型 id 不合法')
      if (!usage?.enabled) return sendJson(res, 200, { enabled: false, modelId, daily: [] })
      const trend = await usage.trend({ modelId, days: url.searchParams.get('days'), ...(await pricingArgs()) })
      // 模型没有"账号表"可以对照，所以判据只有一条：台账里有没有它
      if (!trend.total.runs) throw Errors.notFound('这个模型在该时间窗内没有用量')
      return sendJson(res, 200, trend)
    }

    /* ══════════ 模型配置（LLM_MODE=db 的那份清单）══════════ */

    /**
     * 这一组接口在**任何 LLM_MODE 下都开着**，但只有 db 模式下配的东西才生效。
     *
     * 反过来（非 db 模式就 404）会逼出一个没必要的停机：管理员得先把 LLM_MODE
     * 切到 db、重启、发现一个模型都没有、所有人的对话一起断，然后才能开始配。
     * 现在是先配好、再切模式。`effective` 这个字段就是给界面写那句提示用的。
     */
    if (url.pathname === '/v1/admin/models' || url.pathname.startsWith('/v1/admin/models/')) {
      if (!modelStore) throw Errors.notFound('本部署没有启用模型配置')
      const modelId = url.pathname.startsWith('/v1/admin/models/')
        ? decodeURIComponent(url.pathname.slice('/v1/admin/models/'.length))
        : ''

      if (req.method === 'GET' && !modelId) {
        const found = await modelStore.page({
          cursor: url.searchParams.get('cursor') || '',
          limit: normalizeLimit(url.searchParams.get('limit')),
        })
        return sendJson(res, 200, {
          models: found.items,
          hasMore: found.hasMore,
          nextCursor: found.nextCursor,
          // 表头那句"N 个启用 · 共 N 个"要的是全部，不是当前这一页
          stats: await modelStore.stats(),
          // 现在这份清单起不起作用。界面据此在顶部写一条提示，而不是让管理员
          // 配完之后才发现 LLM_MODE 还指着别处
          effective: config.llm.mode === 'db',
          llmMode: config.llm.mode,
          // key 是不是加密入库的。没加密时界面上要说一句，别让人以为它天然安全
          encrypted: Boolean(config.llm.configSecret),
          /**
           * 单价那三个输入框上标的币种（USAGE_CURRENCY）。
           *
           * 回给界面而不是让它写死：填价的人唯一会犹豫的就是"这个数是什么币"，
           * 而猜错的表现是一张单位错了、数字全对的账单。
           */
          currency: config.limits?.usageCurrency || 'USD',
        })
      }

      if (req.method === 'POST' && !modelId) {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        try {
          const created = await modelStore.create(body)
          reqLogger.info('管理员新增模型', { by: subject.username, model: created.model })
          return sendJson(res, 201, { ok: true, model: created })
        } catch (error) {
          throw Errors.badRequest(error.message)
        }
      }

      if (req.method === 'PATCH' && modelId) {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        try {
          const updated = await modelStore.update(modelId, body)
          if (!updated) throw Errors.notFound('模型配置不存在')
          reqLogger.info('管理员修改模型', { by: subject.username, model: updated.model })
          return sendJson(res, 200, { ok: true, model: updated })
        } catch (error) {
          if (error instanceof AppError) throw error
          throw Errors.badRequest(error.message)
        }
      }

      if (req.method === 'DELETE' && modelId) {
        if (!(await modelStore.remove(modelId))) throw Errors.notFound('模型配置不存在')
        reqLogger.info('管理员删除模型', { by: subject.username, id: modelId })
        /**
         * **用量台账不动。** 那些行按 model_id 记着，模型配置删了不代表历史用量
         * 不存在了 —— 账单还要对。管理台的用量页照样列得出它（与"账号已删除"
         * 那一行同一个道理）。
         */
        return sendJson(res, 200, { ok: true })
      }

      throw Errors.notFound('没有这个接口')
    }

    /* ══════════ 用户分组 ══════════ */

    if (url.pathname === '/v1/admin/groups' || url.pathname.startsWith('/v1/admin/groups/')) {
      if (!groups) throw Errors.notFound('本部署没有启用用户分组')
      const groupId = url.pathname.startsWith('/v1/admin/groups/')
        ? decodeURIComponent(url.pathname.slice('/v1/admin/groups/'.length))
        : ''

      if (req.method === 'GET' && !groupId) {
        const found = await groups.page({
          cursor: url.searchParams.get('cursor') || '',
          limit: normalizeLimit(url.searchParams.get('limit')),
        })
        /**
         * 顺带回每个分组**有多少人、能用几个模型**。
         *
         * 这两个数是管理员看这一页时真正要问的问题（"这个分组是空的吗"、
         * "这个分组的人有模型可用吗"），而它们各自要遍历另外两个集合 ——
         * 让界面自己去算的话，那两份清单得在前端各拉一次再对齐，
         * 而分组页本来不需要知道模型和账号长什么样。
         *
         * ── 人数这一个数原先是怎么算的 ──────────────────────────────────
         *
         * `await users.list()` 然后在 JS 里 filter：**打开一次分组页 = 把全部账号
         * 记录（含 scrypt 派生结果和盐）搬进 Node**，只为了在页面上显示每组一个整数。
         * 现在走 `users.countByGroup()`，一句 GROUP BY，回来的是每组一行。
         *
         * 模型那一维仍然是整取 + JS filter，而且这是**有依据的**：模型天然有界
         * （一个部署十几条），而判据是"启用 且（可用范围为空 或 含这个分组）"——
         * 一个跨 JSON 数组的包含判断，写进 SQL 换不来任何东西。
         */
        const [byGroup, models] = await Promise.all([
          users ? users.countByGroup() : Promise.resolve(new Map()),
          modelStore ? modelStore.list() : Promise.resolve([]),
        ])
        return sendJson(res, 200, {
          groups: found.items.map((group) => ({
            ...group,
            userCount: byGroup.get(group.id) || 0,
            modelCount: models.filter(
              (model) => model.enabled && (!model.groups.length || model.groups.includes(group.id)),
            ).length,
          })),
          hasMore: found.hasMore,
          nextCursor: found.nextCursor,
          // 表头那句"N 个分组"要的是全部，不是当前这一页
          total: await groups.count(),
          // 无分组的人也要有个地方看得见 —— 否则"人数加起来对不上"没法解释
          ungrouped: byGroup.get('') || 0,
          /**
           * 每日额度在哪个时区归零（QUOTA_TIMEZONE）。
           *
           * 回给界面而不是让它写死一个 'Asia/Shanghai'：这是部署级的配置，
           * 而"每天几点归零"正是管理员填每日额度时唯一会犹豫的那件事。
           * 前端猜错了的表现是页面上写着北京时间、实际按别的时区归零。
           *
           * `?.` 不是防御性冗余：测试里的 config 是手搭的局部对象，没有 limits 段。
           * 缺了就走与 config.js 同一个默认值（那个常量就住在闸门自己那边）。
           */
          quotaTimezone: config.limits?.quotaTimezone || DEFAULT_TIMEZONE,
        })
      }

      if (req.method === 'POST' && !groupId) {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        try {
          const created = await groups.create(body)
          reqLogger.info('管理员新建分组', { by: subject.username, group: created.name })
          return sendJson(res, 201, { ok: true, group: created })
        } catch (error) {
          throw Errors.badRequest(error.message)
        }
      }

      if (req.method === 'PATCH' && groupId) {
        const body = await readJsonBody(req, config.limits.bodyLimitBytes)
        try {
          const updated = await groups.update(groupId, body)
          if (!updated) throw Errors.notFound('分组不存在')
          return sendJson(res, 200, { ok: true, group: updated })
        } catch (error) {
          if (error instanceof AppError) throw error
          throw Errors.badRequest(error.message)
        }
      }

      if (req.method === 'DELETE' && groupId) {
        if (!(await groups.get(groupId))) throw Errors.notFound('分组不存在')
        /**
         * 删分组要**把引用一起摘干净**，顺序是先摘引用再删本体。
         *
         * 反过来（先删本体）中间那一刻里，模型和账号指着一个已经不存在的 id：
         * 那些人能用的模型会**突然从"分组内可见"退化成"只剩公开的"**，
         * 而如果这时候摘引用的那几步失败了，库里就永久留着一批悬空 id。
         * 先摘引用的话，最坏情况是分组还在、引用没了 —— 一个能重试的状态。
         */
        const detachedUsers = users ? await users.clearGroup(groupId) : 0
        const detachedModels = modelStore ? await modelStore.dropGroup(groupId) : 0
        await groups.remove(groupId)
        reqLogger.info('管理员删除分组', { by: subject.username, id: groupId, detachedUsers, detachedModels })
        return sendJson(res, 200, { ok: true, detachedUsers, detachedModels })
      }

      throw Errors.notFound('没有这个接口')
    }

    /* ── 单个账号（改角色 / 禁用 / 重置密码 / 改分组）── */

    const target = url.pathname.startsWith('/v1/admin/users/')
      ? decodeURIComponent(url.pathname.slice('/v1/admin/users/'.length))
      : ''
    if (req.method === 'PATCH' && target && !target.includes('/')) {
      const body = await readJsonBody(req, config.limits.bodyLimitBytes)
      try {
        let updated = null
        if (typeof body.disabled === 'boolean') {
          /**
           * 不许把自己禁掉。
           *
           * 这不是洁癖：唯一的管理员一旦禁了自己，就**没有任何人**能再进来把它打开 ——
           * 只能去数据库里手工改一行。挡住这一步比事后补救便宜得多。
           */
          if (body.disabled && target === subject.username) {
            throw Errors.badRequest('不能禁用自己 —— 那样就再没人能把它打开了')
          }
          updated = await users.setDisabled({ username: target, disabled: body.disabled })
        }
        if (typeof body.role === 'string') {
          if (target === subject.username && body.role !== 'admin') {
            throw Errors.badRequest('不能撤销自己的管理员身份')
          }
          updated = await users.setRole({ username: target, role: body.role })
        }
        if (typeof body.newPassword === 'string') {
          if (!(await users.resetPassword({ username: target, newPassword: body.newPassword }))) {
            throw Errors.notFound('用户不存在')
          }
          updated = await users.get(target)
          reqLogger.info('管理员重置密码', { by: subject.username, username: target })
        }
        if (typeof body.groupId === 'string') {
          /**
           * 空串是合法的（退出分组），非空则**必须真的存在**。
           *
           * 不校验的话，一个手滑打错的 id 会安静地写进去，而现象是那个人
           * 能用的模型变少了 —— 界面上他有个分组名显示不出来，
           * 但谁也不会立刻把这两件事联系起来。
           */
          if (body.groupId && !(await groups?.get(body.groupId))) throw Errors.badRequest('分组不存在')
          updated = await users.setGroup({ username: target, groupId: body.groupId })
          if (!updated) throw Errors.notFound('用户不存在')
        }
        if (!updated) throw Errors.badRequest('没有可更新的字段（disabled / role / newPassword / groupId）')

        /**
         * 改完就把这个人的账号状态缓存踢掉。
         *
         * 禁用和重置密码会推 tokenVersion，令牌本来就该当场失效；改角色和改分组
         * 不推，但缓存里存着 role，不踢的话"刚被降级的人还能进管理台"最长能持续
         * 一个 TTL。四种改动都踢，比记住"哪几种需要踢"可靠。
         */
        identity.invalidateUser?.(target)

        return sendJson(res, 200, { ok: true, user: updated })
      } catch (error) {
        if (error instanceof AppError) throw error
        throw Errors.badRequest(error.message)
      }
    }

    throw Errors.notFound('没有这个接口')
  }

    // 不是 /v1/auth/password，也不是 /v1/admin/* —— 交给下一段
    return false
  }
}
