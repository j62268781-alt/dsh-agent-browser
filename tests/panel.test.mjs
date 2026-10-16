/**
 * 页面渲染测试：把 `client/**` 用 esbuild 打成临时 ESM，再用 react-dom/server 真的渲染一次，
 * 断言"设置页画出来的东西"就是这么写的。形状照 dsh-judgment 的 tests/panel.test.mjs。
 *
 * 这是"看得见"的那部分唯一可自动化的验证——装到 DSH 里之前的最后一道闸。
 * React 只是测试依赖：运行期由宿主的模块表提供（见 client/esbuild.config.mjs 的 external）。
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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

/** 与 src/config.ts 的默认值一致的一份配置快照。 */
const VALUE = {
  enabled: true,
  browser: { headed: false, allowedDomains: ['example.com'], maxOutput: 0, idleTimeout: '30m', profile: '', executablePath: '', contentBoundaries: true },
  session: { name: 'dsh-agent-browser' },
  tools: { decision: true, raw: false, screenshot: true },
  limits: { commandTimeoutMs: 30_000, maxSteps: 16, goalThreshold: 0.85, stuckThreshold: 0.85 },
  judgment: { purpose: 'browser.action' },
}

const fakeForm = (value = VALUE) => ({
  getSnapshot: () => ({ value, status: 'ready', revision: 1, writable: true }),
  subscribe: () => () => {},
  set: async () => {},
})

test('设置页画出了页头、两行开关、工具面与进阶项（标题 + 子标题）', async () => {
  const { Panel } = await loadModule('client/panel.jsx')
  const html = renderToStaticMarkup(React.createElement(Panel, {
    form: fakeForm(),
    entryId: 'agent-browser',
    primitives: undefined,
    settings: undefined,
    hasDocument: false,
    browser: undefined,
  }))

  // 页头：18px 标题 + 13px 副标题
  assert.match(html, /ab-pageTitle[^>]*>浏览器</)
  assert.match(html, /ab-pageIntro/)
  // 两行开关：标题 + 子标题都在
  assert.match(html, /浏览器功能/)
  assert.match(html, /关闭后不注册任何工具/)
  assert.match(html, /决策/)
  assert.match(html, /browser_run/)
  assert.match(html, /browser\.action/)          // 用途名进子标题
  // 工具面 / 进阶 / 配置文件
  assert.match(html, /逃生舱/)
  assert.match(html, /允许域名/)
  assert.match(html, /example\.com/)             // 配置值真的渲染出来了
  assert.match(html, /内容边界标记/)
  assert.match(html, /打开配置文件/)
  assert.match(html, /当前部署不提供本地设置文档/) // hasDocument=false 时的说明
  // 没接 primitives 时退回原生控件，而不是整页挂掉
  assert.match(html, /type="checkbox"/)
  assert.match(html, /<button/)
})

test('summary 三态：绿/黄/红各自的语气与修法', async () => {
  const { InstallSummary } = await loadModule('client/panel.jsx')
  const render = (probe) => renderToStaticMarkup(React.createElement(InstallSummary, {
    primitives: undefined, probe, probing: false, error: '', onCheck: () => {},
  }))

  const ok = render({
    status: 'ok',
    summary: 'agent-browser 0.38.2 已就绪 · 原生二进制 · 会话 dsh-agent-browser',
    command: '/opt/homebrew/.../agent-browser-darwin-arm64',
    native: true,
    version: '0.38.2',
    checkedAt: new Date().toISOString(),
    checks: [
      { id: 'cli.found', status: 'pass', message: '可执行文件：/opt/.../agent-browser-darwin-arm64' },
      { id: 'cli.version', status: 'pass', message: '版本 0.38.2（支持区间 [0.38.0, 0.39.0)）' },
    ],
  })
  assert.match(ok, /data-tone="ok"/)
  assert.match(ok, /已就绪/)
  assert.match(ok, /原生二进制/)
  assert.match(ok, /全部检查（2）/)   // 通过的项收进折叠区

  const warn = render({
    status: 'warn',
    summary: 'agent-browser 0.38.2 可用，但有折扣项（见下）',
    command: '/usr/local/bin/agent-browser',
    native: false,
    version: '0.38.2',
    checkedAt: new Date().toISOString(),
    checks: [{ id: 'cli.native', status: 'warn', message: '当前是 CLI 的 Node 包装层：每次调用多付一份 Node 启动', fix: '清空 executablePath' }],
  })
  assert.match(warn, /data-tone="warn"/)
  assert.match(warn, /有折扣项/)
  assert.match(warn, /修法：清空 executablePath/)

  const error = render({
    status: 'error',
    summary: '没找到 agent-browser：浏览器功能不可用',
    command: 'agent-browser',
    native: false,
    checkedAt: new Date().toISOString(),
    checks: [{ id: 'cli.found', status: 'fail', message: 'PATH 上没找到', fix: 'brew install agent-browser' }],
  })
  assert.match(error, /data-tone="danger"/)
  assert.match(error, /不可用/)
  assert.match(error, /修法：brew install agent-browser/)
})

test('还没检查时给一句明确的下一步，而不是空白', async () => {
  const { InstallSummary } = await loadModule('client/panel.jsx')
  const html = renderToStaticMarkup(React.createElement(InstallSummary, {
    primitives: undefined, probe: null, probing: false, error: '', onCheck: () => {},
  }))
  assert.match(html, /还没有检查过 agent-browser/)
  assert.match(html, /检查安装/)
})

test('自检通路报错时把原因显示出来（不让页面默默失败）', async () => {
  const { InstallSummary } = await loadModule('client/panel.jsx')
  const html = renderToStaticMarkup(React.createElement(InstallSummary, {
    primitives: undefined, probe: null, probing: false, error: '自检通路不可用（host 半未加载）', onCheck: () => {},
  }))
  assert.match(html, /role="alert"/)
  assert.match(html, /自检通路不可用/)
})
