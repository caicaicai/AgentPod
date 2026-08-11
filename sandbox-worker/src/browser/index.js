/**
 * 浏览器管理：**每个 slot 一个 Chromium 进程**，常驻在该 slot 的私有
 * PID/mount/network namespace 里（降权到 slot 的 uid），随 slot 一起预热、
 * 随 slot 回收一起销毁——保持"零冷启动"的前提下，把浏览器也纳入了隔离边界。
 * 一个租约一个 BrowserContext（cookie/storage/cache 按租约隔离），宿主 Chromium
 * 进程是 slot 私有的、跨租约复用的（同一个 slot 被下一个租约认领时还是同一个进程，
 * 只有 slot 被销毁重建时才重新拉起）。
 *
 * 落地方式：Playwright 的 `launch()` 只接受一个可执行文件路径，不支持直接传
 * "用 nsenter 包一层"这种需求，所以给每个 slot 生成一个一次性的 wrapper 脚本，
 * 把真实的 Chromium 可执行文件包在 `nsenter --setuid/--setgid` 后面，
 * 让 Playwright 以为自己在启动一个普通程序。
 */
import { writeFile, mkdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BrowserSession } from './session.js'
import { loadPlaywright } from './load-playwright.js'
import { nsenterForkArgs } from '../namespace/nsenter-compat.js'
import { buildCgroupJoinScript } from '../namespace/cgroup.js'

const VIEWPORT = { width: 1440, height: 900 }

function chromiumArgs(config) {
  return [
    // 容器里没有 /dev/shm 的足够空间，不加这条 Chromium 会随机崩
    '--disable-dev-shm-usage',
    // 默认仍关掉 Chromium 自己的沙盒——降权 + namespace 之后理论上可以不关，
    // 但两层沙盒嵌套（Chromium 自己也用 PID/user namespace）有已知兼容性坑，
    // 需要先在目标环境实测，所以默认保守，`BROWSER_INNER_SANDBOX=1` 才打开。
    ...(config.browser.innerSandbox ? [] : ['--no-sandbox']),
    '--disable-gpu',
  ]
}

/**
 * 给某个 slot 生成/复用一个 nsenter wrapper 脚本，Playwright 拿它当"可执行文件"启动。
 *
 * `--fork` 是否要传，走 [nsenter-compat.js](../namespace/nsenter-compat.js) 的探测结果——
 * 与 executor.js 同一个坑：这个 flag 在 util-linux 版本之间语义不一致，
 * 硬编码在某些机器上会让 nsenter 直接报"unrecognized option"退出。
 *
 * 脚本开头先把自己写进 slot 的 cgroup，再 exec —— Chromium 是这个 slot 里最能吃
 * 内存的常驻进程，不进 cgroup 的话 `memory.max` 对它完全不起作用，一个页面就能
 * 把整个 worker 容器拖垮。理由与 executor.js 的 `buildSlotInvocation` 相同：
 * 必须在 exec 之前自己写，事后由 worker 搬会漏掉已经 fork 出去的渲染进程。
 */
async function ensureSlotLaunchWrapper({ slot, realExecutablePath }) {
  const dir = path.join(tmpdir(), 'ap-sandbox-chromium-wrappers')
  await mkdir(dir, { recursive: true })
  const wrapperPath = path.join(dir, `slot-${slot.index}.sh`)
  const forkArgs = nsenterForkArgs().join(' ')
  const joinCgroup = buildCgroupJoinScript(slot.cgroup?.procsFiles || [])
  const script = [
    '#!/bin/sh',
    '# 自动生成，见 sandbox-worker/src/browser/index.js ensureSlotLaunchWrapper',
    ...(joinCgroup ? [joinCgroup] : []),
    // Playwright 会**以 worker 的身份（root）**先建一个临时 profile 目录，再把
    // --user-data-dir=<该目录> 传给"可执行文件"（也就是这个 wrapper）。而 nsenter
    // 紧接着就把 Chromium 降权到 slot 的 uid —— 它写不进一个 root 拥有的 0700 目录，
    // 于是 Chromium 直接 abort：
    //   Failed to create /tmp/playwright_chromiumdev_profile-xxx/SingletonLock:
    //   Permission denied → Failed to create a ProcessSingleton ... Aborting now
    // 这一步还在 root 身份下，正好可以把 profile 目录交给即将接手的那个 uid。
    'for __arg in "$@"; do',
    '  case "$__arg" in',
    `    --user-data-dir=*) chown -R ${slot.uid}:${slot.gid} "\${__arg#--user-data-dir=}" 2>/dev/null ;;`,
    '  esac',
    'done',
    `exec nsenter --target ${slot.sentinel.pid} --pid --mount --net --uts --ipc ${forkArgs} \\`,
    `  --setuid ${slot.uid} --setgid ${slot.gid} \\`,
    `  -- ${realExecutablePath} "$@"`,
    '',
  ].join('\n')
  await writeFile(wrapperPath, script, { mode: 0o755 })
  await chmod(wrapperPath, 0o755)
  return wrapperPath
}

export function createBrowserManager({ config, logger }) {
  let playwright = null
  let resolvingPlaywright = null

  const slotBrowsers = new Map() // index -> { browser, launching }

  async function ensurePlaywright() {
    if (playwright) return playwright
    if (!resolvingPlaywright) {
      // 解析细节与那个"包明明装了却说找不到"的坑，见 load-playwright.js
      resolvingPlaywright = loadPlaywright().catch((error) => {
        resolvingPlaywright = null
        throw error
      })
    }
    playwright = await resolvingPlaywright
    return playwright
  }

  async function ensureSlotBrowser(slot) {
    const existing = slotBrowsers.get(slot.index)
    if (existing?.browser?.isConnected()) return existing.browser
    if (existing?.launching) return existing.launching

    const launching = (async () => {
      const pw = await ensurePlaywright()
      const realPath = config.browser.executablePath || pw.chromium.executablePath()
      const wrapperPath = await ensureSlotLaunchWrapper({ slot, realExecutablePath: realPath })
      logger.info('启动 Chromium（slot 私有）', { slotIndex: slot.index, headless: config.browser.headless })
      const browser = await pw.chromium.launch({
        headless: config.browser.headless,
        executablePath: wrapperPath,
        env: { HOME: slot.guest.homeDir, TMPDIR: slot.guest.tmpDir },
        args: chromiumArgs(config),
      })
      browser.on('disconnected', () => {
        logger.warn('slot 的 Chromium 连接断开', { slotIndex: slot.index })
        slotBrowsers.delete(slot.index)
      })
      slotBrowsers.set(slot.index, { browser, launching: null })
      return browser
    })()

    slotBrowsers.set(slot.index, { browser: existing?.browser || null, launching })
    return launching
  }

  return {
    get available() {
      return config.browser.enabled
    },

    /**
     * 给一个租约开浏览器会话——用租约绑定的 slot 私有 Chromium。
     * @param {object} params.slot 租约绑定的 slot（必填）
     * @param {string[]} params.cookies Playwright 的 cookie 数组，见 server.js 的说明
     */
    async createSession({ leaseId, username, cookies = [], userAgent = '', slot }) {
      if (!config.browser.enabled) throw new Error('本 worker 未启用浏览器能力（BROWSER_ENABLED=0）')
      if (!slot) throw new Error('createSession 需要一个有效的 slot（namespace 隔离是唯一的执行路径）')
      const instance = await ensureSlotBrowser(slot)
      const context = await instance.newContext({
        viewport: VIEWPORT,
        ignoreHTTPSErrors: config.browser.ignoreHttpsErrors,
        ...(userAgent ? { userAgent } : {}),
      })
      if (cookies.length) await context.addCookies(cookies)
      logger.info('浏览器会话已建立', { leaseId, username, cookieCount: cookies.length, slotIndex: slot.index })
      return new BrowserSession({ context, logger, leaseId, username })
    },

    /** slot 被回收（sentinel 即将销毁重建）前必须调用——否则这个 Chromium 进程变成没人管的孤儿 */
    async closeBrowserForSlot(index) {
      const entry = slotBrowsers.get(index)
      if (!entry) return
      slotBrowsers.delete(index)
      const browser = entry.browser || (await entry.launching?.catch(() => null))
      if (browser) await browser.close().catch(() => {})
    },

    async shutdown() {
      const indexes = [...slotBrowsers.keys()]
      await Promise.all(indexes.map((index) => this.closeBrowserForSlot(index)))
    },

    status() {
      return {
        enabled: config.browser.enabled,
        running: slotBrowsers.size > 0,
        slotBrowsers: slotBrowsers.size,
      }
    },
  }
}
