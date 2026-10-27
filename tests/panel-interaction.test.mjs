/**
 * 交互测试：在 jsdom 里**真的点**这些控件，断言写回宿主的调用。
 *
 * 为什么需要它：面板里有一堆"看起来能点"的控件，而 `form.set` 的失败可能**静默**
 * （宿主拒绝时 resolve false 而不是 throw）。渲染测试只能证明"画出来了"，
 * 点一下才知道接线对不对。真机报过"命令超时点 + 没反应"，这类回归只有交互测试能钉住。
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const VALUE = {
  enabled: true,
  browser: { headed: false, allowedDomains: [], maxOutput: 0, idleTimeout: '', profile: '', executablePath: '', contentBoundaries: true },
  session: { name: '' },
  tools: { decision: false, raw: false, screenshot: true },
  limits: { commandTimeoutMs: 30_000, maxSteps: 16, goalThreshold: 0.85, stuckThreshold: 0.85 },
  judgment: { purpose: 'browser.action' },
}

async function loadModule(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'],
    jsx: 'automatic',
    loader: { '.jsx': 'jsx', '.js': 'jsx', '.css': 'text' },
    write: false,
    logLevel: 'silent',
  })
  const out = `node_modules/.cache/${entry.replace(/[^a-zA-Z0-9]/g, '_')}.mjs`
  await mkdir('node_modules/.cache', { recursive: true })
  await writeFile(out, result.outputFiles[0].text)
  return import(`../${out}?case=${Math.random()}`)
}

/** 记录写入的假表单；`set` 会更新快照（模拟宿主接受）。 */
function fakeForm(value) {
  let current = structuredClone(value)
  let revision = 1
  const calls = []
  return {
    calls,
    getSnapshot: () => ({ value: current, status: 'ready', revision, writable: true }),
    subscribe: () => () => {},
    async set(field, next) {
      calls.push({ field, next })
      current = { ...current, [field]: next }
      revision += 1
      return true
    },
  }
}

/**
 * 渲染进 jsdom，返回 document 与卸载函数。
 *
 * **不还原全局 window/document**：React 的调度器在 unmount 之后还会跑一小段异步逻辑，
 * 把全局还原成 undefined 会让它抛 `Cannot read properties of undefined (reading 'event')`，
 * node --test 会把这算成 uncaughtException（文件级失败）。测试进程本来就一次性的。
 */
async function mount(Component, props) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root'))
  root.render(React.createElement(Component, props))
  await new Promise((resolve) => setTimeout(resolve, 30))
  return {
    document: dom.window.document,
    unmount: async () => {
      root.unmount()
      await new Promise((resolve) => setTimeout(resolve, 20))
    },
  }
}

const click = (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

/**
 * 轮询到条件成立为止（默认最多 2s），超时直接报"在等什么"。
 *
 * 为什么需要：挂载时那次自检是**异步**的（`browser.probe()` → `setProbe` → React 调度器
 * 在之后的任务里 flush），而 `mount()` 只等固定 30ms。断言「开关可点」「冒出一条 alert」
 * 这类**正向**信号时，早先等于赌这 30ms 够用——本机够，CI（Linux、多个测试文件并行抢 CPU）
 * 不够，于是 `decision.disabled` 还停在初始的 true，报 `expected false, actual true`。
 * 反过来，断言「必须置灰」的用例在状态没落地时**也**成立，所以它们一直是绿的。
 * 改成等状态落地，测试才与机器快慢无关。
 */
async function waitFor(predicate, { timeout = 2000, label = '条件' } = {}) {
  const startedAt = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - startedAt > timeout) throw new Error(`等待超时（${timeout}ms）：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * 等「决策」那一行切到指定依赖状态。
 *
 * 四种状态在页面上各有一句固定说明（见 `JUDGMENT_HINTS`），用它判断**自检结果已落地**——
 * 只看 `disabled` 不行：`checking` 也是置灰，会与 `missing` 混淆。
 */
const waitJudgmentHint = (document, pattern) => waitFor(
  () => pattern.test(document.body.textContent),
  { label: `面板进入 ${pattern} 状态` },
)

/** 收集页面上所有 `role="alert"` 的文本。 */
const alertsOf = (document) => [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent)

test('点「增加毫秒」真的写回宿主：30000 → 30100', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const form = fakeForm(VALUE)
  const view = await mount(Panel, {
    form, entryId: 'agent-browser', primitives: undefined, settings: undefined, hasDocument: false, browser: undefined,
  })
  try {
    const up = view.document.querySelector('button[aria-label="增加毫秒"]')
    assert.ok(up, '找不到「增加毫秒」按钮')
    click(up)
    await tick()
    const write = form.calls.find((call) => call.field === 'limits')
    assert.ok(write, '点击后没有写回 limits')
    assert.equal(write.next.commandTimeoutMs, 30_100)
    assert.equal(view.document.querySelector('input[aria-label="毫秒数"]').value, '30100')
  } finally {
    await view.unmount()
  }
})

test('点「减少毫秒」真的写回宿主：30000 → 29900', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const form = fakeForm(VALUE)
  const view = await mount(Panel, {
    form, entryId: 'agent-browser', primitives: undefined, settings: undefined, hasDocument: false, browser: undefined,
  })
  try {
    click(view.document.querySelector('button[aria-label="减少毫秒"]'))
    await tick()
    const write = form.calls.find((call) => call.field === 'limits')
    assert.equal(write?.next.commandTimeoutMs, 29_900)
    assert.equal(view.document.querySelector('input[aria-label="毫秒数"]').value, '29900')
  } finally {
    await view.unmount()
  }
})

test('输入框里打精确毫秒：回车提交并夹到区间', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const form = fakeForm(VALUE)
  const view = await mount(Panel, {
    form, entryId: 'agent-browser', primitives: undefined, settings: undefined, hasDocument: false, browser: undefined,
  })
  try {
    const input = view.document.querySelector('input[aria-label="毫秒数"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '500')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
    await tick()
    assert.equal(form.calls.find((call) => call.field === 'limits')?.next.commandTimeoutMs, 1000) // 夹到下限
    assert.equal(view.document.querySelector('input[aria-label="毫秒数"]').value, '1000')
  } finally {
    await view.unmount()
  }
})

test('空闲超时选「自定义」把预设折算成毫秒写进去；选回预设写回 CLI 写法', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const form = fakeForm({ ...VALUE, browser: { ...VALUE.browser, idleTimeout: '30m' } })
  const view = await mount(Panel, {
    form, entryId: 'agent-browser', primitives: undefined, browser: undefined,
  })
  try {
    const select = view.document.querySelector('select[aria-label="空闲超时预设"]')
    assert.ok(select, '找不到空闲超时下拉')
    select.value = '__custom__'
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
    assert.equal(form.calls.find((call) => call.field === 'browser')?.next.idleTimeout, '1800000')

    // 自定义状态下出现毫秒输入
    assert.ok(view.document.querySelector('input[aria-label="毫秒数"]'))
  } finally {
    await view.unmount()
  }
})

test('开关也走同一条写入路径（对照组）', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const form = fakeForm(VALUE)
  const view = await mount(Panel, {
    form, entryId: 'agent-browser', primitives: undefined, settings: undefined, hasDocument: false, browser: undefined,
  })
  try {
    const screenshot = view.document.querySelector('input[aria-label="截图工具"]')
    click(screenshot)
    await tick()
    const write = form.calls.find((call) => call.field === 'tools')
    assert.ok(write, '开关点击后没有写回 tools')
    assert.equal(write.next.screenshot, false)
  } finally {
    await view.unmount()
  }
})

test('宿主静默拒绝（set resolve false）时必须报错，不能假装成功', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const form = fakeForm(VALUE)
  form.set = async () => false // 宿主拒绝：resolve false 而不是 throw
  const view = await mount(Panel, {
    form, entryId: 'agent-browser', primitives: undefined, settings: undefined, hasDocument: false, browser: undefined,
  })
  try {
    click(view.document.querySelector('button[aria-label="增加毫秒"]'))
    await tick()
    const alerts = [...view.document.querySelectorAll('[role="alert"]')]
    const rejection = alerts.find((node) => /拒绝/.test(node.textContent))
    assert.ok(rejection, `写入被拒绝却没显示错误；现有 alert：${alerts.map((n) => n.textContent).join(' | ')}`)
    assert.match(rejection.textContent, /宿主拒绝了这次写入/)
  } finally {
    await view.unmount()
  }
})

// 保证 react-dom/server 的 import 不被 tree-shake 警告打扰（渲染测试在另一个文件）。
void renderToStaticMarkup

/**
 * 「决策」开关的依赖检查：`dsh-judgment` 提供的 `ctx.judgment` 不在时，
 * 宿主把 `probe.judgment=false` 带下来，面板必须**先检查再允许开启**（置灰 + 说清原因），
 * 而不是让用户开了再去撞 `judge_error`。
 */
/** 面板拿的是 **Remote 信封**（`{ ok, value }`），不是裸载荷。 */
const probeWith = (judgment) => ({
  probe: async () => ({
    ok: true,
    value: {
      apiVersion: 2,
      ok: true,
      title: '浏览器环境就绪',
      checkedAt: new Date().toISOString(),
      judgment,
      checks: [
        { id: 'cli', label: 'agent-browser', status: 'pass', message: '已安装 0.38.2' },
        { id: 'chrome', label: 'Chrome', status: 'pass', message: '已就绪' },
      ],
    },
  }),
})

test('决策：依赖缺失时开关置灰，并说清"需要 dsh-judgment"', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const view = await mount(Panel, {
    form: fakeForm(VALUE), entryId: 'agent-browser', primitives: undefined, browser: probeWith(false),
  })
  try {
    const decision = view.document.querySelector('input[aria-label="决策"]')
    assert.ok(decision, '找不到决策开关')
    // 先等自检明确回「没有」：`checking` 状态下也是置灰，不等就等于没验证。
    await waitJudgmentHint(view.document, /需要 dsh-judgment 提供的 ctx\.judgment/)
    assert.equal(view.document.querySelector('input[aria-label="决策"]').disabled, true, '依赖不在时必须置灰')
    assert.match(view.document.body.textContent, /dsh-judgment/)
  } finally {
    await view.unmount()
  }
})

test('决策：依赖在时开关可点（置灰条件不能误伤）', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const view = await mount(Panel, {
    form: fakeForm(VALUE), entryId: 'agent-browser', primitives: undefined, browser: probeWith(true),
  })
  try {
    // 自检回「有」之后才可点：等提示切到 ready 态，再断言开关。
    await waitJudgmentHint(view.document, /依赖 dsh-judgment（已就绪）/)
    assert.equal(view.document.querySelector('input[aria-label="决策"]').disabled, false)
  } finally {
    await view.unmount()
  }
})

test('决策：配置里已开启但依赖缺失 → 明确报错（不是只有一个灰开关）', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const onConfig = { ...VALUE, tools: { ...VALUE.tools, decision: true } }
  const view = await mount(Panel, {
    form: fakeForm(onConfig), entryId: 'agent-browser', primitives: undefined, browser: probeWith(false),
  })
  try {
    await waitFor(
      () => alertsOf(view.document).some((text) => /dsh-judgment/.test(text) && /browser_run/.test(text)),
      { label: '出现「已开启但依赖缺失」的报错' },
    )
  } finally {
    await view.unmount()
  }
})

/**
 * 依赖检查是**四态**的，而且"确认不了"也算不许开启（之前的漏洞：未知 → 放行）。
 */
test('决策：自检还没回来（checking）→ 先不许开启', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const view = await mount(Panel, {
    form: fakeForm(VALUE), entryId: 'agent-browser', primitives: undefined,
    browser: { probe: () => new Promise(() => {}) }, // 永不 resolve
  })
  try {
    const decision = view.document.querySelector('input[aria-label="决策"]')
    assert.equal(decision.disabled, true, '依赖状态未知时不许开启')
    assert.match(view.document.body.textContent, /检查依赖 dsh-judgment/)
  } finally {
    await view.unmount()
  }
})

test('决策：host 半是旧码（载荷版本不匹配）→ 也不许开启', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const view = await mount(Panel, {
    form: fakeForm(VALUE), entryId: 'agent-browser', primitives: undefined,
    browser: {
      probe: async () => ({
        ok: true,
        value: { apiVersion: 1, ok: true, title: '浏览器环境就绪', checkedAt: '', judgment: true, checks: [] },
      }),
    },
  })
  try {
    await waitJudgmentHint(view.document, /无法确认 dsh-judgment 是否可用/)
    assert.equal(view.document.querySelector('input[aria-label="决策"]').disabled, true, '版本不匹配时无法确认依赖，不许开启')
  } finally {
    await view.unmount()
  }
})

test('决策：开启前向宿主现问一次依赖，宿主说没有 → 不写配置并报错', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const form = fakeForm(VALUE)
  const browser = {
    ...probeWith(true),
    checkJudgment: async () => ({ ok: true, value: { available: false, reason: '需要 dsh-judgment' } }),
  }
  const view = await mount(Panel, { form, entryId: 'agent-browser', primitives: undefined, browser })
  try {
    await waitJudgmentHint(view.document, /依赖 dsh-judgment（已就绪）/)
    click(view.document.querySelector('input[aria-label="决策"]'))
    await waitFor(
      () => alertsOf(view.document).some((text) => /dsh-judgment/.test(text)),
      { label: '现问依赖后报错' },
    )
    assert.equal(form.calls.some((call) => call.field === 'tools'), false, '依赖不可用就不能写配置')
  } finally {
    await view.unmount()
  }
})

/**
 * 打开面板时**不许闪红字**（真机反馈）：远端命名空间刚 mount、第一次 probe 可能失败；
 * 早先这里立刻报红色「自检通路不可用」，随后重挂又消失——看起来像出错。
 * 现在：首次结果出来之前页面上不出现任何提示，且第一次 probe 失败会安静重试一次。
 */
test('首次 probe 失败一次 → 安静重试，页面上从不出现红字', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  let calls = 0
  const browser = {
    async probe() {
      calls += 1
      if (calls === 1) throw new Error('gateway not ready') // 第一次失败（命名空间刚挂上）
      return {
        ok: true,
        value: {
          apiVersion: 2, ok: true, title: '浏览器环境就绪', judgment: true, checkedAt: '',
          checks: [
            { id: 'cli', label: 'agent-browser', status: 'pass', message: '已安装 0.38.2' },
            { id: 'chrome', label: 'Chrome', status: 'pass', message: '已就绪' },
          ],
        },
      }
    },
  }
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root'))
  root.render(React.createElement(Panel, { form: fakeForm(VALUE), entryId: 'agent-browser', primitives: undefined, browser }))
  try {
    // 每 40ms 看一次：整个过程里都不该出现 role=alert 的红字
    for (let i = 0; i < 15; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40))
      const alerts = dom.window.document.querySelectorAll('[role="alert"]')
      assert.equal(alerts.length, 0, `第 ${i * 40}ms 出现了红字：${alerts[0]?.textContent ?? ''}`)
    }
    assert.equal(calls, 2, '第一次失败后应该自动重试一次')
    assert.match(dom.window.document.body.textContent, /已安装/)
  } finally {
    await root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
})

test('自检还没回来时，页面上不显示"还没有检查过"之类的占位文字', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const browser = { probe: () => new Promise(() => {}) } // 永不返回
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root'))
  root.render(React.createElement(Panel, { form: fakeForm(VALUE), entryId: 'agent-browser', primitives: undefined, browser }))
  try {
    await new Promise((resolve) => setTimeout(resolve, 80))
    const text = dom.window.document.body.textContent
    assert.ok(!text.includes('还没有检查过'), '自检未返回时不该出现空态文案')
    assert.ok(!text.includes('检查安装'), '自检未返回时不该出现检查按钮')
    assert.equal(dom.window.document.querySelectorAll('[role="alert"]').length, 0)
  } finally {
    await root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
})
