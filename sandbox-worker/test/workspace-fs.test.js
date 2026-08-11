/**
 * 工作区文件访问的越界回归测试。
 *
 * 这里守的是一个**真实发生过**的洞：`/v1/leases/:id/files*` 跑在 worker（root）
 * 的宿主视角下，而越界检查只做了词法那一道（`path.resolve` 后判前缀）。它挡得住
 * `../`，挡不住软链接 —— 工作区是 bind mount 进 slot 的，job 在自己的工作区里
 * `ln -s / esc` 之后，`read esc/任意路径` 就成了"以 root 读整台 worker"：
 * 同节点其他用户的 slot 工作区、`/proc/self/environ` 里的 SANDBOX_TOKEN 与
 * SANDBOX_TICKET_SECRET 全在射程内。
 *
 * 所以下面的用例是**攻击视角**写的，不是"函数返回值对不对"：
 * 每一条都先把攻击场景搭出来（受害者的目录、指出去的软链接），再断言拿不到。
 *
 * 最后一条是竞态用例。它存在的理由是：如果修法选的是"realpath 之后再判一次前缀"，
 * 这条会挂 —— 判定与使用之间的窗口是攻击者能主动撑开的（沙盒里允许后台进程，
 * 一个 `while true` 就能一直摇）。绿灯说明我们用的是逐段 O_NOFOLLOW，不是 check-then-use。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, lstat, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  resolveInWorkspace,
  openConfined,
  readFileConfined,
  writeFileConfined,
  mkdirConfined,
  lstatConfined,
  removeConfined,
  PINNED_WALK,
} from '../src/workspace-fs.js'

/** 攻击者的工作区、受害者的工作区，外加一个"worker 自己的秘密" */
let workRoot
let attacker
let victim
let secretFile

before(async () => {
  workRoot = await mkdtemp(path.join(tmpdir(), 'ws-fs-'))
  attacker = path.join(workRoot, 'slot0-attacker', 'work')
  victim = path.join(workRoot, 'slot1-victim', 'work')
  await mkdir(attacker, { recursive: true })
  await mkdir(victim, { recursive: true })
  await writeFile(path.join(victim, 'salary.csv'), '受害者的工资表\n')
  secretFile = path.join(workRoot, 'worker.env')
  await writeFile(secretFile, 'SANDBOX_TOKEN=super-secret\n')
})

after(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

const BIG = { maxBytes: 1024 * 1024 }

describe('词法那一道（保持原有行为）', () => {
  test('../ 与绝对路径被挡住，正常相对路径放行', () => {
    const root = '/tmp/ws'
    assert.throws(() => resolveInWorkspace(root, '../../etc/passwd'), /逃出/)
    assert.throws(() => resolveInWorkspace(root, '/etc/passwd'), /相对/)
    assert.throws(() => resolveInWorkspace(root, ''), /必填/)
    assert.equal(resolveInWorkspace(root, 'a/b.txt'), '/tmp/ws/a/b.txt')
  })
})

describe('软链接逃逸（原漏洞）', () => {
  test('经软链接读别人的工作区：拒绝', async () => {
    await symlink(workRoot, path.join(attacker, 'esc'))

    // 词法检查会放行 —— 这正是原来那条路能走通的原因，先把它钉住
    assert.equal(
      resolveInWorkspace(attacker, 'esc/slot1-victim/work/salary.csv'),
      path.join(attacker, 'esc/slot1-victim/work/salary.csv'),
    )

    await assert.rejects(
      () => readFileConfined(attacker, 'esc/slot1-victim/work/salary.csv', BIG),
      /软链接/,
    )
  })

  test('经软链接读 worker 自己的秘密：拒绝', async () => {
    await assert.rejects(() => readFileConfined(attacker, 'esc/worker.env', BIG), /软链接/)
  })

  test('软链接直接指向文件本身也拒绝（最后一段）', async () => {
    await symlink(secretFile, path.join(attacker, 'direct.env'))
    await assert.rejects(() => readFileConfined(attacker, 'direct.env', BIG), /软链接/)
  })

  test('经软链接往别人的工作区写文件：拒绝，且对方目录里不留东西', async () => {
    await assert.rejects(
      () => writeFileConfined(attacker, 'esc/slot1-victim/work/planted.txt', Buffer.from('x'), null),
      /软链接/,
    )
    await assert.rejects(() => lstat(path.join(victim, 'planted.txt')), /ENOENT/)
  })

  test('经软链接 mkdir：拒绝', async () => {
    await assert.rejects(() => mkdirConfined(attacker, 'esc/slot1-victim/work/mine', null), /软链接/)
    await assert.rejects(() => lstat(path.join(victim, 'mine')), /ENOENT/)
  })

  test('经软链接删别人的文件：拒绝，文件还在', async () => {
    await assert.rejects(
      () => removeConfined(attacker, 'esc/slot1-victim/work/salary.csv', { recursive: false }),
      /软链接/,
    )
    assert.equal((await readFile(path.join(victim, 'salary.csv'))).toString(), '受害者的工资表\n')
  })

  test('列目录不跟着软链接跑出去', async () => {
    // 拒绝要和"没有这个目录"分得开：前者是 400（你在试不该试的），后者是 404
    await assert.rejects(() => openConfined(attacker, 'esc', { kind: 'dir' }), /软链接/)
  })

  test('删软链接本身是允许的：删掉的是链接，不是它指向的东西', async () => {
    await symlink(secretFile, path.join(attacker, 'tolink'))
    const result = await removeConfined(attacker, 'tolink', { recursive: false })
    assert.equal(result.deleted, true)
    assert.ok((await readFile(secretFile)).toString().includes('super-secret'), '指向的文件必须还在')
  })

  test('工作区根本身被换成软链接也逃不掉', async () => {
    const swapped = path.join(workRoot, 'slot2-swapped', 'work')
    await mkdir(path.dirname(swapped), { recursive: true })
    await symlink(workRoot, swapped)
    await assert.rejects(() => readFileConfined(swapped, 'worker.env', BIG), /软链接/)
  })
})

describe('正常用法不受影响', () => {
  test('写 → 读 → 列 → 删，多层子目录也行', async () => {
    await writeFileConfined(attacker, 'out/deep/data.json', Buffer.from('{"ok":true}'), null)
    const read = await readFileConfined(attacker, 'out/deep/data.json', BIG)
    assert.equal(read.ok, true)
    assert.equal(read.content.toString(), '{"ok":true}')

    const info = await lstatConfined(attacker, 'out/deep/data.json')
    assert.equal(info.isFile(), true)

    assert.equal((await removeConfined(attacker, 'out', { recursive: true })).deleted, true)
    assert.equal(await lstatConfined(attacker, 'out'), null)
  })

  test('不存在的路径回 null（是 404 不是 400）', async () => {
    assert.equal(await openConfined(attacker, 'nope/nothing.txt', { kind: 'file' }), null)
    assert.equal((await readFileConfined(attacker, 'nope.txt', BIG)).error, 'file-not-found')
    assert.equal((await removeConfined(attacker, 'nope.txt', { recursive: false })).deleted, false)
  })

  test('目录要删得显式开递归', async () => {
    await mkdirConfined(attacker, 'somedir', null)
    await assert.rejects(
      () => removeConfined(attacker, 'somedir', { recursive: false }),
      (error) => error.code === 'DIR_NEEDS_RECURSIVE',
    )
    await removeConfined(attacker, 'somedir', { recursive: true })
  })

  test('超过上限的文件不读进内存', async () => {
    await writeFileConfined(attacker, 'big.bin', Buffer.alloc(4096), null)
    const result = await readFileConfined(attacker, 'big.bin', { maxBytes: 1024 })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'file-too-large')
    assert.equal(result.bytes, 4096)
  })
})

/**
 * 竞态：攻击者在后台不停地把一个目录换成软链接再换回来，模型这边反复读。
 *
 * check-then-use 的实现（先 realpath 判一次、再按路径打开）在这条用例下会**偶尔**
 * 读到受害者的文件 —— 而"偶尔"对攻击者来说完全够用，他可以一直摇。
 * 逐段 O_NOFOLLOW 没有这个窗口：要么这一段不是软链接、正常打开，要么是软链接、
 * 内核直接 ELOOP。所以断言是"一次都不许读到"。
 */
describe('竞态：目录被反复换成软链接', () => {
  /**
   * 两条循环都**必须有硬性上界**（时间 + 次数），而且摇的那条每轮显式让出事件循环。
   *
   * 这条用例会被两个 runner 跑到：worker 自己的 `npm test` 是 `--test-concurrency=1`，
   * 而仓库根的 `node --test` 是全并行 —— 几十个测试文件抢 libuv 那 4 个线程。
   * 第一版没有上界、也不让出，在根目录那条路上把整个套件拖到跑不完
   * （表现是"卡住"，不是失败，最难查的那种）。
   */
  test('一次都不许读到别人的文件', { timeout: 60_000 }, async () => {
    const racer = path.join(workRoot, 'slot3-racer', 'work')
    await mkdir(path.join(racer, 'd'), { recursive: true })
    await writeFile(path.join(racer, 'd', 'x.txt'), '我自己的\n')

    const deadline = Date.now() + 2000
    let stop = false
    const flip = (async () => {
      const real = path.join(racer, 'd')
      const parked = path.join(racer, 'd.real')
      while (!stop && Date.now() < deadline) {
        await rename(real, parked).catch(() => {})
        await symlink(victim, real).catch(() => {})
        await rm(real, { force: true }).catch(() => {})
        await rename(parked, real).catch(() => {})
        // 让出一轮，别把线程池吃干净（并行 runner 下会拖垮别的测试文件）
        await new Promise((resolve) => setImmediate(resolve))
      }
    })()

    let leaked = 0
    let refused = 0
    let normal = 0
    for (let i = 0; i < 200 && Date.now() < deadline; i += 1) {
      try {
        const result = await readFileConfined(racer, 'd/salary.csv', BIG)
        // 换成软链接的那一瞬读到了受害者的文件 —— 这就是洞
        if (result.ok) leaked += 1
        else normal += 1
      } catch (error) {
        // 软链接被挡下、或事后校验发现路径被换过，都是拒绝
        if (/软链接|被改动/.test(error.message)) refused += 1
        else throw error
      }
    }
    stop = true
    await flip

    assert.equal(leaked, 0, `竞态下读到了 ${leaked} 次受害者的文件`)
    assert.ok(normal + refused > 0, '一次都没跑起来，这条用例没在测东西')
  })

  test('生产（Linux）必须是钉住父目录的那条路径', () => {
    if (process.platform !== 'linux') return
    assert.equal(PINNED_WALK, true, 'Linux 上 /proc/self/fd 必须可用，否则少了防竞态那一层')
  })
})
