/**
 * ESLint 扁平配置。
 *
 * ── 这份配置想抓什么 ────────────────────────────────────────────────────
 *
 * **只抓真问题，不当风格警察。**
 *
 * 这个仓库的风格已经相当统一（两空格缩进、无分号、单引号），而那份统一不是
 * 靠工具维持的，是靠写的人维持的。上一套带格式规则的配置，产出会是几千条
 * "这里该换行"，然后所有人学会 `--fix` 之后再也不看输出 —— 那时候 lint
 * 就从"能发现问题的东西"退化成了"CI 里一个总是绿的步骤"。
 *
 * 所以这里只留下**会指向 bug 的规则**：用了没声明的变量、声明了没用的变量、
 * Promise 忘了 await、case 穿透、正则里的低级错误。格式交给 code review。
 *
 * ── 三块作用域 ──────────────────────────────────────────────────────────
 *
 *   服务端  src/ test/ scripts/ —— Node ESM，能用 process / Buffer
 *   前端    web/src/            —— 浏览器 ESM + Vue 单文件组件
 *   忽略    产物与依赖
 */
import js from '@eslint/js'
import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'

export default [
  {
    /**
     * 忽略项要放在最前面且**单独成块** —— 扁平配置里，只含 `ignores` 的对象
     * 才是全局忽略；和 `files` 写在一起就退化成"这一块的例外"，
     * 表现是 lint 依然去扫 node_modules，然后跑上几分钟。
     */
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'web/public/**',
      'sandbox-manager/**',
      'sandbox-worker/**',
      'builtin-skills/**',
      'managed-skills/**',
      'skill-libs/**',
    ],
  },

  js.configs.recommended,

  {
    /**
     * 全仓关掉的规则，各有各的理由。
     */
    rules: {
      /**
       * `no-control-regex` 在这个仓库里**全是误报**。
       *
       * 它会对正则里出现的控制字符报错，出发点是"你多半是手滑打进去的"。
       * 但我们这儿每一处都是**清洗函数**：作品文件名里剔除 \x00-\x1f、
       * markdown 渲染前先把占位符里的 \x00 摘掉。那些控制字符正是要匹配的目标 ——
       * 规则在这里等于"禁止编写清洗控制字符的代码"。
       *
       * 逐行加 eslint-disable 也行，但四处注释说的是同一句话，
       * 不如在这里说一次。
       */
      'no-control-regex': 'off',
    },
  },

  // ── 服务端 ──────────────────────────────────────────────────────────────
  {
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      /**
       * 未使用的变量是**错**，不是警告 —— 它多半意味着"改了一半"：
       * 换了实现却留着旧的 import，或者解构出一个字段然后忘了用它。
       *
       * 下划线开头的参数放行：回调签名里"我不关心前两个参数"是合法写法，
       * 而删掉它们就对不上位置了。
       */
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none', // catch {} 已经能省略绑定，剩下的 catch (error) 不写也无妨
        /**
         * `const { ok, action, ...rest } = result` 这种"摘掉几个字段"的写法里，
         * 被摘掉的那几个本来就是不用的 —— 那正是它们出现在那儿的原因。
         * 不放行的话，只能把它们改名成 `_ok`，而那反而让意图变模糊了。
         */
        ignoreRestSiblings: true,
      }],

      /** 空 catch 是这个仓库里的常见写法（"这一步失败不影响主流程"），且都带注释 */
      'no-empty': ['error', { allowEmptyCatch: true }],

      /** case 穿透几乎总是忘了 break */
      'no-fallthrough': 'error',

      /** `if (x = 1)` 这类把赋值写进条件的手滑 */
      'no-cond-assign': ['error', 'always'],

      /** await 一个不是 Promise 的东西，通常说明少调了一层 */
      'require-atomic-updates': 'off', // 误报太多（对 async 里的累加变量）

      /** 同一个 key 写两遍 —— 后一个静默覆盖前一个，这是配置对象里最难看出的错 */
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',

      /** 正则里的手滑：字符组写空了、多打了空格 */
      'no-empty-character-class': 'error',
      'no-regex-spaces': 'error',

      /** `throw` 一个非 Error，会让上层的 error.message / stack 全是 undefined */
      'no-throw-literal': 'error',

      /** 声明前使用。函数声明会提升所以放行，变量不行 */
      'no-use-before-define': ['error', { functions: false, classes: false, variables: true }],
    },
  },

  // ── 前端 ────────────────────────────────────────────────────────────────
  ...pluginVue.configs['flat/essential'],
  {
    files: ['web/src/**/*.js', 'web/src/**/*.vue', 'web/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      /**
       * 模板里用了 setup 没暴露的东西 —— Vue 的这类错误在运行时只表现为
       * "这块不显示"，控制台一句警告也可能被别的日志淹掉。
       */
      'vue/no-undef-components': 'off', // 全局注册的组件会误报，暂时关掉
    },
  },

  // vite 配置跑在 Node 里，不是浏览器
  {
    files: ['web/vite.config.js', 'web/*.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },

  /**
   * 前端逻辑的单测跑在 Node 里，但被测代码是浏览器代码 —— 它们会先给
   * globalThis 装上 location / history / localStorage 的替身再 import。
   * 所以这几个文件两套全局都要有，否则 `location` 会被报成未定义。
   */
  {
    files: ['test/web-*.test.js', 'test/highlight.test.js', 'test/dialog.test.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]
