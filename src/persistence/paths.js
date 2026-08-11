/**
 * 路径收口与原子落地。
 *
 * 这三个函数是**所有**按 username 分目录的存储的共同底座（会话、memory、项目、定时任务、
 * 用户工作空间）。刻意抽出来而不是各写一份：它们做的是安全边界，一旦有两份实现，
 * 迟早只改了其中一份 —— 而"越界检查漏了一处"这种事从日志里根本看不出来。
 *
 * 原来只有 src/workspace/store.js 有这套，现在它也从这里取。
 */
import path from 'node:path'
import { mkdir, writeFile, rename } from 'node:fs/promises'

/**
 * username / sessionKey / 技能名 都会成为一段路径。它们来自服务端认证或经过
 * HTTP 层的字符集校验，但"来源可信"和"内容适合当路径"是两回事 —— 收口成一个明确
 * 字符集，再叠一道解析后的边界检查。两道独立防线，任一条单独成立都够用。
 */
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/

export function assertSegment(value, what) {
  const text = String(value || '')
  if (text === '.' || text === '..' || !SEGMENT_RE.test(text)) {
    throw new Error(`${what} 不能作为目录名：只允许字母、数字、点、下划线、连字符，且不超过 64 字符`)
  }
  return text
}

/**
 * 解析之后再校验边界。
 *
 * 在原始字符串里找 `..` 是不行的 —— 编码、多重分隔符、平台差异都能绕过去。
 * `path.resolve` 把这些都摊平了，检查结果落在哪儿才是可靠的。
 */
export function safeJoin(root, ...parts) {
  const resolved = path.resolve(root, ...parts)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`路径越界：${parts.join('/')} 解析后跑出了 ${root}`)
  }
  return resolved
}

/**
 * 原子落地：先写临时文件再 rename。
 *
 * 两个理由，都不是洁癖：
 *   1. 共享盘上多副本并发时，读到的永远是完整内容，不会是写了一半的 JSON；
 *   2. 进程被 SIGKILL / 机器掉电时，坏掉的是那个临时文件，不是用户的会话。
 */
export async function writeAtomic(target, content, tag = 'w') {
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${tag}-${process.pid}`
  await writeFile(tmp, content)
  await rename(tmp, target)
}

/** 某个用户的数据根。所有按 username 隔离的存储都从这里开叉 */
export function userRoot(dataDir, username) {
  assertSegment(username, 'username')
  return safeJoin(dataDir, 'users', username)
}
