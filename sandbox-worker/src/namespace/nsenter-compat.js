/**
 * `nsenter --fork` 在不同 util-linux 版本之间的语义不一致，实测踩过一次坑：
 *
 *   - 较早版本：带 `-p/--pid` 进新 PID namespace 时**默认不 fork**——不 fork
 *     就直接 execve() 替换自己，目标命令保留调用者原来的 PID，根本不会真正
 *     成为新 PID namespace 里的成员。必须显式传 `--fork` 才能让它先 fork
 *     一个子进程再 exec，子进程才是新 namespace 的合法成员。
 *   - 较新版本（本仓库在真实容器节点上实测到的版本）：带 `-p` 时**默认就会
 *     fork**，`--fork` 反而是未识别的参数——`nsenter: unrecognized option
 *     '--fork'`，整条命令直接失败，什么都没跑起来。这个版本只提供
 *     `-F/--no-fork` 用来关掉默认的 fork 行为。
 *
 * 两种版本用同一份硬编码参数是不可能同时兼容的，所以在真正调用前探测一次
 * `nsenter --help`，缓存结果：如果帮助文本里明确列出了 `--fork`（而不是
 * `--no-fork`），说明这个版本需要显式传；否则就不传，让默认行为生效。
 *
 * 用 `bin/check-namespace-caps.sh` 能在部署前验证这个探测结果对不对——
 * 它现在会分别测"传 --fork"和"不传 --fork"两条路径。
 */
import { execFileSync } from 'node:child_process'

let cachedForkFlagArgs

/**
 * @returns {string[]} 应该拼进 nsenter 参数列表的 fork 相关 flag——
 *   要么是 `['--fork']`，要么是 `[]`（依赖默认行为）
 */
export function nsenterForkArgs() {
  if (cachedForkFlagArgs) return cachedForkFlagArgs
  cachedForkFlagArgs = detectForkArgs()
  return cachedForkFlagArgs
}

/**
 * 纯函数，方便单测：根据 `nsenter --help` 的文本判断要不要传 `--fork`。
 * "--no-fork" 不包含子串 "--fork"（中间少一个连字符），所以这个判断本身
 * 就能正确区分"这个版本列出了独立的 --fork 选项"与"只列出了 --no-fork"。
 */
export function parseForkSupport(helpText) {
  return String(helpText || '').includes('--fork') ? ['--fork'] : []
}

function detectForkArgs() {
  let help = ''
  try {
    help = execFileSync('nsenter', ['--help'], { encoding: 'utf8' })
  } catch (error) {
    // --help 在部分极简发行版上可能走 stderr 且以非 0 退出，execFileSync 会抛——
    // 把 stdout/stderr 都捞出来看一眼，拿不到就保守地不传，好过传一个可能
    // 不存在、直接把整条命令搞挂的 flag。
    help = `${error?.stdout || ''}${error?.stderr || ''}`
  }
  return parseForkSupport(help)
}

/** 仅供测试用：重置缓存，避免用例之间互相污染探测结果 */
export function _resetNsenterForkCache() {
  cachedForkFlagArgs = undefined
}
