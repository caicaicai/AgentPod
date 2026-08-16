/**
 * 全局状态的单例，以及各处都要用的那几个存储键。
 *
 * ── 为什么它自己一个文件 ────────────────────────────────────────────────
 *
 * 这份 `state` 是**所有**领域模块的共同依赖（对话、作品、管理台、路由…）。
 * 从前它和两千行动作挤在 stores/app.js 里，于是拆分寸步难行：任何一个模块
 * 想拿到 state 都得 import app.js，而 app.js 又要 import 那些模块 ——
 * 一个绕不开的环。把它单独放出来之后，依赖方向就固定成了单向的：
 *
 *     state.js  ←  各领域模块  ←  app.js（装配 + 统一 re-export）
 *
 * 所以**这个文件不许 import 除 vue 之外的任何东西**。一旦它开始依赖某个
 * 领域模块，上面那个环就回来了。
 *
 * 用 reactive 单例而不是 Pinia：这个界面只有一份状态、没有服务端渲染，
 * 引一个状态库换来的只是多一层 API。
 */
import { reactive } from 'vue'

export const MODEL_KEY = 'ap.model'
export const PROJECT_KEY = 'ap.projectId'
export const THEME_KEY = 'ap.theme'
export const ARTIFACT_WIDTH_KEY = 'ap.artifactWidth'
export const DRAFT_PREFIX = 'ap.draft.'

export function newSessionKey() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export const state = reactive({
  health: null,
  /** 服务端开了哪些能力。关掉的那些整块不显示，而不是点了没反应 */
  features: {},
  booted: false,
  /**
   * 服务端已经就"要不要登录"表过态了（/healthz 回来了，或者它压根连不上）。
   *
   * 在这之前 `needLogin` 只是一个**猜测**（见 lib/api.js:getCachedAuthMode）。
   * 界面靠这个标志区分"还不知道"和"知道了，不用登录"——
   * 两者都是 `needLogin === false`，但前者不该拿它当真去画应用外壳。
   */
  authReady: false,
  /** password 模式下为 true 时显示登录框 */
  needLogin: false,
  loginError: '',
  banner: '',
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',

  models: [],
  modelId: '',
  user: null,

  skills: [],
  skillsUsable: true,
  skillsNote: '',
  skillsNoteWarn: false,

  sessions: [],
  /**
   * 会话列表的翻页状态（keyset 游标，见 src/sessions/cursor.js）。
   *
   * `sessionsHasMore` 由**服务端**说了算，不靠 `sessions.length === limit` 猜 ——
   * 那种猜法在"最后一页恰好装满"时会多画一个点了没反应的「加载更多」。
   */
  sessionsCursor: '',
  sessionsHasMore: false,
  sessionsLoadingMore: false,
  activeKey: newSessionKey(),
  /** 当前会话已落库的消息（已按"连续的助手消息合成一轮"分好组） */
  turns: [],
  /** 正在跑的这一轮：{ blocks, error, done, runId, controller } */
  live: null,
  /** 新会话在发出第一条消息之前只存在于前端，列表里也就没有它 */
  pendingNew: true,
  loadingSession: false,
  /**
   * 正在手动压缩上下文。
   *
   * 单独一个标志而不是复用 `loadingSession`：那个是"历史正在加载"，
   * 压缩要**调一次模型**，十几秒起 —— 借用它的话，界面上会显示成
   * "正在加载对话"，而用户会以为是网络卡了。
   */
  compacting: false,

  search: '',
  /** 搜索结果（走后端全文），为 null 表示当前不在搜索态 */
  searchHits: null,

  // ── 输入区 ──
  draft: '',
  attachments: [],
  composerError: '',
  /**
   * 结构化的引用上下文：现在只有"预览里选中的那个元素"一种。
   * `{ meta, pick }`。
   *
   * **与 draft 分开存**，因为它不是用户打的字：拼成提示词塞进输入框的话，
   * 用户自己那句"把它改成蓝色的"会被埋在十几行标记中间，改也不好改、看也不好看。
   * 发送时才拼（见 send），显示时折回一枚 chip（见 parsePickedElement）。
   */
  composerContext: null,

  // ── 项目 ──
  projects: [],
  /** 当前项目。空串 = 全部对话 */
  projectId: '',

  // ── 记忆 ──
  memoryScope: 'personal',
  memory: { content: '', revision: '', count: 0 },
  memoryDraft: '',
  memoryNote: '',
  memoryNoteWarn: false,

  // ── 定时任务 ──
  crons: [],
  cronNote: '',
  cronNoteWarn: false,

  // ── 作品 ──
  /**
   * 主视图。`chat` = 对话，`artifacts` = 作品库，`market` = 作品市场。
   *
   * 作品库是**独立入口**而不是又一个抽屉：抽屉是"边聊边看这一轮的产出"，
   * 而"上周做的那个报表在哪"是另一件事 —— 它跟当前聊到哪儿没有关系，
   * 挤在对话右边那条缝里也翻不动。市场同理，而且它连"我的"都不是。
   *
   * ⚠️ 这里写的 `'chat'` **不是首屏的值** —— mount 之前 `initRoute()` 会按地址栏
   * 把它改成对应的那一页（见 stores/app.js）。写死成 chat 再等 boot 改的话，
   * 刷新 /admin/models 会先画一帧聊天页，看起来像地址是假的。
   */
  view: 'chat',
  /** 当前会话的作品清单（不含正文） */
  artifacts: [],
  /** 作品库里的全部作品（跨会话）。与上面那份分开存，因为口径不同 */
  libraryArtifacts: [],
  librarySearch: '',
  /** 类型筛选，空串 = 全部 */
  libraryKind: '',
  libraryLoading: false,
  /**
   * 预览里选中的那个元素：{ selector, label, html, text }。
   *
   * ⚠️ 这四个字段来自沙箱文档的 postMessage，**是不可信输入** ——
   * 那份文档是模型生成的，可以伪造。所以只当字符串用（模板插值会转义），
   * 长度在收进来那一刻就截断，见 onPreviewMessage。
   */
  artifactPick: null,
  /** 元素拾取模式开着没有 */
  artifactPicking: false,
  /** 创建向导：选类型 + 写一句描述 → 拼成给模型的话 */
  wizardOpen: false,
  wizardKind: 'web',
  wizardDraft: '',
  /** 服务端下发的预览约束，前端拿它拼 iframe 的 CSP，不在这边硬编 */
  artifactPreview: { allowedOrigins: [] },
  /** 面板里打开的那一份：{ meta, version, content, fileName } */
  artifactDetail: null,
  artifactLoading: false,
  artifactNote: '',
  /**
   * 作品面板铺满整个界面。**一次性的：抽屉一关就复位。**
   *
   * 曾经记在 localStorage 里，理由是"偏好全屏的人每次都想要全屏"。
   * 那个理由站不住：全屏是为了**把眼前这一份看清楚**（一个整页网页、一张大图），
   * 而不是一种长期口味。记下来之后，下次打开一份小作品也是满屏，
   * 而用户完全不记得自己什么时候"设置"过 —— 于是它表现得像个 bug。
   *
   * 宽度（artifactWidth）仍然记盘：那是"这个抽屉在我屏幕上该多宽"，
   * 确实是长期偏好，两者性质不同。
   */
  artifactFull: false,
  /** 用户拖出来的面板宽度（像素）。0 = 用默认档位。同样记盘，理由同上 */
  artifactWidth: Number(localStorage.getItem(ARTIFACT_WIDTH_KEY)) || 0,

  // ── 分享 ──
  /** 三个分享动作共用一个在途标记：同一时刻只可能在做其中一件 */
  shareBusy: false,
  shareNote: '',
  /**
   * 作品市场。**它是公开数据**，走的是免登录那条接口 —— 应用内看到的和
   * 访客在 /market 上看到的是同一份，不会出现"登录后才发现少了几条"。
   */
  marketItems: [],
  marketSearch: '',
  marketKind: '',
  marketLoading: false,
  marketNote: '',

  // ── 账号 ──
  /**
   * 我自己那条账号记录（`{ username, role, disabled, createdAt }`）。
   * 没接账号存储时是 null —— 界面据此不画「我的账号」和管理员入口。
   */
  account: null,
  accountBusy: false,
  accountNote: '',
  accountNoteWarn: false,

  /**
   * 管理员控制台。
   *
   * ── 四张表全部是分页的，所以每张都带三样东西 ────────────────────────
   *
   *   `xxxCursor`   下一页从哪儿开始（服务端给的，前端不解释它的内容）
   *   `xxxHasMore`  还有没有下一页。**由服务端说了算**，不靠"这一页装满了没"猜 ——
   *                 那种猜法在"最后一页恰好装满"时会多画一个点了没反应的「加载更多」
   *   `xxxLoadingMore` 只作用在那个按钮上。与整表的 loading 分开：翻下一页时
   *                 已经看到的行不该跟着变灰闪一下
   *
   * `adminStats` 是**全局**的两个数（总账号数、在岗管理员数），不是"当前加载了几条"。
   * 后面那个数有实际用处：界面靠它判断"这是不是最后一个管理员"（最后一个不能降级
   * 也不能禁用）。从已加载的那一页去数的话，翻到第二页就会告诉你只剩一个了，
   * 而实际上第一页里还有三个 —— 现象是几个本该能点的按钮无缘无故变灰。
   */
  adminUsers: [],
  adminUsersCursor: '',
  adminUsersHasMore: false,
  adminUsersLoadingMore: false,
  adminStats: { total: 0, admins: 0 },
  /**
   * 搜索框里的词。**筛选在服务端做** —— 从前是前端在已加载的清单上 filter，
   * 分页之后那等于"只搜当前这一页"，而搜不到的人看起来就像不存在。
   */
  adminSearch: '',
  adminLoading: false,
  adminBusy: false,
  adminNote: '',
  adminNoteWarn: false,
  /**
   * 管理台的四页：
   *   users   管人（含每个人属于哪个分组）
   *   models  这个部署有哪些模型（LLM_MODE=db 时生效）
   *   groups  用户分组 —— 模型按分组开放，所以它排在模型后面
   *   usage   token 用量
   */
  adminTab: 'users',

  /**
   * 模型配置。
   *
   * `adminModelsMeta` 装的是"这份清单现在生不生效"（服务端回的 effective/llmMode/
   * encrypted）。它必须和清单一起来：一个配得好好的模型在 LLM_MODE=platform 的
   * 部署上是**完全不起作用**的，而界面上看不出任何区别 —— 那句提示是这一页
   * 唯一能防住"配完了以为好了"的东西。
   */
  adminModels: [],
  adminModelsMeta: { effective: false, llmMode: '', encrypted: false, currency: '' },
  /** 全部模型里有几条、其中几条启用着。表头用它，不数当前这一页 */
  adminModelStats: { total: 0, enabled: 0 },
  adminModelsCursor: '',
  adminModelsHasMore: false,
  adminModelsLoadingMore: false,
  adminModelsLoading: false,
  /** 正在编辑的那条的 id；'new' 表示在新建 */
  adminModelEditing: '',

  /** 分组。`adminUngrouped` 是没有分组的人数，否则各分组人数加起来对不上账号总数 */
  adminGroups: [],
  adminUngrouped: 0,
  adminGroupTotal: 0,
  adminGroupsCursor: '',
  adminGroupsHasMore: false,
  adminGroupsLoadingMore: false,
  adminGroupsLoading: false,
  adminGroupEditing: '',
  /** 每日 token 额度在哪个时区归零。空 = 还没拉到，页面上退回默认那个时区名 */
  adminQuotaTimezone: '',

  /**
   * Token 用量。
   *
   * `adminUsage` 是总表（`{ enabled, group, since, total, users | models }`，
   * null = 还没取过）。每行都带着另一维的拆分：用户行带 `models`，模型行带 `users` ——
   * 所以展开一行不再打一次接口，展开的数字与表里那个**一定相等**。
   *
   * `adminUsageGroup` 决定看哪一维：'user'（谁烧得最多）或 'model'（哪个模型烧得最多）。
   *
   * `adminUsageTrend` 是展开那一行的**按天曲线**（只有它需要额外一次请求）。
   * 只留一份：同一时刻只可能展开一行，留着旧的只会让人看到上一行的数字闪一下。
   */
  adminUsage: null,
  /**
   * 用量表的行是分页的。⚠️ `adminUsage.total` / `pricing` / `modelCount`
   * **不跟着翻页变** —— 它们始终是整个时间窗的合计（服务端如此），
   * 所以翻到第三页时顶上那几个数字仍然是全量的。别在前端拿当前这些行去重算。
   */
  adminUsageCursor: '',
  adminUsageHasMore: false,
  adminUsageLoadingMore: false,
  adminUsageDays: 30,
  adminUsageGroup: 'user',
  adminUsageLoading: false,
  adminUsageOpen: '',
  adminUsageTrend: null,
  adminUsageTrendLoading: false,

  // ── 界面开关 ──
  sidebarCollapsed: false,
  panel: '', // '' | 'skills' | 'memory' | 'cron' | 'project' | 'debug' | 'artifact'
  debugText: '',
  debugNote: '',
  lightbox: '',
})
