/**
 * MEMORY.md 的行语法。
 *
 * ── 为什么 memory 是一个 markdown 文件而不是一张表 ──────────────────────
 *
 * 因为它最终要**进模型的系统提示**。存成结构化记录，读的时候还得拼回一段文字；
 * 而拼装规则一旦和写入规则分开，两边就会慢慢走偏。直接存成模型能读的样子，
 * "存了什么"和"它看到什么"永远是同一件事 —— 用户点开也能自己改。
 *
 * 格式就一条规则：**一条事实一行 `- (YYYY-MM-DD) 内容`**。
 * 日期是抓取日期，用来判断新旧、也用来去重。
 *
 * 语法集中在这个文件，是为了让"什么算一条事实"只有一个定义 —— 抓取、去重、
 * 检索、整理四条路径都从这里取，不会出现"写进去的格式检索认不出来"。
 */

/** 一次带进系统提示的上限。超了从**头部**开始丢：新的事实更可能仍然成立 */
export const RECALL_MAX_CHARS = 6000

export function isBullet(line) {
  const trimmed = line.trimStart()
  return trimmed.startsWith('- ') || trimmed.startsWith('* ')
}

export function bulletText(line) {
  return line.trimStart().replace(/^[-*]\s*/, '').trim()
}

export function bullets(body) {
  return String(body || '').split('\n').filter(isBullet).map(bulletText)
}

/** 抓取日期。没有就返回空串（手写进去的行不强制带日期） */
export function captureDate(text) {
  return /^\((\d{4}-\d\d-\d\d)\)/.exec(text)?.[1] || ''
}

/**
 * 去重用的归一化形式：抹掉行首符号、日期、大小写与首尾空白。
 * 同一件事在不同日子被抓到两次，应该算同一条 —— 否则一个月后 MEMORY.md
 * 里会是三十条"用户偏好简短回复"。
 */
export function normalize(line) {
  return String(line || '')
    .replace(/^[-*]\s*/, '')
    .replace(/^\(\d{4}-\d\d-\d\d\)\s*/, '')
    .trim()
    .toLowerCase()
}

export function dateStr(at) {
  // 本地时区：memory 是给人看的，用 UTC 会让"今天记的"显示成昨天
  const date = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 截尾部保留：留最近的那一段 */
export function capTail(text, maxChars) {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text
}
