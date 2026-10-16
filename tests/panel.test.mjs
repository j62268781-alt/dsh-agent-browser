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

test('设置页画出了页头、所有行（标题 + 子标题）与两行开关', async () => {
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
  // 每一行都是同一条 .ab-row（16px 竖距 + 下边框由 CSS 保证；这里断言结构一致）
  const rows = html.match(/class="ab-row"/g) ?? []
  assert.ok(rows.length >= 12, `期望至少 12 行统一的行，实际 ${rows.length}`)
  assert.ok(!html.includes('ab-groupTitle'), '分组标题会打断"每行都一样"的节奏，已去掉')
  // 工具面 / 进阶 / 配置文件（现在都是普通行，靠标题自解释）
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

test('自检卡片：两项、成功/失败各自的说明与"帮忙安装"，且不含路径', async () => {
  const { InstallSummary } = await loadModule('client/panel.jsx')
  const render = (probe, extra = {}) => renderToStaticMarkup(React.createElement(InstallSummary, {
    primitives: undefined, probe, probing: false, error: '', installing: false, note: '', onCheck: () => {}, onInstall: () => {}, ...extra,
  }))

  const ok = render({
    apiVersion: 1,
    ok: true,
    title: '浏览器环境就绪',
    checkedAt: new Date().toISOString(),
    checks: [
      { id: 'cli', label: 'agent-browser', status: 'pass', message: '已安装 0.38.2' },
      { id: 'chrome', label: 'Chrome', status: 'pass', message: '已就绪（Google Chrome 155.0.8059.84）' },
    ],
  })
  assert.match(ok, /data-tone="ok"/)
  assert.match(ok, /浏览器环境就绪/)
  assert.match(ok, /已安装 0\.38\.2/)
  assert.match(ok, /Chrome/)
  assert.match(ok, /data-variant="primary"/)      // 检查安装按钮是 primary，且 flex:none 不会换行由 CSS 保证
  assert.match(ok, /检查安装/)
  assert.ok(!ok.includes('/opt/'), '不该显示可执行文件路径')

  const missing = render({
    apiVersion: 1,
    ok: false,
    title: '浏览器环境不完整',
    checkedAt: new Date().toISOString(),
    checks: [
      { id: 'cli', label: 'agent-browser', status: 'fail', message: '本机没安装', fix: 'brew install agent-browser', installable: true },
      { id: 'chrome', label: 'Chrome', status: 'pass', message: '已就绪' },
    ],
  })
  assert.match(missing, /data-tone="danger"/)
  assert.match(missing, /浏览器环境不完整/)
  assert.match(missing, /本机没安装/)
  assert.match(missing, /修法：brew install agent-browser/)
  assert.match(missing, />安装</)                  // 失败项带"安装"按钮
  assert.ok(!missing.includes('修法：brew install agent-browser</div><div class="ab-checkFix">修法'), '修法只出现一次')
})

test('host 半是旧版本时，把"重启 DSH"说清楚（而不是画一张看不懂的卡片）', async () => {
  const { InstallSummary } = await loadModule('client/panel.jsx')
  const html = renderToStaticMarkup(React.createElement(InstallSummary, {
    primitives: undefined,
    probing: false, error: '', installing: false, note: '', onCheck: () => {}, onInstall: () => {},
    probe: { status: 'ok', summary: 'agent-browser 0.38.2 已就绪', checks: [{ id: 'cli.found', status: 'pass', message: '路径' }] },
  }))
  assert.match(html, /安装自检需要重启 DSH/)
  assert.match(html, /客户端半已是新版本，但 host 半还是旧代码/)
  assert.ok(!html.includes('cli.found'), '错配时不该把旧形状的 check id 画出来')
})

test('还没检查时给一句明确的下一步，而不是空白', async () => {
  const { InstallSummary } = await loadModule('client/panel.jsx')
  const html = renderToStaticMarkup(React.createElement(InstallSummary, {
    primitives: undefined, probe: null, probing: false, error: '', installing: false, note: '', onCheck: () => {}, onInstall: () => {},
  }))
  assert.match(html, /还没有检查过浏览器环境/)
  assert.match(html, /检查安装/)
})

test('自检通路报错时把原因显示出来（不让页面默默失败）', async () => {
  const { InstallSummary } = await loadModule('client/panel.jsx')
  const html = renderToStaticMarkup(React.createElement(InstallSummary, {
    primitives: undefined, probe: null, probing: false, error: '自检通路不可用（host 半未加载）', installing: false, note: '', onCheck: () => {}, onInstall: () => {},
  }))
  assert.match(html, /role="alert"/)
  assert.match(html, /自检通路不可用/)
})
