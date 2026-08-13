/**
 * 路径收口（persistence/paths.js）。
 *
 * username / sessionKey / 技能名都会成为一段真实路径 —— 用户工作空间那套仍然是
 * 磁盘上的文件（见 src/workspace/store.js），所以这两个函数还在承重。
 * 它们测的是"坏了会安静地坏"的地方：越界检查必须在**解析之后**做，
 * 在原始字符串里找 `..` 会被编码和多重分隔符绕过去。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { assertSegment, safeJoin } from '../src/persistence/paths.js'

describe('路径收口', () => {
  test('越界的段名一律拒绝', () => {
    for (const bad of ['..', '.', 'a/b', '../etc', '', 'a'.repeat(65), 'a b']) {
      assert.throws(() => assertSegment(bad, 'x'), /不能作为目录名/, `应拒绝：${JSON.stringify(bad)}`)
    }
  })

  test('safeJoin 在解析之后判边界 —— 编码与多重分隔符都摊平了才算数', () => {
    /**
     * 根要先 `resolve` 一次。
     *
     * safeJoin 内部拿 `path.resolve(root, ...)` 的结果去比 `root` 前缀，所以传进去的
     * root 必须已经是**本平台的绝对路径**。直接写 `'/data'` 在 Windows 上会解析成
     * `C:\data\a\b`，而前缀比的是字面量 `/data` —— 于是一次完全正常的拼接被判成越界，
     * 报错还是"路径越界：a/b"，看着像被测代码有 bug。
     */
    const ROOT = path.resolve('/data')
    assert.throws(() => safeJoin(ROOT, '..', 'other'), /路径越界/)
    assert.throws(() => safeJoin(ROOT, 'a/../../b'), /路径越界/)
    assert.equal(safeJoin(ROOT, 'a', 'b'), path.join(ROOT, 'a', 'b'))
  })
})

/**
 * 这里曾经还有「文件版 Map」与「按 username 分区」两块。
 * 它们测的是 src/persistence/file-map.js —— 本服务只支持 MySQL 之后那个文件删掉了，
 * 等价的性质由 test/storage-drivers.test.js 的契约用例覆盖（替身 + 真库各跑一遍）。
 *
 * 上面这块留着：assertSegment / safeJoin 仍然在用（用户工作空间那套还是真实文件）。
 */
