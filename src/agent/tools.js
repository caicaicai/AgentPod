/**
 * 工具装配。
 *
 * 现状：只有沙盒版 bash。
 * 迁移 AP 能力时，其余工具从 modules/ap/extensions/* 搬过来注册在这里 ——
 * 好消息是签名几乎一致：openclaw 的 `api.registerTool({name,label,description,parameters,execute})`
 * 就是 pi `ToolDefinition` 的薄封装，`execute(toolCallId, params, signal, onUpdate, ctx)` 前两个参数完全对得上。
 *
 * 移植红线（隔离契约 #6）：**禁止模块级凭据缓存**。
 * 凭据一律通过 execute 的 ctx / 闭包里的 runContext 传入。
 */
import {
  createBashToolDefinition,
  createWriteToolDefinition,
  createReadToolDefinition,
  createEditToolDefinition,
} from '@mariozechner/pi-coding-agent'

import { createSandboxFileOperations, SANDBOX_WORKSPACE_ROOT } from './sandbox-files.js'
import { applyToolHooks } from '../tools/plugin-api.js'

/**
 * 三个文件工具的路径约定。
 *
 * 完整版在系统提示里（run-turn.js 的 workspacePrompt）。这里再放一句短的，
 * 理由和桥的用法挂在 bash 上一样：**模型是在填 `path` 参数的那一刻需要这条信息的**。
 */
const WORKSPACE_PATH_NOTE = [
  '',
  '',
  `路径直接用相对工作区根的形式（如 \`out/data.json\`）；工作区在沙盒里是 \`${SANDBOX_WORKSPACE_ROOT}\`。`,
  '系统提示末尾那行 `Current working directory` 是 agent 侧路径，沙盒里不存在，不要用它拼绝对路径。',
].join('\n')

/**
 * 把 bash 执行打到沙盒。保留 pi 的工具 schema 与渲染，只换执行后端
 * （BashOperations.exec 是 pi 官方给的注入点）。
 */
export function createSandboxBashOperations({ sandbox, runContext }) {
  return {
    async exec(command, cwd, options) {
      return sandbox.exec({
        runId: runContext.runId,
        username: runContext.username,
        command,
        cwd,
        signal: options.signal,
        /**
         * pi 的 `timeout` 单位是**秒**，沙盒这边要的是**毫秒**。
         *
         * ── 这一行曾经是 `timeout: options.timeout` ──────────────────────
         *
         * pi 的工具 schema 原文是 "Timeout in seconds (optional, no default timeout)"，
         * 它自带的执行器也是 `setTimeout(..., timeout * 1000)`。我们直接把它当毫秒用了，
         * 于是模型写 `timeout: 30`（想要 30 秒）→ worker 收到 30 **毫秒** → 命令在
         * python 解释器还没启动完的时候就被 SIGTERM 掉。
         *
         * 这个 bug 的表现极其难认，因为它**只影响带 timeout 参数的调用**：
         * `pwd`、`ls`、`echo` 这类模型不会加超时的命令一直是好的（走 SANDBOX_TIMEOUT_MS），
         * 一旦模型判断"这条可能慢，我加个超时"，那条就必挂。越是谨慎的模型死得越惨。
         * 而 30ms 正好卡在解释器启动的中间，成不成还带随机性 —— 于是看起来像"偶发"。
         *
         * 不传就是不传：让 client.js 回落到 SANDBOX_TIMEOUT_MS，别在这里编一个默认值。
         */
        timeoutMs: options.timeout > 0 ? options.timeout * 1000 : undefined,
        onData: options.onData,
        /**
         * `credentialEnv` 是唯一一处让用户凭据进入沙盒的口子：开了
         * SANDBOX_INJECT_ME_TOKEN 之后，用户的 me_token 会以 ME_TOKEN 进到这里。
         * 见 sandbox-credentials.js。
         */
        env: {
          ...(runContext.credentialEnv || {}),
          AP_RUN_ID: runContext.runId,
          AP_SKILL_LIBS_DIR: runContext.skillLibsDir || '',
        },
      })
    },
  }
}

/**
 * 组装这一次 run 可用的工具集。
 *
 * `apTools` 是从 `modules/ap/extensions/*` 移植过来的工具（见 src/tools/），
 * 它们的 execute 闭包里已经绑好了本 run 的上下文，所以工具集是 run 级的 ——
 * 不存在"共享一份工具、里面藏着别人凭据"的可能。
 *
 * @returns {Array} pi ToolDefinition[]
 */
export function buildTools({ cwd, sandbox, runContext, apTools = [], extraTools = [], toolHooks = null, logger = null }) {
  const tools = []

  if (sandbox && sandbox.mode !== 'none') {
    const bash = createBashToolDefinition(cwd, { operations: createSandboxBashOperations({ sandbox, runContext }) })
    // pi 原文只说 "Execute a bash command in the current working directory" —— 从没说过
    // current 是哪儿，模型只能先 `pwd` 问一次。直接写出来省掉这一趟。
    bash.description += `\n\n工作目录是沙盒工作区根 \`${SANDBOX_WORKSPACE_ROOT}\`，与 write/read/edit 是同一个目录。`
    tools.push(bash)

    /**
     * 文件工具同样打到沙盒。
     *
     * 没有它们，"把脚本放进沙盒再跑"只能写成 `cat > x.py <<'EOF'` —— 脚本要经过
     * 模型的输出通道（占 token、受输出上限约束），内容里出现分隔符就断，
     * 引号和 `$` 会被 shell 二次解释，二进制根本传不了。而技能带脚本进沙盒
     * 是常规用法，不是边角场景。
     *
     * 注意这里**不能**用 pi 的内置版本（`noTools:'builtin'` 关掉的就是它们）：
     * 那些在 agent 进程里读写文件，多租户下等于把别人的临时目录交给模型。
     */
    const fileOps = createSandboxFileOperations({ sandbox, cwd })
    for (const create of [createWriteToolDefinition, createReadToolDefinition, createEditToolDefinition]) {
      const tool = create(cwd, { operations: fileOps })
      tool.description += WORKSPACE_PATH_NOTE
      tools.push(tool)
    }
  }

  tools.push(...apTools)
  tools.push(...extraTools)

  /**
   * 插件钩子在**最后**统一套一遍，覆盖上面全部工具（含沙盒版 bash/read/write/edit）。
   *
   * openclaw 的 before_tool_call 就是全局的：ap-skills 靠它否决 `browser`——
   * 一个它自己没注册过的工具。只套在插件工具上等于悄悄改窄语义，
   * 而"钩子对某些工具不生效"从日志里看不出来。
   */
  return applyToolHooks(tools, toolHooks, { logger })
}
