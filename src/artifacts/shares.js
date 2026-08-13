/**
 * 作品分享：把一份作品变成一条**任何人凭链接就能打开**的地址。
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────────
 *
 * 作品做出来是给人看的，而"能看到"的边界现在卡在登录态上：想给同事看一眼那张
 * 看板，只能截图，或者把 HTML 拷给对方让他自己另存再打开 —— 而作品之所以值得
 * 单独存成一组文件，恰恰是因为它是个**成品**。
 *
 * 于是两件事，刻意分成两个开关：
 *   1. **分享链接**：`/s/<token>`，凭链接访问，不需要登录。默认关，作者点了才有。
 *   2. **上市场**：把作品挂到公开的广场上让人翻。默认关，要再点一次。
 *
 * 分开是因为它们的意图完全不同：私发一条链接给同事，和"我愿意让所有人看见"，
 * 中间隔着一个人的意愿。合成一个开关的话，前者会静悄悄地变成后者。
 *
 * ── 两份状态，两个写者，没有重叠 ────────────────────────────────────────
 *
 * 分享要求一次**跨用户的查表**：访客手里只有 token，服务端得知道它属于谁。
 * 而这套存储的其余部分是**按 username 分区**的（见 persistence/file-map.js 的
 * createScopedMaps：拿不到"全局的表"，只能拿"某个人的表"）。所以这里是整个
 * 数据层里唯一一处全局索引，必须写明白它存了什么、以及为什么不危险：
 *
 *   <dataDir>/shares/<token>.json   { token, username, artifactId, createdAt, views }
 *     ── 纯索引 + 访问计数。**只有公开读路径写它**（计数）。
 *        它本身不含作品的任何内容，泄漏一份也只是泄漏"某个 token 指向谁的哪份作品"，
 *        而拿到 token 的人本来就能打开那份作品。
 *
 *   作品记录里的 `share` 字段        { token, market, marketAt, summary, createdAt }
 *     ── **权威**。"还分不分享、上没上市场、简介是什么"以它为准，只有作者写它。
 *
 * 由此得到一条贯穿本文件的规则：**索引可以过期，权威不会。**
 * 每一次公开读都要回到作品记录上核对 `share.token === token`，对不上就当没这条 ——
 * 于是"撤销了但指针文件没删干净""作品删了指针还在"这两类不一致，
 * 在**读**的那一刻就自动失效，而不是等谁去跑一次清理。顺手把它删掉（自愈），
 * 但删不掉也不影响正确性。
 *
 * 反过来说：撤销分享时必须**先清作品记录上的 share**，再删指针。反过来的话，
 * 进程在两步之间挂掉会留下"指针没了但作品还标着已分享"——那是个作者以为还开着、
 * 实际已经打不开的链接，比多一个孤儿指针难查得多。
 *
 * ── 分享把威胁模型挪动了一格 ────────────────────────────────────────────
 *
 * 在这个功能之前，一份作品只有**它的作者**会打开。作品正文是模型生成的，
 * 所以那里的风险是「注入」：一封诱导邮件混进模型的输入，让它往页面里写点什么。
 * 那是**意外**，而且受害者和作者是同一个人。
 *
 * 分享之后，任何人都能把一条链接发给任何人 —— 于是同一段内容变成了**故意**的：
 * 攻击者可以专门做一份作品，再把链接发给受害者。
 *
 * 好消息是这不需要新的防线：原本用来挡注入的那两道，挡的正好是同一件事。
 *   - 预览始终在**不带 allow-same-origin** 的 sandbox iframe 里 →
 *     那段脚本读不到访客的 localStorage，也碰不到父页面；
 *   - 文档内 `default-src 'none'` 的 CSP → 它也带不出去任何东西；
 *   - 服务端从不以 HTML 的身份下发模型生成的内容（见 http/server.js 的
 *     sendArtifactFile）→ 这些内容永远拿不到本站的同源身份。
 *
 * 唯一真的要为分享补一刀的地方，是**沙箱主动往父页面推消息**那条通道
 * （元素拾取器的 postMessage）：访客那一页用不上它，却能被用来弹一张
 * 长得像我们自己界面、文字由攻击者决定的卡片。所以只读宿主整条不接，
 * 见 web/src/components/ArtifactViewer.vue 的 onPreviewMessage。
 */
import { randomBytes } from 'node:crypto'

import { createFileMap } from '../persistence/file-map.js'
import { assertSegment, safeJoin } from '../persistence/paths.js'

/** 市场卡片上的一句简介。长了就该点进去看作品本身 */
const SUMMARY_MAX = 140
/** 市场一次最多回多少条。翻页留到真有人抱怨列表不够长的时候再说 */
const MARKET_LIMIT = 200

/**
 * token 的形状：`s_` + 24 位十六进制 = 96 bit 随机。
 *
 * 长度不是随便定的：这串东西**就是访问凭据**，能猜到就等于能看到作品。
 * 96 bit 的空间下，即便有人拿整个互联网的带宽去撞也撞不出来，
 * 所以不需要再叠一层限流（限流挡的是暴力猜测，而这里根本猜不动）。
 *
 * 前缀 `s_` 是给人看的：日志和工单里一眼能认出"这是个分享 token"，
 * 而不是一串不知道从哪儿来的十六进制。
 */
const TOKEN_RE = /^s_[0-9a-f]{24}$/

export function newShareToken() {
  return `s_${randomBytes(12).toString('hex')}`
}

/**
 * token 校验。
 *
 * 它会成为一段路径（`shares/<token>.json`），所以字符集必须先收口 ——
 * 虽然下面还有 assertSegment + safeJoin 两道，但在这里当场拦掉的好处是：
 * 一条 `/s/../../etc` 的请求得到的是干脆的 404，而不是一条 500 加一行栈。
 */
export function assertShareToken(input) {
  const text = String(input || '').trim()
  if (!TOKEN_RE.test(text)) throw new Error('分享链接不合法')
  return text
}

export function cleanSummary(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX)
}

/**
 * 给访客看的作品元信息。
 *
 * 与作者看到的那份（store.js 的 toPublic）**刻意不同**，去掉两样东西：
 *
 *   - `sessionKey` / `projectId`：作者自己的组织方式，访客既用不上也不该知道。
 *     它们还会变成一条侧信道 —— 同一个人分享的两份作品，凭 sessionKey 能看出
 *     是不是同一条对话里做的。
 *   - `versions` 全表：分享跟随最新版（见 README），访客没有"切到第 3 版"这回事。
 *     留着历史清单只会让界面画出一个点不动的下拉框，还顺带泄漏作者改了多少遍。
 */
function toSharedMeta(meta) {
  return {
    id: meta.id,
    kind: meta.kind,
    language: meta.language || '',
    title: meta.title || '',
    entry: meta.entry || '',
    version: meta.version || 1,
    versions: [],
    createdAt: meta.createdAt || 0,
    updatedAt: meta.updatedAt || 0,
  }
}

/** 市场卡片。同样不含正文 —— 广场一次列几十条，带上正文就是几 MB */
function toMarketCard({ meta, pointer }) {
  const current = (meta.versions || []).find((item) => item.n === meta.version)
  return {
    token: pointer.token,
    author: pointer.username,
    title: meta.title || '',
    kind: meta.kind,
    language: meta.language || '',
    summary: meta.share?.summary || '',
    version: meta.version || 1,
    fileCount: (current?.files || []).length,
    updatedAt: meta.updatedAt || 0,
    marketAt: meta.share?.marketAt || 0,
    views: pointer.views || 0,
  }
}

/**
 * @param {object} params
 * @param {object} params.config
 * @param {object} params.artifacts  作品存储。分享**依赖**它而不是反过来：
 *   分享是加在作品上的一层能力，作品不知道自己被分享了也照样成立。
 */
export function createShareStore({ config, logger = console, artifacts }) {
  const settings = config.artifacts || {}
  // 作品功能本身关掉时，分享无从谈起 —— 别让它变成一个"开着但永远 404"的开关
  const enabled = settings.enabled !== false && settings.sharing !== false
  const marketEnabled = enabled && settings.market !== false

  /** 全局指针表。整个数据层里唯一一处不按 username 分区的地方，理由见文件头 */
  const map = createFileMap({ dir: safeJoin(config.dataDir, 'shares'), logger })

  /** 指针过期了就顺手删掉。删不掉也不影响正确性（权威在作品记录上），所以只记一句 */
  async function forget(token, why) {
    logger.debug?.('清理过期的分享指针', { token, why })
    await map.delete(token).catch((error) => {
      logger.warn?.('分享指针清理失败', { token, err: error?.message })
    })
  }

  /**
   * token → 作者与作品。**每一次公开读都要走这里**，因为核对就发生在这儿。
   * @returns {Promise<{pointer, meta} | null>}
   */
  async function resolve(token) {
    let key
    try {
      key = assertShareToken(token)
    } catch {
      return null // 形状都不对，不必去碰盘
    }
    const pointer = await map.get(key)
    if (!pointer?.username || !pointer?.artifactId) return null

    let meta = null
    try {
      meta = await artifacts.get({ username: pointer.username, id: pointer.artifactId })
    } catch (error) {
      // 指针里存着的东西当不了路径（只可能是有人手改过盘上的文件），当没有这条
      logger.warn?.('分享指针内容不合法', { token: key, err: error?.message })
    }
    if (!meta) {
      await forget(key, '作品已删除')
      return null
    }
    // 权威在这一行：作者撤销分享时清的就是这个字段
    if (meta.share?.token !== key) {
      await forget(key, '分享已撤销')
      return null
    }
    return { pointer, meta }
  }

  /**
   * 访问计数。
   *
   * **不 await，失败只记日志** —— 计数是个"顺便"的东西，
   * 让它挡在访客和作品之间（一次写盘失败就看不成）是本末倒置。
   */
  function countView(token) {
    map.update(token, (current) => ({
      ...current,
      views: (current.views || 0) + 1,
      lastViewAt: Date.now(),
    })).catch((error) => {
      logger.debug?.('分享访问计数失败', { token, err: error?.message })
    })
  }

  return {
    enabled,
    marketEnabled,

    /**
     * 开一条分享链接。**幂等**：已经分享过就原样返回那一条。
     *
     * 每次点都换一个新 token 的话，作者昨天发给同事的链接会在他今天再点一次
     * "分享"之后无声地失效 —— 而他做的这个动作，字面意思是"分享"，不是"换个地址"。
     */
    async create({ username, artifactId }) {
      if (!enabled) throw new Error('本部署未启用作品分享')
      const id = assertSegment(artifactId, '作品 id')
      const meta = await artifacts.get({ username, id })
      if (!meta) return null

      if (meta.share?.token) {
        const pointer = await map.get(meta.share.token)
        // 指针丢了（手工清过盘）就按当前 token 补一条回去，而不是换一个新的：
        // 作者手里那条链接还在用
        if (!pointer) {
          await map.put(meta.share.token, {
            token: meta.share.token, username, artifactId: id, createdAt: meta.share.createdAt || Date.now(), views: 0,
          })
        }
        return meta
      }

      const token = newShareToken()
      const now = Date.now()
      // 先落指针再落权威：反过来的话，中间挂掉会留下一个"作品说自己分享了、
      // 但那个 token 查无此表"的链接 —— 作者以为开着，访客看到 404
      await map.put(token, { token, username, artifactId: id, createdAt: now, views: 0 })
      return artifacts.setShare({
        username,
        id,
        share: { token, createdAt: now, market: false, marketAt: 0, summary: '' },
      })
    },

    /** 上/下市场，以及改那句简介。没开分享链接时不允许 —— 市场条目点开就是分享页 */
    async setMarket({ username, artifactId, market, summary }) {
      if (!marketEnabled) throw new Error('本部署未启用作品市场')
      const id = assertSegment(artifactId, '作品 id')
      const meta = await artifacts.get({ username, id })
      if (!meta) return null
      if (!meta.share?.token) throw new Error('请先生成分享链接，再发布到市场')

      const next = { ...meta.share }
      if (market !== undefined) {
        next.market = Boolean(market)
        // marketAt 是市场的排序键，只在**上架那一刻**打。下架再上架排到前面是对的：
        // 那是一次新的发布；而改一句简介就把自己顶到广场最前面，不是
        next.marketAt = next.market ? (meta.share.market ? meta.share.marketAt : Date.now()) : 0
      }
      if (summary !== undefined) next.summary = cleanSummary(summary)
      return artifacts.setShare({ username, id, share: next })
    },

    /**
     * 撤销。链接立刻失效。
     *
     * 顺序见文件头：先清权威（作品记录），再删指针。
     */
    async revoke({ username, artifactId }) {
      const id = assertSegment(artifactId, '作品 id')
      const meta = await artifacts.get({ username, id })
      if (!meta) return false
      const token = meta.share?.token
      if (!token) return false
      await artifacts.setShare({ username, id, share: null })
      await forget(token, '作者撤销')
      return true
    },

    /**
     * 会话删了，它名下作品的分享链接跟着失效。
     *
     * 不做这一步也不会漏数据（作品本身被删了，resolve 那一关过不去），
     * 但会在盘上留下一批永远指向空处的指针文件。**在还知道该删谁的时候删掉**，
     * 比留给读路径去自愈干净 —— 后者只在有人恰好访问那条死链时才触发。
     */
    async revokeForSession({ username, sessionKey }) {
      if (!enabled || !sessionKey) return 0
      const list = await artifacts.list({ username, sessionKey })
      let count = 0
      for (const meta of list) {
        if (!meta.share?.token) continue
        await forget(meta.share.token, '会话已删除')
        count += 1
      }
      return count
    },

    /** 作品被单独删掉时同理。调用方在**删之前**调，那时还查得到 share.token */
    async revokeForArtifact({ username, artifactId }) {
      if (!enabled) return false
      const meta = await artifacts.get({ username, id: artifactId }).catch(() => null)
      if (!meta?.share?.token) return false
      await forget(meta.share.token, '作品已删除')
      return true
    },

    resolve,
    countView,

    /**
     * 打开一份分享的作品：元信息 + 最新版的全部文件。
     *
     * **永远读最新版**，不接受访客指定版本 —— 分享的语义是"我这份东西"，
     * 而不是"我这份东西的第 3 版"。作者改进之后访客刷新就能看到新的。
     */
    async open(token) {
      if (!enabled) return null
      const found = await resolve(token)
      if (!found) return null
      const { pointer, meta } = found

      let current
      try {
        current = await artifacts.read({ username: pointer.username, id: pointer.artifactId })
      } catch (error) {
        // 最新版的文件读不出来（只可能是有人手工删过盘上的东西）。
        // 对访客来说这与"没这个链接"没有区别，但日志里要留下真正的原因
        logger.warn?.('分享的作品读取失败', { token: pointer.token, err: error?.message })
        return null
      }
      if (!current) return null

      return {
        meta: toSharedMeta(meta),
        version: current.version,
        files: current.files,
        share: {
          token: pointer.token,
          author: pointer.username,
          market: Boolean(meta.share?.market),
          summary: meta.share?.summary || '',
          sharedAt: meta.share?.createdAt || 0,
          views: pointer.views || 0,
        },
      }
    },

    /**
     * 市场清单。
     *
     * 走的是"扫指针表 → 逐条回作品记录核对"，而不是在指针里存一份标题的副本。
     * 副本会漂：作者改了标题，广场上还挂着旧的；而这类不一致没有任何报错，
     * 只有正好认识那份作品的人才看得出来。多几次小文件读换一个不会漂的列表，划算。
     *
     * 顺带把已经失效的条目清掉 —— 扫都扫到了。
     */
    async listMarket({ q = '', kind = '' } = {}) {
      if (!marketEnabled) return []
      const keyword = String(q || '').trim().toLowerCase()
      const items = []
      for (const pointer of await map.all()) {
        const found = await resolve(pointer.token)
        if (!found) continue // resolve 内部已经自愈过了
        if (!found.meta.share?.market) continue
        if (kind && found.meta.kind !== kind) continue
        const card = toMarketCard({ meta: found.meta, pointer: found.pointer })
        if (keyword && ![card.title, card.summary, card.author].some(
          (field) => field.toLowerCase().includes(keyword),
        )) continue
        items.push(card)
      }
      return items.sort((a, b) => (b.marketAt || 0) - (a.marketAt || 0)).slice(0, MARKET_LIMIT)
    },
  }
}
