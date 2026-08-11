/**
 * 加载 playwright。
 *
 * 单独一个文件，是因为这件事有个不显眼但会整块打掉浏览器能力的坑：
 *
 * 底包里 playwright 是 `npm install -g` 装的，靠 `NODE_PATH=/usr/local/lib/node_modules`
 * 让它可被解析。**但 NODE_PATH 只对 CommonJS 的 require() 生效，ESM 的 import
 * 完全不看它** —— 而本项目是 `"type": "module"`。所以 `import('playwright')`
 * 会失败并报：
 *
 *     Cannot find package 'playwright' imported from .../src/browser/index.js
 *     Did you mean to import ".../node_modules/playwright/index.js"?
 *
 * 那句 "Did you mean" 提示指向的正是 NODE_PATH 里的路径 —— Node **找到了**这个包，
 * 只是拒绝用它满足 ESM 导入。这也是这个错看起来自相矛盾的原因：包明明在那儿。
 *
 * playwright 本身是 CJS 包，所以用 createRequire 走 CJS 解析链就能拿到它，
 * 连传递依赖（playwright-core）也照常解析 —— require 是从真实路径往上找
 * node_modules，全局目录本身就叫 node_modules，正好命中。
 *
 * 两条路都试：ESM 优先（正常安装的镜像走这条，不依赖 NODE_PATH 这种老机制），
 * 失败再退到 CJS（全局安装的镜像走这条）。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** 两条路都失败时，把两个原因都带上 —— 只报一个会让人往错的方向查。 */
export async function loadPlaywright() {
  let esmError
  try {
    const mod = await import('playwright')
    return mod?.default ?? mod
  } catch (error) {
    esmError = error
  }

  try {
    return require('playwright')
  } catch (cjsError) {
    throw new Error(
      '浏览器能力不可用：加载 playwright 失败。\n' +
        `  ESM import 失败：${esmError?.message?.split('\n')[0] || esmError}\n` +
        `  CJS require 失败：${cjsError?.message?.split('\n')[0] || cjsError}\n` +
        '  Dockerfile 里应当装好 playwright 与 chromium，见 sandbox-worker/Dockerfile。',
    )
  }
}
