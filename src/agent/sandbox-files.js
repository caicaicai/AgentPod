/**
 * 把 pi 的 write / read / edit 三个文件工具打到沙盒。
 *
 * ── 为什么必须有 ────────────────────────────────────────────────────
 *
 * pi 内置的这三个工具默认在 **agent 进程里**读写文件，多租户下等于把别人的
 * 临时目录和服务配置交给模型，所以被 `noTools:'builtin'` 全关了（隔离契约 #2）。
 * 关掉之后模型手里只剩 `bash`，于是"把脚本放进沙盒再跑"这件事只能写成：
 *
 *     cat > analyze.py <<'PY'
 *     ...几十行代码...
 *     PY
 *
 * 这条路能走通，但代价很实在：脚本要经过模型的输出通道（占 token、受输出上限
 * 约束）、内容里出现分隔符就断、引号与 `$` 会被 shell 二次解释、二进制没法传。
 * 而"技能带一个脚本进沙盒执行"是**常规用法**，不是边角场景。
 *
 * ── 为什么复用 pi 的工具定义而不是自己造一个 ────────────────────────
 *
 * 与沙盒版 bash 同一个套路：pi 的 `createXxxToolDefinition(cwd, { operations })`
 * 把执行后端做成了注入点。复用它，工具名、schema、渲染都和模型早已熟悉的一致，
 * 换掉的只是"落到哪儿"。自己造一个 `sandbox_write` 则要模型重新学，
 * 而且和 `read`/`edit` 的配合关系也得重新表达。
 */
import path from 'node:path'

/** 按扩展名判图片。沙盒里的产物大多是脚本与文本，认不出就当文本处理。 */
const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
}

/**
 * 沙盒里工作区的绝对路径 —— **模型 `pwd` 看到的那个**。
 *
 * 镜像 sandbox-worker `src/namespace/slot-pool.js` 的 `GUEST_MOUNT_POINT` + `/work`。
 * 那边也是写死的常量（slot 私有 mount namespace 里的挂载点，每个槽位都一样），
 * 但它没有出现在租约响应里，所以这里只能跟着写一份。真要改，两边一起改；
 * `test/sandbox-files.test.js` 里有用例守着这个值。
 */
export const SANDBOX_WORKSPACE_ROOT = '/sandbox-root/work'

/**
 * 把 pi 解析出来的绝对路径换算成**相对沙盒工作区**的路径。
 *
 * pi 会先用 `resolveToCwd(path, cwd)` 把模型给的路径解析成绝对路径，而那个 cwd
 * 是 agent 本地的临时目录（run-turn.js 里 mkdtemp 出来的），沙盒里并不存在。
 * 两边靠"相对工作区根"这个约定对齐。
 *
 * ── 为什么要认两个根 ──────────────────────────────────────────────
 *
 * 模型手里同时有两个"绝对路径"，而且**都是我们给的**：
 *   - 系统提示末尾的 `Current working directory: /var/folders/.../workspace`（agent 侧）
 *   - 它自己 `pwd` 看到的 `/sandbox-root/work`（沙盒侧）
 *
 * 只认第一个的后果在真实会话里出现过：模型 `pwd` 之后老老实实用了沙盒路径，
 * 被我们回了"路径超出沙盒工作区"—— 它按事实办事，却撞在我们的实现细节上。
 * 两个根都认，指向的本来就是同一个目录。
 *
 * 两个都不落在里面时**必须报错**：那是模型在试 `/etc/passwd` 这类路径。
 * 静默改写成工作区内的某个路径更糟 —— 模型会以为自己读到了那个文件。
 */
export function toWorkspaceRelative(absolutePath, cwd) {
  const candidates = [path.relative(cwd, absolutePath)]

  // 沙盒侧的路径永远是 posix 的（worker 只跑 linux）。显式判前缀而不是直接
  // posix.relative()：后者遇到相对路径会拿 process.cwd() 去解析，结果取决于
  // agent 进程启动在哪儿 —— 那是个不该进来的变量。
  const posixPath = absolutePath.split(path.sep).join('/')
  if (posixPath === SANDBOX_WORKSPACE_ROOT || posixPath.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`)) {
    candidates.push(path.posix.relative(SANDBOX_WORKSPACE_ROOT, posixPath))
  }

  for (const relative of candidates) {
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) return relative
  }
  throw new Error(
    `路径超出沙盒工作区：${absolutePath}`
    + `（工作区根是 ${SANDBOX_WORKSPACE_ROOT}，直接用相对路径即可，例如 "out/data.json"）`,
  )
}

/**
 * 给 pi 的 write / read / edit 用的 operations。
 *
 * 三个工具用到的方法合起来就这几个：
 *   write → mkdir, writeFile
 *   read  → access, detectImageMimeType, readFile
 *   edit  → access, readFile, writeFile
 */
export function createSandboxFileOperations({ sandbox, cwd }) {
  const rel = (absolutePath) => toWorkspaceRelative(absolutePath, cwd)

  return {
    /**
     * 建父目录。**有意是空操作**：worker 的写入接口本身就 `mkdir -p` 了父目录
     * （见 sandbox-worker/src/server.js 的 `POST /files`），这里再发一次请求
     * 只是多一个来回。`test/sandbox-files.test.js` 里有用例守着
     * "write 到多层子目录能成功"，worker 那边真要改了会红。
     */
    async mkdir() {},

    async writeFile(absolutePath, content) {
      await sandbox.putFile({ path: rel(absolutePath), content })
    },

    /** 无 encoding 时回 Buffer（pi 读图片走这条），传了就按编码解字符串 */
    async readFile(absolutePath, encoding) {
      const file = await sandbox.getFile({ path: rel(absolutePath) })
      return encoding ? file.content.toString(encoding) : file.content
    },

    /** pi 用它判存在性：不存在就抛，与 fs.access 的语义一致 */
    async access(absolutePath) {
      await sandbox.statFile({ path: rel(absolutePath) })
    },

    detectImageMimeType(absolutePath) {
      return IMAGE_MIME_BY_EXT[path.extname(absolutePath).toLowerCase()] || null
    },
  }
}
