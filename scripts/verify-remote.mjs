#!/usr/bin/env node
/**
 * 验证 **Remote 通路**（设置页「检查安装」按钮靠它）——两端都用**本插件自己的产物**，
 * 不碰运行中的应用，也不需要 typert 代码生成。照搬 dsh-judgment 的同款脚本形状。
 *
 * - **host 半**：真 `dsh-typert-registry` host + `dsh-api-gateway` host + 本插件 `lib/index.js`。
 *   Gateway 走 **SRC fallback**：扫 `typertRemote` 绑定 + 读 `@Remote` 装饰器 marker 现推 descriptor。
 *   这一步同时在验证"我们的装饰器与基类接对了"。
 * - **client 半**：真 Gateway client + 本插件 `client/browser-remote.js` 的手写 contribution。
 * - **交叉验证**：把客户端**实际发出的 args** 原样交给 host 的 `invokeRpc`。
 *   `wire` 名或实参个数只要错一个，这一段就会炸——这是这个脚本存在的核心理由
 *   （`probe(deep)` 少传实参会得到 `expected 1 argument(s), got 0`，是真实踩过的坑）。
 *
 * 用法：`pnpm verify:remote`
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = process.env.DSH_APP_RUNTIME ?? '/Users/joeson/.dsh/app-runtime/node_modules/@deepseek-ai'
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/* ───────────────────────── host 半 ───────────────────────── */

const cordis = await import(`${APP}/cordis/lib/index.js`)
const { default: TypertRegistry } = await import(`${APP}/dsh-typert-registry/lib/index.js`)
const { default: TypertGatewayService } = await import(`${APP}/dsh-api-gateway/lib/index.js`)
const { default: AgentBrowserService, Config } = await import(`${REPO}/lib/index.js`)

/** 工具注册表替身：这个脚本验的是 Remote，不是工具。 */
class FakeTools extends cordis.Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.registered = []
  }

  register(definition) {
    this.registered.push(definition)
    return () => {}
  }
}

const hostCtx = new cordis.Context()
await hostCtx.plugin(TypertRegistry)
await hostCtx.plugin(TypertGatewayService)
await hostCtx.plugin(FakeTools)
await hostCtx.plugin(AgentBrowserService, Config({}))
await new Promise((resolve) => setTimeout(resolve, 200))

console.log('host 半（SRC fallback 推 descriptor）')
check(
  'typert / typertGateway / browser 三个服务都在',
  Boolean(hostCtx.get('typert') && hostCtx.get('typertGateway') && hostCtx.get('browser')),
)

const probeCall = await hostCtx.typertGateway.invokeRpc('browser/probe', { args: { deep: false } }, undefined, undefined)
check('browser/probe 可按 @Remote 暴露并被调用', probeCall?.ok === true, JSON.stringify(probeCall)?.slice(0, 200))
check('probe 返回可判读的自检结果', typeof probeCall?.value?.status === 'string' && Array.isArray(probeCall.value?.checks), JSON.stringify(probeCall?.value)?.slice(0, 200))
check('probe 报了版本与所用二进制', typeof probeCall?.value?.command === 'string' && probeCall.value.command.length > 0)

const unmarked = await hostCtx.typertGateway.invokeRpc('browser/sessionInfo', { args: {} }, undefined, undefined)
check('未标 @Remote 的 sessionInfo 不会被暴露', unmarked?.ok === false, JSON.stringify(unmarked)?.slice(0, 160))

// 实测：**host 对缺参是宽容的**（`deep` 变成 undefined，走 falsy 分支 = 轻量检查），
// 卡住实参个数的是**客户端**（见下面 "漏传实参会被客户端拦下"）。两条都值得记下来，
// 因为"客户端必须显式传"这件事没有别的证据来源。
const missing = await hostCtx.typertGateway.invokeRpc('browser/probe', { args: {} }, undefined, undefined)
check('host 对缺参宽容（deep=undefined → 只做轻量检查）', missing?.ok === true, JSON.stringify(missing)?.slice(0, 160))

const extra = await hostCtx.typertGateway.invokeRpc('browser/probe', { args: { deep: false, bogus: 1 } }, undefined, undefined)
check('多余的 args 键被 host 拒绝', extra?.ok === false, JSON.stringify(extra)?.slice(0, 160))

/* ───────────────────────── client 半 ───────────────────────── */

const registry = new Map()
globalThis.window = { __ModuleLoader__: { load({ id, factory }) { registry.set(id, factory) } } }
globalThis.document = { baseURI: 'http://127.0.0.1:19387/' }
globalThis.WebSocket = class { constructor() {} close() {} addEventListener() {} removeEventListener() {} send() {} }
const evaluate = (file) => { new Function(readFileSync(file, 'utf8'))() }
evaluate(`${APP}/dsh-typert-registry/lib/client.js`)
evaluate(`${APP}/dsh-api-gateway/lib/client.js`)

const wires = []
const connection = {
  isLoopback: true,
  generation: { getSnapshot: () => ({ host: { home: '/tmp' } }) },
  registerGenerationSource: () => () => {},
  rpc: {
    open: undefined,
    call: async (mount, endpoint, payload) => {
      wires.push({ mount, endpoint, args: payload.args })
      return { ok: true, value: { status: 'ok', summary: 'stub', command: '/stub/agent-browser', commandDetail: '/stub', native: true, checks: [], checkedAt: new Date().toISOString() } }
    },
  },
  start: () => ({ stop() {} }),
}

const clientCtx = new cordis.Context()
clientCtx.provide('connection', connection)
registry.get('@deepseek-ai/dsh-typert-registry')((id) => {
  if (id === '@deepseek-ai/cordis') return cordis
  throw new Error(id)
}).apply(clientCtx)
registry.get('@deepseek-ai/dsh-api-gateway')((id) => {
  if (id === '@deepseek-ai/cordis') return cordis
  throw new Error(id)
}).apply(clientCtx)

const { browserContribution } = await import(`${REPO}/client/browser-remote.js`)

console.log('\nclient 半（手写 contribution 过 Gateway 校验）')
const dispose = await clientCtx.remote.$mount(browserContribution())
check('$mount 成功并返回 disposer', typeof dispose === 'function')
check('命名空间暴露了 probe', typeof clientCtx.remote.browser?.probe === 'function')

const clientProbe = await clientCtx.remote.browser.probe(false)
check('客户端调用 probe(false) 拿到信封', clientProbe?.ok === true)

const probeWire = wires.at(-1)
check('probe 的 wire 名是 deep', JSON.stringify(Object.keys(probeWire.args)) === '["deep"]', JSON.stringify(probeWire.args))
check('probe 的实参是布尔', probeWire.args.deep === false)

let zeroArgsMessage = ''
try {
  await clientCtx.remote.browser.probe()
} catch (error) {
  zeroArgsMessage = String(error?.message ?? error)
}
check('漏传实参会被客户端拦下（说明必须显式传）', /expected 1 argument/.test(zeroArgsMessage), zeroArgsMessage)

/* ─────────────── 交叉验证：客户端发出的 args 原样喂给 host ─────────────── */

console.log('\n交叉验证（两端线契约必须逐字一致）')
const piped = await hostCtx.typertGateway.invokeRpc('browser/probe', { args: probeWire.args }, undefined, undefined)
check('客户端 args 能被 host 直接接受', piped?.ok === true, JSON.stringify(piped)?.slice(0, 200))
check('喂进去的那次真的跑到了自检', typeof piped?.value?.status === 'string')

await dispose()
check('dispose 之后命名空间消失', clientCtx.remote?.browser === undefined)

console.log('')
if (failures.length === 0) {
  console.log('Remote 通路验证通过 ✅')
  process.exit(0)
}
console.log(`Remote 通路验证失败 ❌（${failures.length} 项）`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
