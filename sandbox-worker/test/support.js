/**
 * 测试共用：探测当前机器有没有具备 namespace 隔离所需的能力。
 *
 * namespace 隔离是本 worker **唯一**的执行路径，没有旧的"直接 spawn"模式可退——
 * 所以 `sandbox.test.js`/`browser.test.js`/`namespace-isolation.test.js` 里
 * 所有牵涉真实执行（exec/浏览器）的用例都需要这个探测结果来决定是否跳过。
 *
 * 本地 macOS 开发机、大多数没开特权的 CI 容器会在这里跳过——这不是这些用例
 * 写错了，是运行环境本来就不满足前提条件。跳过要跳得清楚，见各测试文件里
 * `describe(..., { skip })` 的用法。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

let cached = null

export async function probeNamespaceSupport() {
  if (cached) return cached
  cached = await probe()
  return cached
}

async function probe() {
  if (process.platform !== 'linux') {
    return { ok: false, reason: `平台是 ${process.platform}，namespace 隔离依赖 Linux 内核特性（unshare/nsenter/network namespace）` }
  }
  try {
    await execFileAsync('unshare', ['--pid', '--mount', '--net', '--uts', '--ipc', '--fork', '--mount-proc', '--', '/bin/true'])
  } catch (error) {
    return { ok: false, reason: `unshare 全套 namespace 建不起来（缺 CAP_SYS_ADMIN/CAP_NET_ADMIN，或被 seccomp 拦截）：${error.message}` }
  }
  try {
    await execFileAsync('ip', ['link', 'add', '__nstest0', 'type', 'veth', 'peer', 'name', '__nstest1'])
    await execFileAsync('ip', ['link', 'del', '__nstest0'])
  } catch (error) {
    return { ok: false, reason: `建不了 veth pair（缺 CAP_NET_ADMIN 或没有 iproute2）：${error.message}` }
  }
  return { ok: true }
}
