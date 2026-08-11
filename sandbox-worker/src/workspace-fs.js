/**
 * 工作区文件访问的收口。**这是一条安全边界，不是工具函数集合。**
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 *
 * `/v1/leases/:id/files*` 这一组接口是在 **worker 进程里**执行的，而 worker 是
 * root，跑在宿主的 mount namespace 里；`lease.workspace.rootDir` 是宿主上的真实
 * 路径（`leases.js` 的 `workspaceFromSlot`）。也就是说这组接口的越界检查失守一次，
 * 拿到的就是"以 root 身份读写整台 worker"。
 *
 * 而原来的检查只是**词法**的：`path.resolve` 之后判前缀。它挡得住 `../`，
 * 挡不住软链接 —— 工作区是 bind mount 进 slot 的，slot 里的 job 用自己的 uid
 * 就能在里面 `ln -s / esc`，然后让模型调 `read esc/任意路径`。词法检查看到的是
 * `<root>/esc/任意路径`，规规矩矩落在工作区内，于是放行；真正解析路径的是内核，
 * 它跟着软链接走出去了。同一个节点上别的用户的 slot 工作区、worker 自己的
 * `/proc/self/environ`（里面是 SANDBOX_TOKEN 与 SANDBOX_TICKET_SECRET）全在射程内。
 *
 * ── 为什么不是"realpath 之后再判一次前缀" ──────────────────────────
 *
 * 那是 check-then-use，中间有窗口，而**这个窗口是攻击者能主动撑开的**：沙盒里
 * 允许后台进程，一个 `while true; do rm -rf d; ln -s /别人 d; mkdir d; done` 就能
 * 一直摇，模型那边反复调 read/write 撞点。判定与使用之间只要还有间隙，这条路就
 * 是通的。
 *
 * ── 实际做法：逐段打开，每一段都 O_NOFOLLOW ────────────────────────
 *
 * 从工作区根开始，一段一段地 `open()`，每次都带 `O_NOFOLLOW` —— 那一段只要是
 * 软链接，内核直接回 ELOOP，没有"解析出来再判断"这一步，也就没有窗口。
 *
 * Linux 上再加一层：下一段是通过 `/proc/self/fd/<上一段的fd>/<名字>` 打开的，
 * 也就是 openat(2) 的等价写法。父目录的 **inode 已经被 fd 钉住**，攻击者之后把
 * 那个名字改指到哪儿都影响不到我们手里这个引用。这样整条路径的解析全程race-free。
 *
 * 非 Linux（开发机跑单测）没有 `/proc/self/fd`，退化成"按累积路径逐段 O_NOFOLLOW
 * 打开"：软链接一样一段都过不去，只是少了钉住 inode 那层，理论上仍有竞态。
 * worker 只跑 Linux（见 `executor.js` 的 nsenter），所以生产上走的一定是钉住的那条。
 *
 * ── 附带的收益 ──────────────────────────────────────────────────────
 *
 * 属主（chown）也从"按路径 chown"换成了 `FileHandle.chown()`，也就是 fchown ——
 * 对着已经打开的那个 inode 改，同样不再有"chown 的时候路径已经不是刚才那个"的问题。
 *
 * ── 已知的语义变化 ──────────────────────────────────────────────────
 *
 * 工作区里的软链接**一律不能穿过**了，包括指回工作区内部的。技能目录下那根
 * `skills/.venv`（`src/agent/skill-materializer.js` 的 `linkVenv`，指向镜像里的
 * `/opt/ap/venv`）就属于这一类：经它读文件会得到 400。这不影响功能 ——
 * 那根软链接是给 slot 里 `nsenter` 执行的脚本用的（那条路不经过本文件），
 * 而 `/files/list` 本来就不递归进软链接、`syncBack` 本来就只收 `kind === 'file'`。
 */
import { open, mkdir, lstat, rm } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import path from 'node:path'

const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_DIRECTORY, O_NOFOLLOW } = constants

/**
 * 能不能把父目录钉住。只在模块加载时探一次：这是平台属性，不会中途变。
 * worker 的 `/healthz` 会把它报出来，免得"以为是钉住的其实不是"只能靠猜。
 */
export const PINNED_WALK = existsSync('/proc/self/fd')

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 })
}

/** 打不开的原因里，哪些该当成"这个路径不存在"而不是"被拒绝" */
function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

const SYMLINK_REFUSED = 'path 里有软链接：工作区内的文件接口不跟随软链接（要跨目录请用命令行）'

/**
 * 打不开的时候才去问"为什么"。
 *
 * **判定仍然是 `open()` 做的**（O_NOFOLLOW，没有窗口），这一步只负责把错误翻译成
 * 人话。之所以不能直接按 errno 分类：各平台对"O_DIRECTORY 撞上软链接"的取值不一致
 * —— Linux 回 ELOOP，macOS 回 ENOTDIR，而 ENOTDIR 在别处是正常的"这一段不是目录"。
 * 靠 errno 分的话，逃逸尝试会在某个平台上被静静地报成"文件不存在"，
 * 既误导调用方，也让日志里看不出有人在试。
 *
 * 反过来漏判是安全的：lstat 说不是软链接、open 却还是失败，那就照原样抛 —— 失败即拒绝。
 */
async function explain(at, error, { wantDir = false } = {}) {
  const info = await lstat(at).catch(() => null)
  if (info?.isSymbolicLink()) return badRequest(SYMLINK_REFUSED)
  if (error?.code === 'ELOOP') return badRequest(SYMLINK_REFUSED)
  // 请求的是目录、那儿却是个普通文件。这要和"没有这个路径"分开报（400 而不是 404）：
  // "你指的东西不是目录"和"你指的东西不存在"，调用方的下一步完全不同。
  if (wantDir && info && !info.isDirectory()) {
    return Object.assign(new Error('not-a-directory'), { status: 400, code: 'NOT_A_DIRECTORY' })
  }
  return error
}

/**
 * 没钉住父目录时（非 Linux 的退化路径）的事后校验。
 *
 * 逐段 O_NOFOLLOW 保证了"打开的那一刻每一段都不是软链接"，但两次 open 之间攻击者
 * 仍能把中间目录换掉。这里在**拿到最终 fd 之后**再验两件事：
 *
 *   1. 现在整条链上没有一段是软链接 —— 换上去还没撤走的情况在这里露馅；
 *   2. 手里这个 fd 的 inode 与按路径 lstat 出来的是同一个 —— 换完又撤走的情况在这里露馅。
 *
 * 两条都要满足才放行。攻击者要同时骗过，得在自己工作区里造一个指向目标的**硬链接**，
 * 而目标要么属于别的 uid、要么在 0700 目录里，够不着。
 *
 * **诚实的边界**：这是"事后发现并拒绝"，不是"事前阻止"。读没问题（内容还没交出去），
 * 写则是文件已经被 O_CREAT|O_TRUNC 落下去了才发现 —— 赢了竞态的那一次仍然改到了
 * 目标文件，我们只能报错，收不回来。
 *
 * Linux（生产）不走这里：父目录被 fd 钉住之后，压根没有"两次 open 之间"这回事，
 * 也就没有这个残留。所以 `/healthz` 的 `pinnedWalk` 必须是 true。
 */
async function verifyUnpinnedChain(rootDir, segments, handle) {
  let current = rootDir
  for (const segment of segments) {
    current = path.join(current, segment)
    const info = await lstat(current).catch(() => null)
    if (!info) throw badRequest('path 在读写过程中被改动了')
    if (info.isSymbolicLink()) throw badRequest(SYMLINK_REFUSED)
  }
  const opened = await handle.stat()
  const now = await lstat(current).catch(() => null)
  if (!now || now.ino !== opened.ino || now.dev !== opened.dev) {
    throw badRequest('path 在读写过程中被改动了')
  }
}

/**
 * 词法层的第一道：非空、必须相对、`..` 拉平之后仍在工作区内。
 *
 * 逐段 O_NOFOLLOW 已经能独立挡住越界了，这一道仍然留着 —— 两道独立防线，
 * 任一条单独成立都够用，而且它给出的报错（"path 逃出了工作区"）比
 * 内核回的 ENOENT 有用得多。
 */
export function resolveInWorkspace(rootDir, relative) {
  const raw = String(relative || '').trim()
  if (!raw) throw badRequest('path 必填')
  if (path.isAbsolute(raw)) throw badRequest('path 必须是相对工作区的路径')
  const resolved = path.resolve(rootDir, raw)
  if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) {
    throw badRequest('path 逃出了工作区')
  }
  return resolved
}

/** 把相对路径切成一段一段。`.` / 工作区根本身切出来是空数组 */
function segmentsOf(rootDir, relative) {
  const resolved = resolveInWorkspace(rootDir, relative)
  const rel = path.relative(rootDir, resolved)
  return rel ? rel.split(path.sep) : []
}

/**
 * 打开工作区根。
 *
 * **根这一段也要 O_NOFOLLOW。** `work/` 的父目录 `baseDir` 是 chown 给 slot uid 的
 * （`slot-pool.js` 的 `createHostWorkspace`），也就是说 job 有权在里面
 * `mv work work.bak && ln -s / work`。少了这个标志，逃逸的起点就在第一步。
 */
async function openRoot(rootDir) {
  const handle = await open(rootDir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    .catch(async (error) => { throw await explain(rootDir, error) })
  return { handle, path: PINNED_WALK ? `/proc/self/fd/${handle.fd}` : rootDir }
}

/**
 * 从工作区根逐段走到目标，返回打开着的那个引用。
 *
 * @param {object} options
 * @param {'file'|'dir'} options.kind 最后一段按文件还是目录打开
 * @param {boolean} options.create    路上缺的目录就建（写入路径用），最后一段按需 O_CREAT
 * @param {{uid:number,gid:number}|null} options.owner 新建的目录/文件归谁
 */
async function walk(rootDir, segments, { kind, create = false, owner = null }) {
  let ref = await openRoot(rootDir)
  try {
    for (let i = 0; i < segments.length; i += 1) {
      const last = i === segments.length - 1
      const at = path.join(ref.path, segments[i])
      let handle

      if (last && kind === 'file') {
        const flags = create ? O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW : O_RDONLY | O_NOFOLLOW
        handle = await open(at, flags, 0o644).catch(async (error) => { throw await explain(at, error) })
      } else {
        // 只有真的是我们建出来的才 chown。已存在的目录属主保持原样 ——
        // 改别人建的目录的属主，是在这条路径上又开一个我们并不需要的能力。
        const made = create
          ? await mkdir(at).then(() => true, (error) => {
            if (error.code === 'EEXIST') return false
            throw error
          })
          : false
        handle = await open(at, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
          .catch(async (error) => { throw await explain(at, error, { wantDir: true }) })
        if (made && owner) await handle.chown(owner.uid, owner.gid)
      }

      const next = { handle, path: PINNED_WALK ? `/proc/self/fd/${handle.fd}` : at }
      await ref.handle.close()
      ref = next
    }
    if (!PINNED_WALK) await verifyUnpinnedChain(rootDir, segments, ref.handle)
    return ref
  } catch (error) {
    await ref.handle.close().catch(() => {})
    throw error
  }
}

/** 包一层 close，调用方一律 try/finally 里调它 */
function confined(ref) {
  return {
    handle: ref.handle,
    /** 可以直接交给任何 fs 调用的安全路径（Linux 上是钉住父目录的 procfs 路径） */
    path: ref.path,
    close: () => ref.handle.close().catch(() => {}),
  }
}

/**
 * 打开工作区内的一个路径。
 *
 * @returns 打开着的引用；路径不存在时回 `null`（越界/软链接是抛，不是 null ——
 *          两者必须能被调用方区分开：前者该回 404，后者该回 400）
 */
export async function openConfined(rootDir, relative, { kind = 'file', create = false, owner = null } = {}) {
  const segments = segmentsOf(rootDir, relative)
  if (!segments.length && kind === 'file') throw badRequest('path 指向的是工作区根目录，不是文件')
  try {
    return confined(await walk(rootDir, segments, { kind, create, owner }))
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/**
 * 打开一个**已经钉住的目录**下的子目录，同样不跟随软链接。
 *
 * 递归列目录用。少了这一层的话，"lstat 说它是目录"和"readdir 真的去读它"之间
 * 又是一个窗口 —— 攻击者在那一瞬把子目录换成软链接，列出来的就是别人的文件名。
 * 内容不会泄，但文件名本身也是信息。
 *
 * @returns 打开着的引用；不是目录、不存在、或是软链接时回 `null`（列目录不该
 *          因为一个跳不进去的子项就整个失败）
 */
export async function openChildDir(dirPath, name) {
  try {
    const handle = await open(path.join(dirPath, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    return confined({ handle, path: PINNED_WALK ? `/proc/self/fd/${handle.fd}` : path.join(dirPath, name) })
  } catch {
    return null
  }
}

/**
 * 打开目标的**父目录**，并回上最后一段的名字。
 *
 * 给 lstat / rm 这类"要对着链接本身操作、不能跟着它走"的场景用：
 * 父目录被钉住之后，`path.join(dir.path, name)` 指的一定是工作区内的那一项。
 */
async function openParent(rootDir, relative) {
  const segments = segmentsOf(rootDir, relative)
  if (!segments.length) return { dir: null, name: '' }
  const name = segments.pop()
  try {
    return { dir: confined(await walk(rootDir, segments, { kind: 'dir' })), name }
  } catch (error) {
    if (isMissing(error)) return { dir: null, name, missing: true }
    throw error
  }
}

/** 读一个文件。大小上限在**打开之后**用 fstat 判，判的是真正读的那个 inode */
export async function readFileConfined(rootDir, relative, { maxBytes }) {
  const ref = await openConfined(rootDir, relative, { kind: 'file' })
  if (!ref) return { ok: false, error: 'file-not-found' }
  try {
    const info = await ref.handle.stat()
    if (!info.isFile()) return { ok: false, error: 'file-not-found' }
    if (info.size > maxBytes) return { ok: false, error: 'file-too-large', bytes: info.size }
    return { ok: true, content: await ref.handle.readFile(), bytes: info.size }
  } finally {
    await ref.close()
  }
}

/**
 * 落一个文件，连同为它新建的父目录一起归到 job 名下。
 *
 * chown 走 `FileHandle.chown()`（fchown）而不是按路径 chown：对着已经打开的
 * inode 改，不存在"chown 的时候这个路径已经指向别处了"。
 */
export async function writeFileConfined(rootDir, relative, content, owner) {
  const segments = segmentsOf(rootDir, relative)
  if (!segments.length) throw badRequest('path 指向的是工作区根目录，不是文件')
  const ref = confined(await walk(rootDir, segments, { kind: 'file', create: true, owner }))
  try {
    await ref.handle.writeFile(content)
    if (owner) await ref.handle.chown(owner.uid, owner.gid)
  } finally {
    await ref.close()
  }
}

/** 建目录（含中间层）。已存在不算错误 */
export async function mkdirConfined(rootDir, relative, owner) {
  const segments = segmentsOf(rootDir, relative)
  if (!segments.length) return
  const ref = confined(await walk(rootDir, segments, { kind: 'dir', create: true, owner }))
  await ref.close()
}

/** lstat 语义：软链接报它自己，不跟着走 */
export async function lstatConfined(rootDir, relative) {
  const { dir, name } = await openParent(rootDir, relative)
  if (!dir) {
    if (name) return null // 父目录都不在
    const ref = await openConfined(rootDir, '.', { kind: 'dir' })
    if (!ref) return null
    try { return await ref.handle.stat() } finally { await ref.close() }
  }
  try {
    return await lstat(path.join(dir.path, name)).catch((error) => {
      if (isMissing(error)) return null
      throw error
    })
  } finally {
    await dir.close()
  }
}

/**
 * 删。
 *
 * 对着钉住的父目录删那一项：目标本身是软链接时删掉的是链接，不是它指向的东西
 * （`rm` 的默认行为，这里靠父目录被钉住来保证"那一项"确实在工作区内）。
 */
export async function removeConfined(rootDir, relative, { recursive }) {
  const { dir, name } = await openParent(rootDir, relative)
  if (!dir) return { deleted: false }
  try {
    const target = path.join(dir.path, name)
    const info = await lstat(target).catch((error) => {
      if (isMissing(error)) return null
      throw error
    })
    if (!info) return { deleted: false }
    if (info.isDirectory() && !recursive) {
      throw Object.assign(new Error('directory-needs-recursive'), { status: 400, code: 'DIR_NEEDS_RECURSIVE' })
    }
    await rm(target, { recursive, force: true })
    return { deleted: true }
  } finally {
    await dir.close()
  }
}
