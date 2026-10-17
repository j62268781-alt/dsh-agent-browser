/**
 * 页面渲染测试：把 `client/**` 用 esbuild 打成临时 ESM，再用 react-dom/server 真的渲染一次，
 * 断言"设置页画出来的东西"就是这么写的。形状照 dsh-judgment 的 tests/panel.test.mjs。
 *
 * 这是"看得见"的那部分唯一可自动化的验证——装到 DSH 里之前的最后一道闸。
 * React 只是测试依赖：运行期由宿主的模块表提供（见 client/esbuild.config.mjs 的 external）。
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  // 依赖检查是四态的：静态渲染时自检还没回来 → 「正在检查依赖 dsh-judgment」
  assert.match(html, /正在检查依赖 dsh-judgment/)
  // 每一行都是同一条 .ab-row（16px 竖距 + 下边框由 CSS 保证；这里断言结构一致）
  // 普通行是 `class="ab-row"`，上下布局的行是 `class="ab-row ab-rowStacked"`——都算一行
  const rows = html.match(/class="ab-row(?: [\w-]+)?"/g) ?? []
  assert.ok(rows.length >= 11, `期望至少 11 行统一的行，实际 ${rows.length}`)
  // 分组标题要在（用户要求保留）：工具面 / 进阶 / 配置文件
  for (const group of ['工具面', '进阶']) {
    assert.match(html, new RegExp(`class="ab-groupTitle">${group}<`))
  }
  // 第一行必须是 row（这样 `.ab-row:first-child{padding-top:0}` 才能把 summary 下方的间距
  // 压成与「副标题→summary」同一个 flex gap）
  const firstChild = html.slice(html.indexOf('<section class="ab-section">'))
  assert.match(firstChild, /^<section class="ab-section"><div class="ab-row">/)
  // 工具面 / 进阶 / 配置文件（现在都是普通行，靠标题自解释）
  assert.match(html, /逃生舱/)
  assert.match(html, /允许域名/)
  assert.match(html, /example\.com/)             // 配置值真的渲染出来了
  // 命令超时是步进器（照通用设置「字号」那行）：**毫秒**为单位，数值可点进去改精确值
  assert.match(html, /class="ab-stepper"[^>]*data-editable="true"/)
  assert.match(html, /class="ab-stepperInput"[^>]*value="30000"/)
  assert.match(html, /class="ab-stepperUnit">毫秒</)
  assert.match(html, /aria-label="增加毫秒"/)
  assert.match(html, /aria-label="减少毫秒"/)
  // 允许域名是上下布局 + 多行 textarea（横向挤不下，真机反馈）
  assert.match(html, /class="ab-row ab-rowStacked"[^>]*>.*?允许域名/s)
  assert.match(html, /<textarea class="ab-textarea"/)
  assert.match(html, /rows="4"/)
  assert.match(html, /内容边界标记/)
  // 最大输出：紧凑数字框（无箭头）
  assert.match(html, /class="ab-stepper"[^>]*data-arrows="false"/)
  assert.match(html, /class="ab-stepperUnit">字符</)
  // 空闲超时：预设下拉 + 自定义项
  assert.match(html, /<select class="ab-select"[^>]*aria-label="空闲超时预设"/)
  assert.match(html, /<option value="">CLI 默认（1 小时）</)
  assert.match(html, /<option value="10m">10 分钟</)
  assert.match(html, /<option value="__custom__">自定义…</)
  // 「打开配置文件」不再由本插件的页面提供——设置外壳已经有这个全局动作
  assert.ok(!html.includes('打开配置文件'), '不要重复提供设置外壳已有的全局动作')
  // 没接 primitives 时退回原生控件，而不是整页挂掉
  assert.match(html, /type="checkbox"/)
  assert.match(html, /<button/)
})

test('CSS 回归：Switch 不被拉伸；分组标题照抄「Agent 预设」的间距与排版', async () => {
  const css = await readFile(new URL('../client/styles.css', import.meta.url), 'utf8')
  // 宽泛的通配子选择器（`.ab-rowControl > * { width:100% }`）会把 36px 的 Switch 拉成整列宽
  assert.ok(!/\.ab-rowControl\s*>\s*\*\s*\{/.test(css), '别给控件容器里所有孩子统一设宽度：Switch 会被拉变形')
  assert.match(css, /\.ab-rowControl \.ab-input\{[^}]*width:320px/)
  // 分组标题 = ui-agent-preset 的 .groupHead + .group+.group{margin-top:20px}
  assert.match(css, /\.ab-groupTitle\{[^}]*margin:20px 0 0/)
  assert.match(css, /\.ab-groupTitle\{[^}]*font-weight:600/)
  assert.match(css, /\.ab-groupTitle\{[^}]*letter-spacing:\.06em/)
  assert.match(css, /\.ab-groupTitle\{[^}]*color:var\(--dsw-alias-label-tertiary\)/)
})

test('自检卡片：两项、成功/失败各自的说明与"帮忙安装"，且不含路径', async () => {
  const { InstallSummary } = await loadModule('client/panel.jsx')
  const render = (probe, extra = {}) => renderToStaticMarkup(React.createElement(InstallSummary, {
    primitives: undefined, probe, probing: false, error: '', installing: false, note: '', onCheck: () => {}, onInstall: () => {}, ...extra,
  }))

  const ok = render({
    apiVersion: 2,
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
  // 环境可用 → 按钮是**置灰的「已安装」**，不给"再检查一次"的诱惑
  assert.match(ok, /disabled=""[^>]*>已安装</)
  assert.ok(!ok.includes('检查安装'), '环境就绪时不该出现"检查安装"')
  assert.ok(!ok.includes('/opt/'), '不该显示可执行文件路径')

  const missing = render({
    apiVersion: 2,
    ok: false,
    title: '浏览器环境不完整',
    judgment: false,
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
  assert.match(html, /title="检查本机的 agent-browser 与 Chrome">检查安装</)
})

test('自检通路报错时把原因显示出来（不让页面默默失败）', async () => {
  const { InstallSummary } = await loadModule('client/panel.jsx')
  const html = renderToStaticMarkup(React.createElement(InstallSummary, {
    primitives: undefined, probe: null, probing: false, error: '自检通路不可用（host 半未加载）', installing: false, note: '', onCheck: () => {}, onInstall: () => {},
  }))
  assert.match(html, /role="alert"/)
  assert.match(html, /自检通路不可用/)
})
