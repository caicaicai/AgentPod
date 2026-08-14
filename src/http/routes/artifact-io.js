/**
 * 作品文件的下发。**只有这一个出口。**
 *
 * 抽成独立模块正是为了守住下面那条不变量：登录态那条路（/v1/artifacts/:id/raw）
 * 和分享那条路（/v1/public/shares/:token/raw）共用这一份实现。
 *
 * 分享功能上线时这段逻辑差点被复制一份，而复制出来的那份迟早只改了其中一边 ——
 * 那种漏洞从日志里一点也看不出来。现在它们连 import 的都是同一个函数，
 * 想让两条路走岔都做不到。
 */
import { artifactFileName, artifactDisposition } from '../../artifacts/store.js'
import { Errors } from '../../errors.js'

/**
 * 下发作品里的**单个文件的原文**。登录态那条路和分享那条路共用这一份。
 *
 * ⚠️ **无论什么后缀，一律 `text/plain`。** 这里躺着的是模型生成的 HTML：
 * 用 `text/html` 回，这个 URL 就成了一个**同源**的、内容由模型（也就可能由
 * 一封诱导邮件）决定的页面 —— 它能读走 localStorage 里的登录令牌。
 * 预览走的是另一条路：文件进 JSON，由前端拼好后塞进不带 allow-same-origin 的
 * sandbox iframe（见 web/src/modules/artifacts/artifact-view.js）。
 * 所以这条不变量很值钱：**本服务从不以 HTML 的身份吐出任何模型生成的内容。**
 *
 * 抽成一个函数正是为了守住它：分享功能上线时这段逻辑差点被复制一份，
 * 而复制出来的那份迟早只改了其中一边 —— 那种漏洞从日志里一点也看不出来。
 */
export function sendArtifactFile(res, { current, wanted, download }) {
  const target = wanted || current.meta.entry
  const file = current.files.find((item) => item.path === target)
  if (!file) throw Errors.notFound(`第 ${current.version} 版没有 ${target}`)

  const body = Buffer.from(file.content, 'utf8')
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    // 没有它，浏览器会去嗅探内容，一段 HTML 照样能被当页面渲染 ——
    // 上面那条不变量就白写了
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': artifactDisposition({
      fileName: artifactFileName({ title: current.meta.title, entry: file.path }),
      download: Boolean(download),
    }),
    'Cache-Control': 'no-store',
  })
  return res.end(body)
}
