/**
 * 源码高亮的词法切分。
 *
 * 最要紧的一条在最前面：**切完拼起来必须原样等于输入**。
 * 着错色只是不好看；吞掉一个字符、或者把顺序弄反，用户复制走的源码就是坏的 ——
 * 而这种坏法极难被发现（看起来只是"颜色有点怪"）。所以每种语言、每个样本
 * 都过一遍这条断言。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { detectLanguage, tokenize } from '../web/src/lib/highlight.js'

/** 断言：拼回去 === 原文；顺带把片段类型交出去给别的断言用 */
function slice(code, lang) {
  const tokens = tokenize(code, lang)
  assert.equal(tokens.map((item) => item.text).join(''), code, `[${lang}] 拼回去必须等于原文`)
  return tokens
}

const typesOf = (tokens, text) => tokens.filter((item) => item.text === text).map((item) => item.t)

describe('拼回去等于原文（每种语言都过一遍）', () => {
  const samples = {
    js: 'const a = "x"; // 注释\nfunction go(n) { return n * 2 }\n/* 块注释 */\n`模板 ${a}`',
    markup: '<!doctype html>\n<!-- 注释 -->\n<div class="card" id=\'x\'>文本 & 符号</div>\n<img src="a.svg"/>',
    css: '.card { color: #fff; margin: 0 auto; /* 注释 */ }\n@media (max-width: 600px) { a { color: red } }',
    py: 'def go(n):\n    # 注释\n    s = "文本"\n    return [x for x in range(n) if x > 1]',
    sql: "SELECT a, count(*) FROM t WHERE name = 'x' -- 注释\nGROUP BY a",
    sh: 'set -e\n# 注释\nfor f in *.txt; do echo "$f"; done',
    yaml: 'name: 结算中台\nitems:\n  - a: 1\n  - b: true   # 注释',
    md: '# 标题\n\n> 引用\n\n- 一项 **加粗**\n\n```js\nconst a = 1\n```\n\n[链接](http://x)',
    text: '随便一段没有语言的文本 <> {} "" 也要原样拼回去',
  }

  for (const [lang, code] of Object.entries(samples)) {
    test(lang, () => { slice(code, lang) })
  }

  test('空串与超长文本都不炸', () => {
    assert.deepEqual(tokenize('', 'js'), [])
    const huge = 'x'.repeat(200_001)
    // 超过上限整段当普通文本 —— 着色一份几十万字符的文件只会让页面卡住
    assert.deepEqual(tokenize(huge, 'js'), [{ t: '', text: huge }])
  })

  test('中文、emoji、制表符原样保留', () => {
    const code = 'const 名字 = "张三 🎉"\n\t// 缩进用制表符'
    slice(code, 'js')
  })
})

describe('切得对不对', () => {
  test('js：关键字、字符串、注释、数字、函数名各归各类', () => {
    const tokens = slice('const n = 42 // hi\nfoo("s")', 'js')
    assert.deepEqual(typesOf(tokens, 'const'), ['word'])
    assert.deepEqual(typesOf(tokens, '42'), ['num'])
    assert.deepEqual(typesOf(tokens, '// hi'), ['com'])
    assert.deepEqual(typesOf(tokens, 'foo'), ['fn'])
    assert.deepEqual(typesOf(tokens, '"s"'), ['str'])
  })

  test('js：字符串里的关键字不着色（否则满屏乱闪）', () => {
    const tokens = slice('const s = "return const"', 'js')
    assert.deepEqual(typesOf(tokens, '"return const"'), ['str'])
    assert.equal(tokens.some((item) => item.t === 'word' && item.text === 'return'), false)
  })

  test('markup：标签、属性名、属性值分开', () => {
    const tokens = slice('<div class="a">x</div>', 'markup')
    assert.deepEqual(typesOf(tokens, '<div'), ['tag'])
    assert.deepEqual(typesOf(tokens, 'class'), ['attr'])
    assert.deepEqual(typesOf(tokens, '"a"'), ['str'])
    assert.deepEqual(typesOf(tokens, '</div'), ['tag'])
  })

  /**
   * `.vue` 最该看清楚的就是 `<script setup>` 那一段。不换规则的话，
   * 通篇当标记处理，一个关键字都不着色 —— 而 Vue 作品是这个页面的主要用途之一。
   */
  test('vue/html：<script> 与 <style> 内部换用对应规则', () => {
    const code = '<template><i /></template>\n<script setup>\nconst a = 1\n</script>\n<style>.x { color: red }</style>'
    const tokens = slice(code, 'markup')
    assert.deepEqual(typesOf(tokens, 'const'), ['word'], 'script 里的关键字要着色')
    assert.deepEqual(typesOf(tokens, 'color'), ['attr'], 'style 里的属性名要着色')
    assert.deepEqual(typesOf(tokens, '<template'), ['tag'])
  })

  test('sql：关键字大小写都认', () => {
    const upper = slice('SELECT a FROM t', 'sql')
    const lower = slice('select a from t', 'sql')
    assert.deepEqual(typesOf(upper, 'SELECT'), ['word'])
    assert.deepEqual(typesOf(lower, 'select'), ['word'])
  })

  test('py / sh / yaml 用 # 注释', () => {
    assert.deepEqual(typesOf(slice('x = 1 # hi', 'py'), '# hi'), ['com'])
    assert.deepEqual(typesOf(slice('echo x # hi', 'sh'), '# hi'), ['com'])
    assert.deepEqual(typesOf(slice('a: 1 # hi', 'yaml'), '# hi'), ['com'])
  })
})

describe('认语言', () => {
  test('按后缀认', () => {
    assert.equal(detectLanguage('index.html'), 'markup')
    assert.equal(detectLanguage('App.vue'), 'markup')
    assert.equal(detectLanguage('image.svg'), 'markup')
    assert.equal(detectLanguage('style.css'), 'css')
    assert.equal(detectLanguage('app.js'), 'js')
    assert.equal(detectLanguage('data.json'), 'js')
    assert.equal(detectLanguage('run.py'), 'py')
    assert.equal(detectLanguage('q.sql'), 'sql')
    assert.equal(detectLanguage('go.sh'), 'sh')
    assert.equal(detectLanguage('conf.yaml'), 'yaml')
    assert.equal(detectLanguage('README.md'), 'md')
    assert.equal(detectLanguage('diagram.mmd'), 'md')
  })

  /** kind=code 的作品里，语言是模型标出来的，文件名可能什么后缀都没有 */
  test('没后缀时用模型标的语言', () => {
    assert.equal(detectLanguage('Dockerfile', 'sh'), 'sh')
    assert.equal(detectLanguage('script', 'python'), 'py')
  })

  test('认不出来就当纯文本，不猜', () => {
    assert.equal(detectLanguage('data.bin'), 'text')
    assert.equal(detectLanguage(''), 'text')
  })
})
