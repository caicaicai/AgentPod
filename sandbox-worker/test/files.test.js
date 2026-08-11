/**
 * 工作区文件接口。
 *
 * 从前只有"写一个 / 读一个"，"命令产出了什么"只能靠 `ls` 的文本输出去猜，
 * 取一份 30 MB 的产物要在 worker 里变成三份内存（Buffer + base64 + JSON 串）。
 *
 * **不需要 namespace**：这些接口跑在 worker 自己的进程里，操作的是 host 视角的
 * 工作区目录（见 leases.js 顶部注释），与隔离无关。所以用一个建了真实临时目录的
 * 假 slot 池，任何机器都能跑 —— 路径逃逸这种必须每次都验的东西，
 * 不该只在有 CAP_SYS_ADMIN 的机器上才跑得到。
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { createLeaseManager } from '../src/leases.js'
import { createServer } from '../src/server.js'
import { createEgressPolicyStore } from '../src/egress-policy.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger } }
const TOKEN = 'files-test-token-0123456789'

/** 假 slot 池，但工作区是**真的目录** —— 文件接口操作的就是它 */
function fakeSlotPool(root, total = 2) {
  const free = Array.from({ length: total }, (_, i) => i)
  return {
    acquire() {
      const index = free.shift()
      if (index === undefined) return null
      const base = path.join(root, `slot${index}`)
      return {
        index,
        hostWorkspace: { workDir: path.join(base, 'work'), baseDir: base, homeDir: path.join(base, 'home'), tmpDir: path.join(base, 'tmp') },
        guest: { workDir: '/work', homeDir: '/home/job', tmpDir: '/tmp' },
      }
    },
    async release(index) { free.push(index) },
    status: () => ({ slots: [], egress: { extraAllowed: [] } }),
  }
}

describe('工作区文件接口', () => {
  let root
  let config
  let manager
  let app
  let baseUrl
  let leaseId
  let workDir

  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sbx-files-'))
    config = loadConfig({
      NODE_ENV: 'test',
      SANDBOX_TOKEN: TOKEN,
      SANDBOX_SLOTS: '2',
      SANDBOX_ADVERTISE_BASE: 'http://127.0.0.1:0',
      MAX_FILE_BYTES: '65536',
      MAX_FILE_BATCH: '5',
      MAX_LIST_ENTRIES: '10',
    })
    const pool = fakeSlotPool(root)
    manager = createLeaseManager({ config, logger: silentLogger, slotPool: pool })
    app = createServer({
      config, logger: silentLogger, leaseManager: manager, slotPool: pool,
      egressPolicy: createEgressPolicyStore({ config, logger: silentLogger }),
    })
    const address = await app.listen(0)
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    await manager.releaseAll('test')
    await app.close()
    await rm(root, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await manager.releaseAll('reset')
    const res = await fetch(`${baseUrl}/v1/leases`, {
      method: 'POST', headers: auth, body: JSON.stringify({ runId: 'r', username: 'e' }),
    })
    const body = await res.json()
    leaseId = body.leaseId
    workDir = manager.get(leaseId).workspace.rootDir
    await mkdir(workDir, { recursive: true })
  })

  const api = (suffix, init = {}) => fetch(`${baseUrl}/v1/leases/${leaseId}${suffix}`, { headers: auth, ...init })
  const post = (suffix, payload) => api(suffix, { method: 'POST', body: JSON.stringify(payload) })

  async function seed(files) {
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(workDir, rel)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
    }
  }

  describe('列目录', () => {
    test('回结构化条目，按名字排序，类型正确', async () => {
      await seed({ 'b.txt': 'bb', 'a.txt': 'a', 'sub/c.txt': 'ccc' })
      const body = await (await api('/files/list')).json()
      assert.equal(body.ok, true)
      assert.deepEqual(body.items.map((i) => i.name), ['a.txt', 'b.txt', 'sub'])
      assert.equal(body.items[0].kind, 'file')
      assert.equal(body.items[0].size, 1)
      assert.equal(body.items[2].kind, 'directory')
      assert.ok(body.items[0].mtimeMs > 0)
    })

    test('默认不递归、不含隐藏项；显式打开才有', async () => {
      await seed({ '.hidden': 'x', 'sub/deep.txt': 'y' })
      const plain = await (await api('/files/list')).json()
      assert.deepEqual(plain.items.map((i) => i.name), ['sub'])

      const full = await (await api('/files/list?recursive=1&includeHidden=1')).json()
      const names = full.items.map((i) => i.name)
      assert.ok(names.includes('.hidden'))
      assert.ok(names.includes('deep.txt'))
    })

    test('超过上限时截断，并且明确说自己截断了', async () => {
      // 静默截断会让调用方以为看到了全部 —— node_modules 递归下来轻松十万条。
      const files = {}
      for (let i = 0; i < 25; i += 1) files[`f${i}.txt`] = 'x'
      await seed(files)

      const body = await (await api('/files/list')).json()
      assert.equal(body.items.length, config.files.maxListEntries)
      assert.equal(body.truncated, true)
    })

    test('目标是文件时明确报错，不是回空列表', async () => {
      await seed({ 'a.txt': 'a' })
      const res = await api('/files/list?path=a.txt')
      assert.equal(res.status, 400)
      assert.equal((await res.json()).error, 'not-a-directory')
    })
  })

  describe('stat 与裸流下载', () => {
    test('stat 回类型、大小、修改时间', async () => {
      await seed({ 'a.bin': Buffer.from([1, 2, 3, 4]) })
      const body = await (await api('/files/stat?path=a.bin')).json()
      assert.equal(body.kind, 'file')
      assert.equal(body.size, 4)
    })

    test('raw 下载字节完全一致，且带上类型与文件名', async () => {
      // base64 那条路要把整个文件读进内存再 JSON 化，一份产物变三份内存。
      const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 0, 10, 13])
      await seed({ 'out/结果.png': bytes })

      const res = await api(`/files/raw?path=${encodeURIComponent('out/结果.png')}`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/png')
      // 文件名来自用户，必须编码后再进响应头
      assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''/)
      const got = Buffer.from(await res.arrayBuffer())
      assert.deepEqual(got, bytes, '下载回来的字节和原文件不一致')
    })

    test('认不出扩展名就当二进制，不瞎猜', async () => {
      await seed({ 'x.weirdext': 'hello' })
      const res = await api('/files/raw?path=x.weirdext')
      assert.equal(res.headers.get('content-type'), 'application/octet-stream')
    })

    test('超过上限的文件拒绝下载而不是把 worker 撑爆', async () => {
      await seed({ 'big.bin': Buffer.alloc(config.files.maxBytes + 1) })
      assert.equal((await api('/files/raw?path=big.bin')).status, 413)
    })
  })

  describe('mkdir 与删除', () => {
    test('mkdir 递归建目录', async () => {
      const res = await post('/files/mkdir', { path: 'a/b/c' })
      assert.equal(res.status, 200)
      assert.ok(existsSync(path.join(workDir, 'a/b/c')))
    })

    test('删目录必须显式开递归', async () => {
      // 默认递归的话一个手误就能删掉命令跑了十分钟的产物。
      await seed({ 'dir/x.txt': 'x' })
      const refused = await api('/files?path=dir', { method: 'DELETE' })
      assert.equal(refused.status, 400)
      assert.equal((await refused.json()).error, 'directory-needs-recursive')
      assert.ok(existsSync(path.join(workDir, 'dir')))

      const ok = await api('/files?path=dir&recursive=1', { method: 'DELETE' })
      assert.equal(ok.status, 200)
      assert.equal(existsSync(path.join(workDir, 'dir')), false)
    })

    test('删工作区根被拒 —— 那会把 slot 的挂载点掏空', async () => {
      for (const p of ['.', './', 'sub/..']) {
        const res = await api(`/files?path=${encodeURIComponent(p)}&recursive=1`, { method: 'DELETE' })
        assert.equal(res.status, 400, `${p} 应当被拒`)
        assert.equal((await res.json()).error, 'cannot-delete-workspace-root')
      }
      assert.ok(existsSync(workDir))
    })

    test('删不存在的路径是幂等的', async () => {
      const res = await api('/files?path=nope.txt', { method: 'DELETE' })
      assert.equal(res.status, 200)
      assert.equal((await res.json()).deleted, false)
    })
  })

  describe('批量读写', () => {
    test('一次写多个文件', async () => {
      const res = await post('/files/batch', {
        files: [
          { path: 'x/1.txt', contentBase64: Buffer.from('one').toString('base64') },
          { path: 'x/2.txt', contentBase64: Buffer.from('two').toString('base64') },
        ],
      })
      assert.equal(res.status, 200)
      assert.equal((await res.json()).count, 2)
      assert.equal(await readFile(path.join(workDir, 'x/2.txt'), 'utf8'), 'two')
    })

    test('其中一条路径非法时，一个都不落盘', async () => {
      // 部分成功的工作区比整体失败难排查得多：调用方以为写进去了，
      // 后面的命令读到的却是上一轮的残留或者根本没有。
      const res = await post('/files/batch', {
        files: [
          { path: 'good.txt', contentBase64: Buffer.from('g').toString('base64') },
          { path: '../escape.txt', contentBase64: Buffer.from('bad').toString('base64') },
        ],
      })
      assert.equal(res.status, 400)
      assert.equal(existsSync(path.join(workDir, 'good.txt')), false, '非法条目之前的文件不该已经落盘')
    })

    test('超过条数上限被拒', async () => {
      const files = Array.from({ length: config.files.maxBatch + 1 }, (_, i) => ({
        path: `n${i}.txt`, contentBase64: 'eA==',
      }))
      const res = await post('/files/batch', { files })
      assert.equal(res.status, 400)
      assert.equal((await res.json()).error, 'too-many-files')
    })

    test('批量读逐条报错，不因为缺一个就整批失败', async () => {
      // 批量读常用来"把这几个可能存在的产物取回来"，全军覆没会逼调用方退回逐个读。
      await seed({ 'have.txt': 'yes' })
      const body = await (await post('/files/read', { paths: ['have.txt', 'missing.txt'] })).json()
      assert.equal(body.count, 2)
      assert.equal(body.files[0].ok, true)
      assert.equal(Buffer.from(body.files[0].contentBase64, 'base64').toString(), 'yes')
      assert.equal(body.files[1].ok, false)
      assert.equal(body.files[1].error, 'file-not-found')
    })
  })

  describe('路径逃逸在每一个接口上都挡得住', () => {
    // 新加接口最容易漏的就是这一条，所以逐个都验。
    const ESCAPES = ['../outside.txt', '/etc/passwd', 'sub/../../outside.txt']

    test('读 / stat / raw / list', async () => {
      for (const p of ESCAPES) {
        const q = encodeURIComponent(p)
        for (const suffix of [`/files?path=${q}`, `/files/stat?path=${q}`, `/files/raw?path=${q}`, `/files/list?path=${q}`]) {
          const res = await api(suffix)
          assert.equal(res.status, 400, `${suffix} 没挡住`)
        }
      }
    })

    test('写 / mkdir / 批量 / 删除', async () => {
      for (const p of ESCAPES) {
        assert.equal((await post('/files', { path: p, contentBase64: 'eA==' })).status, 400, `写 ${p} 没挡住`)
        assert.equal((await post('/files/mkdir', { path: p })).status, 400, `mkdir ${p} 没挡住`)
        assert.equal((await post('/files/batch', { files: [{ path: p, contentBase64: 'eA==' }] })).status, 400, `批量写 ${p} 没挡住`)
        assert.equal((await post('/files/read', { paths: [p] })).status, 400, `批量读 ${p} 没挡住`)
        const del = await api(`/files?path=${encodeURIComponent(p)}&recursive=1`, { method: 'DELETE' })
        assert.equal(del.status, 400, `删 ${p} 没挡住`)
      }
      assert.equal(existsSync(path.join(root, 'outside.txt')), false)
    })
  })
})

/**
 * 通过接口写进工作区的东西，属主必须是这个 slot 的 job uid。
 *
 * worker 以 root 跑、job 降权到 slot 专属 uid 跑。`mkdir`/`writeFile` 默认造出
 * root 属主的文件与目录，job **读得到、执行得了，就是写不了** —— 于是
 * "技能脚本往自己目录里写缓存""建 skills/.venv 软链接"这类操作一律 EACCES，
 * 而 ls/cat/python 全都正常，症状极具迷惑性。真实沙盒里就是这么被绊住的。
 *
 * slot-pool.js 建工作区时早就显式 chown 了（那里的注释写着"不能指望目录权限
 * 顺便对了"），只有接口这条写入路径漏了。
 */
const CAN_CHOWN = typeof process.getuid === 'function' && process.getuid() === 0

describe('接口写入的属主归 job', { skip: CAN_CHOWN ? false : '需要 root 才能 chown 给别的 uid' }, () => {
  const JOB_UID = 20001
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

  let root
  let manager
  let app
  let baseUrl
  let leaseId
  let workDir

  /** 带 uid/gid 的假 slot —— 真实 slot-pool 就是这么报的 */
  function ownedSlotPool(base) {
    const free = [0]
    return {
      acquire() {
        const index = free.shift()
        if (index === undefined) return null
        const slotBase = path.join(base, `slot${index}`)
        return {
          index,
          uid: JOB_UID,
          gid: JOB_UID,
          hostWorkspace: { workDir: path.join(slotBase, 'work'), baseDir: slotBase, homeDir: path.join(slotBase, 'home'), tmpDir: path.join(slotBase, 'tmp') },
          guest: { workDir: '/work', homeDir: '/home/job', tmpDir: '/tmp' },
        }
      },
      async release(index) { free.push(index) },
      status: () => ({ slots: [], egress: { extraAllowed: [] } }),
    }
  }

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sbx-own-'))
    const config = loadConfig({
      NODE_ENV: 'test', SANDBOX_TOKEN: TOKEN, SANDBOX_SLOTS: '1',
      SANDBOX_ADVERTISE_BASE: 'http://127.0.0.1:0', MAX_FILE_BATCH: '10',
    })
    const pool = ownedSlotPool(root)
    manager = createLeaseManager({ config, logger: silentLogger, slotPool: pool })
    app = createServer({
      config, logger: silentLogger, leaseManager: manager, slotPool: pool,
      egressPolicy: createEgressPolicyStore({ config, logger: silentLogger }),
    })
    const address = await app.listen(0)
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    await manager.releaseAll('test')
    await app.close()
    await rm(root, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await manager.releaseAll('reset')
    const res = await fetch(`${baseUrl}/v1/leases`, {
      method: 'POST', headers: auth, body: JSON.stringify({ runId: 'r', username: 'e' }),
    })
    leaseId = (await res.json()).leaseId
    workDir = manager.get(leaseId).workspace.rootDir
    await mkdir(workDir, { recursive: true })
  })

  const post = (suffix, payload) => fetch(`${baseUrl}/v1/leases/${leaseId}${suffix}`, {
    method: 'POST', headers: auth, body: JSON.stringify(payload),
  })

  const b64 = (s) => Buffer.from(s).toString('base64')
  const ownerOf = async (rel) => {
    const { stat } = await import('node:fs/promises')
    const info = await stat(path.join(workDir, rel))
    return info.uid
  }

  test('单文件写入：文件和它的父目录都归 job', async () => {
    const res = await post('/files', { path: 'skills/demo/run.sh', contentBase64: b64('echo hi') })
    assert.equal(res.status, 200)

    assert.equal(await ownerOf('skills/demo/run.sh'), JOB_UID, '文件不是 job 属主 —— 脚本改不了自己')
    assert.equal(await ownerOf('skills/demo'), JOB_UID, '目录不是 job 属主 —— 里面一个文件都建不了')
    assert.equal(await ownerOf('skills'), JOB_UID, '中间层目录漏了 chown')
  })

  test('批量写入：每一层新建的目录都归 job', async () => {
    const res = await post('/files/batch', {
      files: [
        { path: 'skills/a/scripts/x.py', contentBase64: b64('x') },
        { path: 'skills/b/scripts/y.py', contentBase64: b64('y') },
      ],
    })
    assert.equal(res.status, 200)

    for (const rel of ['skills', 'skills/a', 'skills/a/scripts', 'skills/a/scripts/x.py', 'skills/b/scripts/y.py']) {
      assert.equal(await ownerOf(rel), JOB_UID, `${rel} 不是 job 属主`)
    }
  })

  test('mkdir 接口建的目录也归 job', async () => {
    assert.equal((await post('/files/mkdir', { path: 'out/reports' })).status, 200)
    assert.equal(await ownerOf('out'), JOB_UID)
    assert.equal(await ownerOf('out/reports'), JOB_UID)
  })

  test('已存在的目录不动它的属主', async () => {
    // job 自己建的目录（这里用另一个 uid 冒充），接口不该顺手改掉
    const { chown } = await import('node:fs/promises')
    await mkdir(path.join(workDir, 'mine'), { recursive: true })
    await chown(path.join(workDir, 'mine'), 20002, 20002)

    await post('/files', { path: 'mine/f.txt', contentBase64: b64('x') })

    assert.equal(await ownerOf('mine'), 20002, '接口把已存在目录的属主改了')
    assert.equal(await ownerOf('mine/f.txt'), JOB_UID, '新文件仍应归 job')
  })
})
