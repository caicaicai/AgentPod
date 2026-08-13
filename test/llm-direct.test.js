/**
 * LLM_MODE=direct：直连一个 OpenAI 兼容端点做真模型联调。
 *
 * 为什么要有它：从前只有 platform（真模型，但要连内网 llminfo + 真 SSO）和 faux
 * （假模型，不推理）。本地想验证"真模型到底会不会用这些技能"时，前者常常连不上、
 * 后者答非所问 —— 于是"端到端测过了"这句话里，最关键的那一环恰恰是假的。
 *
 * 这里守住两件事：模型清单确实来自配置；**生产必须拒绝启动**。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { loadConfig } from '../src/config.js'
import { createDirectBroker } from '../src/credentials/broker.js'
import { toClientFrames } from '../src/agent/events.js'

const BASE = {
  LLM_MODE: 'direct',
  LLM_DIRECT_BASE_URL: 'https://gw.example.com/v1/',
  LLM_DIRECT_API_KEY: 'sk-test',
  LLM_DIRECT_MODEL: 'Qwen/Qwen2.5-72B-Instruct, gpt-4o-mini',
  SANDBOX_MODE: 'none',
  // AUTH_MODE 的默认值是 password，而它要求 CONSOLE_USERS —— 不显式给一个，
  // 每条用例都会在读到 llm.direct.* 之前就被配置校验拦下
  AUTH_MODE: 'dev',
  // MYSQL_* 现在是必填的（本服务只支持数据库存储），不给就过不了配置校验
  MYSQL_HOST: 'db.example', MYSQL_USER: 'ap', MYSQL_DATABASE: 'ap',
}
const cfg = (extra = {}) => loadConfig({ cwd: '/nonexistent', env: { ...BASE, ...extra } })

describe('LLM_MODE=direct 配置', () => {
  test('模型名逗号分隔，且**保留大小写**', () => {
    // 大小写敏感：Qwen/Qwen2.5-72B-Instruct 被压成小写之后网关就认不出来了。
    // 配置里另有一个会转小写的 csv（给域名白名单用），别混用。
    assert.deepEqual(cfg().llm.direct.models, ['Qwen/Qwen2.5-72B-Instruct', 'gpt-4o-mini'])
  })

  test('baseUrl 末尾斜杠去掉 —— OpenAI SDK 自己会拼 /chat/completions', () => {
    assert.equal(cfg().llm.direct.baseUrl, 'https://gw.example.com/v1')
  })

  test('缺 base URL 或模型名都拒绝启动', () => {
    assert.throws(() => cfg({ LLM_DIRECT_BASE_URL: '' }), /LLM_DIRECT_BASE_URL/)
    assert.throws(() => cfg({ LLM_DIRECT_MODEL: '' }), /LLM_DIRECT_MODEL/)
  })

  test('base URL 必须是绝对地址', () => {
    assert.throws(() => cfg({ LLM_DIRECT_BASE_URL: 'gw.example.com' }), /必须是 http/)
  })

  test('不配 key 也允许 —— 有些内网网关按来源 IP 放行', () => {
    assert.equal(cfg({ LLM_DIRECT_API_KEY: '' }).llm.direct.apiKey, '')
  })

  test('生产环境必须拒绝：一把共用的静态 key 会抹掉用户之间的计费与审计边界', () => {
    assert.throws(
      () => cfg({ NODE_ENV: 'production', AUTH_MODE: 'sso', DEV_CONSOLE: '0' }),
      /生产环境禁止 LLM_MODE=direct/,
    )
  })
})

describe('direct broker', () => {
  test('按配置回模型清单，第一个是默认模型', async () => {
    const broker = createDirectBroker({ config: cfg(), tickets: { issue: () => ({}), revoke() {} } })
    const access = await broker.getLlmAccess({ username: 'zhangsan' })
    assert.equal(access.models.length, 2)
    assert.equal(access.models[0].model, 'Qwen/Qwen2.5-72B-Instruct')
    assert.equal(access.models[0].server, 'https://gw.example.com/v1')
    assert.equal(access.models[0].key, 'sk-test')
  })
})

describe('tool_result 带输出预览', () => {
  /**
   * 从前只回一个 isError 布尔值，前端只能显示"成功/失败"。
   * 而"技能到底跑出了什么"才是判断它有没有真的工作的唯一依据 ——
   * 只看到一排绿勾，分不清"真跑通了"和"工具被调了但返回一堆空"。
   */
  const frames = (event) => {
    const out = []
    toClientFrames(event, (type, data) => out.push({ type, data }))
    return out
  }

  test('字符串结果原样带出来', () => {
    const [f] = frames({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: 'Linux\n20000\n', isError: false })
    assert.equal(f.data.preview, 'Linux\n20000\n')
  })

  test('content part 数组：文本进 preview，图片进 images', () => {
    // 从前图片被换成 `[image]` 占位，于是"帮我截个图"在界面上只有一行 [image] ——
    // 而截图这个动作本身就是为了给人看的。现在图片单独走 images 字段，
    // preview 里仍然**不许**出现 base64（那是 4 万字符的噪音）。
    const [f] = frames({
      type: 'tool_execution_end', toolCallId: 'c2', toolName: 'workstation_browser', isError: false,
      result: { content: [{ type: 'text', text: '页面标题' }, { type: 'image', data: 'x'.repeat(50000), mimeType: 'image/png' }] },
    })
    assert.equal(f.data.preview, '页面标题')
    assert.ok(!f.data.preview.includes('xxxx'), 'base64 混进 preview 了')
    assert.equal(f.data.images.length, 1)
    assert.equal(f.data.images[0].mimeType, 'image/png')
    assert.equal(f.data.images[0].data.length, 50000)
  })

  test('超长输出截断并标明原长 —— 一条 find / 不该把浏览器打爆', () => {
    const [f] = frames({ type: 'tool_execution_end', toolCallId: 'c3', toolName: 'bash', result: 'y'.repeat(10000), isError: false })
    assert.equal(f.data.previewTruncated, true)
    assert.equal(f.data.resultLength, 10000)
    assert.ok(f.data.preview.length < 10000)
  })

  test('没有结果时不造一个空预览出来', () => {
    const [f] = frames({ type: 'tool_execution_end', toolCallId: 'c4', toolName: 'bash', result: undefined, isError: true })
    assert.equal('preview' in f.data, false)
    assert.equal(f.data.isError, true)
  })
})
