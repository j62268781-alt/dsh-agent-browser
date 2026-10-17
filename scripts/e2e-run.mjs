#!/usr/bin/env node
/**
 * **端到端验证**：真 Chrome + 真 agent-browser CLI + 真 Jev 决策。
 *
 * 与 `tests/task.test.mjs` 的分工：那里 judge / 浏览器都是替身，验的是**循环纪律**；
 * 这里两者都是真的，验的是"接线到底通不通、页面到底有没有被推到目标"。
 *
 * 流程：
 *   1. 起一个本地页面（两步才出现 SUCCESS，逼着循环跨两次决策 + 新候选出现）；
 *   2. 用 desktop profile 里 `judgment/provider` 的连接 + 本机凭据存储里的 key
 *      boot 一个**真的** dsh-judgment Service（与插件运行期同一条 ask 通路）；
 *   3. 用本插件的 `AgentBrowser` + `runTask` 跑目标；
 *   4. 跑完**独立验证**：重新读页面文本确认 SUCCESS 真的在（不信任 runTask 的自我汇报）。
 *
 * 密钥永不回显；用法：`pnpm e2e`（离线环境会自动跳过并说明原因）。
 */

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createLiveJudge } from './live-judge.mjs'
import { globalArgsOf } from '../lib/index.js'
import { readAgentBrowserConfig } from './profile-config.mjs'
import { AgentBrowser } from '../lib/cli.js'
import { runTask } from '../lib/task.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SESSION = 'dsh-ab-e2e'
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

/* ───────────────────── 1) 本地页面：两步才成功 ───────────────────── */

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>E2E 测试页</title></head>
<body>
  <h1>浏览器决策端到端测试</h1>
  <p id="status">初始状态</p>
  <button id="start">开始</button>
  <label>备注 <input id="note" type="text" /></label>
  <script>
    // 事件用 addEventListener 绑定：**别写内联 onclick**——多行的内联属性会被当成按钮的可访问名
    // （真机踩过：按钮名变成半截脚本，模型点了也执行不到）。
    document.getElementById('start').addEventListener('click', () => {
      document.getElementById('status').textContent = '第一步完成，请确认';
      const next = document.createElement('button');
      next.id = 'confirm';
      next.textContent = '确认结果';
      next.addEventListener('click', () => {
        // 成功标志运行期拼出来：HTML/脚本源码里不出现完整标志，避免"源码里有"被误判成"页面显示了"
        document.getElementById('status').textContent = ['SUCC', 'ESS', ': 已完成'].join('');
      });
      document.body.appendChild(next);
      document.getElementById('start').remove();
    });
  </script>
</body></html>`

const server = createServer((request, response) => {
  if (request.url === '/favicon.ico') {
    response.writeHead(204).end()
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(PAGE)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
console.log(`本地页面 ${url}`)

/* ───────────────────── 2) 真 judge（dsh-judgment Service） ───────────────────── */

let judge
let judgeDescription = ''
try {
  const live = await createLiveJudge('browser.action')
  judge = live.judge
  judgeDescription = live.describe
  console.log(`judge 就绪：${judgeDescription}`)
} catch (error) {
  console.error(`\n跳过：拿不到 judgment 连接或凭据 —— ${error instanceof Error ? error.message : String(error)}`)
  server.close()
  process.exit(0)
}

/* ───────────────────── 3) 真浏览器 + 真决策循环 ───────────────────── */

// **跟着 profile 里的插件配置走**（有头/无头、白名单、idleTimeout…），与插件同一套 globalArgs。
const config = readAgentBrowserConfig()
const browser = new AgentBrowser({
  command: config.browser.executablePath ?? '',
  globalArgs: globalArgsOf(config, SESSION),
  timeoutMs: Math.max(Number(config.limits.commandTimeoutMs) || 30_000, 60_000),
})
console.log(`配置来源：${config.source} · 有头模式：${globalArgsOf(config, SESSION).includes('--headed') ? '开' : '关'}`)

let exitCode = 0
try {
  const title = await browser.version()
  console.log(`CLI 版本 ${title}\n`)
  await browser.close().catch(() => {})
  await browser.open(url)
  const openedUrl = await browser.get('url', undefined, undefined).catch((error) => `ERR ${error.message.slice(0, 80)}`)
  const opened = await browser.snapshot({ interactiveOnly: true })
  console.log(`open 之后 get url = ${openedUrl}`)
  console.log(`打开后 origin=${opened.origin} refs=${Object.keys(opened.refs).length} 个：${Object.entries(opened.refs).map(([r, i]) => `${r}:${i.role}:${i.name}`).join(' ')}`)

  const result = await runTask('让页面上的状态文字显示 SUCCESS', {
    browser,
    judge,
    purpose: 'browser.action',
    maxSteps: 8,
    goalThreshold: 0.85,
    stuckThreshold: 0.85,
    signal: new AbortController().signal,
  })

  console.log('\n执行轨迹')
  for (const line of result.trace) console.log(`  · ${line}`)
  console.log(`\n结果 status=${result.status} reason=${result.reason}`)
  console.log(`judge 调用 ${result.usage.calls} 次 · tokens in=${result.usage.inputTokens} out=${result.usage.outputTokens}`)
  const executed = result.steps.filter((step) => step.executed)
  console.log(`实际执行动作 ${executed.length} 个：${executed.map((step) => step.action).join(' → ')}`)

  /* ───────── 4) 独立验证：不信任 runTask 的自我汇报 ───────── */
  console.log('\n独立验证（重新读页面，不信 runTask 的自述）')
  // 只看**可见的** #status 文本（不信任整页 HTML，也不信任 runTask 的自述）
  const status = await browser.get('text', '#status', undefined)
  check('可见状态文字真的是 SUCCESS', /SUCCESS/.test(status), JSON.stringify(status))
  check('不是初始状态', !/初始状态/.test(status), JSON.stringify(status))
  check('运行状态是 needs_verification（不是"已完成"）', result.status === 'needs_verification', result.status)
  check('至少真的执行过一个动作', executed.length >= 1)
  check('judge 真的被调用过', result.usage.calls >= 1)
  check('给了交回宿主的下一步提示', typeof result.next === 'string' && result.next.includes('browser_read'))

  const shot = await browser.screenshot(join(REPO, 'node_modules/.cache/e2e-run.png'), true)
  console.log(`  截图 ${shot}`)
} catch (error) {
  console.error(`\n端到端失败：${error instanceof Error ? error.stack : String(error)}`)
  failures.push(`异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await browser.close().catch(() => {})
  server.close()
}

console.log('')
if (failures.length > 0) {
  console.error(`✗ 端到端未通过（${failures.length} 项）`)
  for (const failure of failures) console.error(`  - ${failure}`)
  exitCode = 1
} else {
  console.log('✓ 端到端通过：真浏览器 + 真 Jev 决策，页面被推到目标且独立验证成立')
}
process.exit(exitCode)
