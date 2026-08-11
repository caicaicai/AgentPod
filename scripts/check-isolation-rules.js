#!/usr/bin/env node
/**
 * 隔离契约的静态检查。放进 CI，和单测一起跑。
 *
 * 单测能覆盖运行时行为，但有些错误一旦写进代码就是系统性风险，
 * 应该在评审前就被挡住（例如"顺手用 process.env 传个 token"）。
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 前端也要查：调试信息导出功能会把界面上的东西整包交出去，
// 那条"绝不碰凭据"的线在浏览器侧同样成立（见 web/assets/debug-bundle.js）。
//
// worker 也要查，而且它的失守后果最重：那个进程是 root、跑在宿主的 mount namespace 里，
// 文件接口的路径收口漏一处就是"以 root 读写整台节点"（隔离契约 #9）。
// 从前这里不扫它，于是那个洞在 `sandbox-worker/` 里安安静静躺着 —— 静态检查扫不到的
// 目录，等于没有静态检查。
const SCAN_DIRS = [path.join(ROOT, 'src'), path.join(ROOT, 'web'), path.join(ROOT, 'sandbox-worker', 'src')]

const RULES = [
  {
    id: 'R1-凭据禁止进 process.env',
    pattern: /process\.env\.(ME_TOKEN|SSO_TOKEN|LLM_TOKEN|USER_TOKEN)\s*=/,
    hint: '凭据必须走 AuthStorage.inMemory() / run 上下文；写 process.env 在并发下会被其他用户覆盖',
  },
  {
    id: 'R1-禁止把凭据塞进全局',
    pattern: /globalThis\.[A-Za-z_]*(token|cookie|credential)/i,
    hint: '全局变量在共享进程里是跨用户的',
  },
  {
    id: 'R2-禁止启用 pi 内置本地执行工具',
    pattern: /createBashTool\s*\(|createCodingTools\s*\(/,
    hint: '这些会在服务进程内执行；请用 createBashToolDefinition + 注入沙盒 operations',
  },
  {
    id: 'R6-禁止模块级凭据缓存',
    pattern: /^(export\s+)?let\s+\w*(token|cookie|credential|profile)\w*\s*=/im,
    hint: '模块级变量跨 run 保留，在共享进程里必然串号（反面教材：jme-auth.ts 的 export let ssoToken）',
  },
  {
    id: '日志禁止打印凭据内容',
    pattern: /console\.(log|info|warn|error)\([^)]*\b(cookie|credential|apiKey|llmToken)\b[^)]*\)/i,
    hint: '只允许打印长度或 fingerprint()',
  },
  {
    id: '出站必须走 egress',
    // fetch 会自动跟重定向，跳转后的目标不再经过我们的白名单与 IP 校验；
    // 而且它不给 DNS 注入点，解析到内网的域名可以直接绕过 SSRF 防护。
    // 沙盒技能（bridge）和进程内工具（tools）都必须走同一条出站路径，
    // 否则白名单会变成「两份都得记得改」的东西，迟早漏一份。
    scope: ['src/bridge/', 'src/tools/'],
    pattern: /(^|[^.\w])fetch\s*\(/,
    hint: '出站一律用 egress.request() / ctx.http：逐跳校验白名单、逐跳决定要不要带凭据，并在 net 层校验真实 IP',
  },
  {
    id: '前端禁止读 document.cookie',
    // 「复制调试信息」把界面上的状态整包交出去给人分析。SSO 票就在 cookie 里，
    // 一旦有人"顺手把 cookie 也带上方便排查"，用户每次贴调试信息就等于贴自己的登录态。
    // 前端本来也不需要读它 —— 浏览器发请求时会自己带。
    scope: 'web/',
    pattern: /document\s*\.\s*cookie/,
    hint: '前端不需要读 cookie（浏览器会自己带上）；调试信息里绝不能出现凭据',
  },
  {
    id: 'R9-worker 的 HTTP 面禁止直接对路径做 fs 操作',
    // 这组接口跑在 worker（root）的宿主视角下，路径是调用方给的。原来的越界检查只做了
    // 词法那一道（resolve 后判前缀），挡得住 `../`、挡不住软链接 —— job 在自己的工作区里
    // `ln -s / esc`，`GET /files?path=esc/…` 就成了以 root 读整台机器。
    // 收口在 workspace-fs.js（逐段 O_NOFOLLOW + 钉住父目录），这里挡的是"图省事又写回来"。
    // readdir/lstat 不在列：listWorkspace 用它们，且拿到的已经是收口过的路径。
    scope: 'sandbox-worker/src/server.js',
    pattern: /(^|[^.\w])(readFile|writeFile|mkdir|rm|chown|createReadStream|realpath)\s*\(/,
    hint: '工作区文件访问一律经 workspace-fs.js 的 openConfined/readFileConfined/writeFileConfined/…（隔离契约 #9）',
  },
  {
    id: '移植的工具禁止直接读凭据环境变量',
    // 反面教材：joyme/src/client.ts 的 getAuthHeaders() 读 process.env.ME_TOKEN
    scope: 'src/tools/',
    pattern: /process\.env\.(ME_TOKEN|SSO_TOKEN|me_token|sso_token|COOKIE)/,
    hint: '凭据只经 ctx.http 使用；需要判断凭据种类请用 ctx.credentialFacts（只回布尔值）',
  },
]

const ALLOWLIST = [
  // logger.js 自己要处理这些关键字（脱敏实现）
  'src/logger.js',
  // 静态检查脚本本身
  'scripts/check-isolation-rules.js',
]

/**
 * 不进这几个目录。
 *
 * `node_modules` 是别人的代码，扫它只会扫出一堆与本仓库无关的告警，还慢；
 * `dist` 是 web/ 的构建产物 —— 同一段代码扫两遍，而且压缩后的那份行号对不上，
 * 报出来的位置没法用来改。
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite'])

/** `.vue` 也要扫：界面搬到 Vue 之后，那条"前端禁止读 document.cookie"多半是写在单文件组件里的 */
const SCAN_EXT = ['.js', '.vue']

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(path.join(dir, entry.name))
    } else if (SCAN_EXT.some((ext) => entry.name.endsWith(ext))) {
      yield path.join(dir, entry.name)
    }
  }
}

const violations = []
for await (const file of (async function* () {
  for (const dir of SCAN_DIRS) yield* walk(dir)
})()) {
  const rel = path.relative(ROOT, file)
  if (ALLOWLIST.includes(rel)) continue
  const content = await readFile(file, 'utf8')
  const lines = content.split('\n')

  for (const rule of RULES) {
    // 带 scope 的规则只作用于特定目录（可给多个）
    if (rule.scope) {
      const posix = rel.split(path.sep).join('/')
      const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope]
      if (!scopes.some((scope) => posix.startsWith(scope))) continue
    }
    lines.forEach((line, index) => {
      // 跳过注释行：规范文档里会引用这些反面写法
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
      if (rule.pattern.test(line)) {
        violations.push({ file: rel, line: index + 1, rule: rule.id, hint: rule.hint, code: trimmed.slice(0, 100) })
      }
    })
  }
}

if (violations.length) {
  process.stderr.write('隔离契约静态检查未通过：\n\n')
  for (const v of violations) {
    process.stderr.write(`  ✗ ${v.file}:${v.line}  [${v.rule}]\n    ${v.code}\n    → ${v.hint}\n\n`)
  }
  process.stderr.write(`共 ${violations.length} 处。详见 docs/ISOLATION-CONTRACT.md\n`)
  process.exit(1)
}

process.stdout.write(`隔离契约静态检查通过（${RULES.length} 条规则）\n`)
