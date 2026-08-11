/**
 * 配置解析里那几条"配错了不报错、只是行为不对"的分支。
 *
 * 现在只有一组：桥的回连地址（BRIDGE_ADVERTISE_BASE）怎么定。它是纯部署问题，
 * 本地开发永远碰不到 —— 本地要么显式配了，要么退回回环地址正好也能用。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'

import { loadConfig, detectHostBase } from '../src/config.js'

/**
 * **不要用仓库根当 cwd**：loadConfig 会读那里的 .env 并把值写进 process.env，
 * 于是这组用例的结果取决于开发机上那份私有配置，换台机器就换个结果。
 */
const CWD = os.tmpdir()

const PROD = { NODE_ENV: 'production', AUTH_MODE: 'sso', LLM_MODE: 'platform', DEV_CONSOLE: '0', SESSION_STORE: 'memory' }
const MANAGER = { SANDBOX_MODE: 'manager', SANDBOX_MANAGER_URL: 'http://manager.example/api', SANDBOX_MANAGER_CODE: 'code' }
const HTTP = { SANDBOX_MODE: 'http', SANDBOX_URL: 'http://worker.example:8080', SANDBOX_TOKEN: 'token-0123456789' }

/** 探测本身要有东西可探。CI 容器里一般都有 eth0，没有就跳过 —— 那是环境问题不是代码问题。 */
const DETECTED = detectHostBase(8788)
const skip = DETECTED ? false : '本机没有非回环 IPv4，探测无从谈起'

describe('桥的回连地址', () => {
  test('manager 模式也要自动探测容器 IP —— 不是只有 http', { skip }, () => {
    // 这条守的是一处真实的分叉：探测那边只写了 `http`，而校验那边要求
    // `http|manager` 都得有地址。于是 manager 模式下探测根本不跑，
    // advertiseBase 永远是空串，生产一启动就被自己的校验拦下，
    // 报的还是"自动探测没找到非回环 IPv4"—— 而容器里 eth0 好端端地在那儿。
    // 在真容器里实测过一次：配置全对，服务就是起不来。
    const config = loadConfig({ cwd: CWD, env: { ...PROD, ...MANAGER } })
    assert.equal(config.bridge.advertiseBase, DETECTED)
  })

  test('两种"沙盒在网络另一头"的模式，处理必须一模一样', { skip }, () => {
    const manager = loadConfig({ cwd: CWD, env: { ...PROD, ...MANAGER } })
    const http = loadConfig({ cwd: CWD, env: { ...PROD, ...HTTP } })
    assert.equal(manager.bridge.advertiseBase, http.bridge.advertiseBase)
  })

  test('显式配置永远优先于探测', { skip }, () => {
    const explicit = 'http://10.0.0.7:8788'
    for (const mode of [MANAGER, HTTP]) {
      const config = loadConfig({ cwd: CWD, env: { ...PROD, ...mode, BRIDGE_ADVERTISE_BASE: `${explicit}/` } })
      assert.equal(config.bridge.advertiseBase, explicit, `${mode.SANDBOX_MODE} 模式下没用显式配置`)
    }
  })

  test('manager 模式不许退回 127.0.0.1 —— 沙盒不在本机，回环地址它连不到', { skip }, () => {
    // 开发模式（NODE_ENV 不设）走的是另一条分支。带着那个 bug 时，manager 会掉进
    // "本地开发退回回环"那一支，拿到一个沙盒根本连不上的地址，而且**不会报错**：
    // 表现是技能一出网就失败，看配置却哪儿都对。
    const config = loadConfig({ cwd: CWD, env: { AUTH_MODE: 'dev', ...MANAGER } })
    assert.notEqual(config.bridge.advertiseBase, 'http://127.0.0.1:8788')
    assert.equal(config.bridge.advertiseBase, DETECTED)
  })

  test('沙盒在本机时（local）才用回环地址', { skip }, () => {
    const config = loadConfig({ cwd: CWD, env: { AUTH_MODE: 'dev', SANDBOX_MODE: 'local' } })
    assert.equal(config.bridge.advertiseBase, 'http://127.0.0.1:8788')
  })
})
