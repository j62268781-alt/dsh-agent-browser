#!/usr/bin/env node
/**
 * 对照 bench：跑 **jev-ultrafast 的本地酒店 fixture**（他们公布的实测：1.896 s）。
 *
 * 任务（与他们的 case 一致）：搜索 Lisbon → 分类 Design → 勾 Free cancellation → 打开 Casa Flora。
 *
 * 与他们的设计差异：**文字/选择由宿主填**（插件返回 `input_required`，绝不猜），
 * 他们用一个便宜的辅助模型生成文字（本 fixture 是复制 goal 里的引号值，0 次文本调用）。
 * 所以这里用"宿主按阶段交办"的方式跑，耗时里包含宿主填字段的时间。
 *
 * 用法：node scripts/bench-fixture.mjs [url]
 */
import { AgentBrowser } from '../lib/cli.js'
import { runTask } from '../lib/task.js'
import { createLiveJudge } from './live-judge.mjs'
import { readAgentBrowserConfig } from './profile-config.mjs'
import { globalArgsOf } from '../lib/index.js'

const URL = process.argv[2] ?? 'http://127.0.0.1:8899/fixture.html'
const PHASES = [
  { goal: 'type Lisbon into the Destination field', fill: 'Lisbon' },
  { goal: 'submit the search with the Find stays button' },
  { goal: 'choose Design in the Category selector', select: 'Design' },
  { goal: 'enable the Free cancellation checkbox' },
  { goal: 'open the Casa Flora stay' },
]
const config = readAgentBrowserConfig()
const browser = new AgentBrowser({
  command: config.browser.executablePath ?? '',
  globalArgs: globalArgsOf(config, 'dsh-ab-fixture'),
  timeoutMs: 60_000,
})
const { judge } = await createLiveJudge()

const started = performance.now()
let calls = 0
let tokens = 0
const traceAll = []
try {
  await browser.close().catch(() => {})
  await browser.open(URL)
  for (const phase of PHASES) {
    const result = await runTask(phase.goal, {
      browser, judge,
      purpose: config.judgment.purpose,
      maxSteps: 3,
      goalThreshold: 0.85,
      stuckThreshold: 0.85,
      signal: new AbortController().signal,
    })
    calls += result.usage.calls
    tokens += result.usage.inputTokens
    traceAll.push(`[${phase.goal}] → ${result.status}${result.steps.length > 0 ? ` · ${result.steps.at(-1).action}` : ''}`)
    for (const line of result.trace) traceAll.push(`    ${line}`)
    if (result.status === 'input_required' && (phase.fill !== undefined || phase.select !== undefined)) {
      // 宿主按**错误里点名的角色**找字段（真机踩过：盲取"第一个输入框"会把 Design 选到搜索框上）
      const wanted = /需要\s*(\w+)/.exec(result.reason)?.[1]?.toLowerCase() ?? ''
      const page = await browser.extract({})
      const field = page.items.find((item) => item.role.toLowerCase() === wanted)
        ?? page.items.find((item) => /textbox|searchbox|combobox/.test(item.role.toLowerCase()))
      if (field === undefined) throw new Error(`需要输入但抽不到字段（${result.reason}）`)
      traceAll.push(`    宿主填 ${field.role}「${field.name}」`);
      const handle = `[data-dsh-idx="${field.index}"]`
      if (phase.select !== undefined) await browser.act('select', handle, { value: phase.select })
      else await browser.act('fill', handle, { value: phase.fill })
    }
  }
  const totalMs = performance.now() - started
  const title = await browser.get('title', undefined, undefined).catch(() => '')
  const text = await browser.read(undefined).catch(() => '')
  const checks = {
    'Casa Flora': /Casa Flora/.test(text),
    'Destination Lisbon': /Destination Lisbon/.test(text),
    'Design 分类': /Design/.test(text),
    'Free cancellation 已勾选': /Free cancellation enabled/.test(text),
  }
  console.log(`\n总耗时 ${totalMs.toFixed(0)} ms · Jev ${calls} 次 · tokens ${tokens}（他们公布 1.896 s）`)
  for (const line of traceAll) console.log(`  ${line}`)
  console.log(`独立验证：标题「${title.slice(0, 40)}」`)
  for (const [label, ok] of Object.entries(checks)) console.log(`  ${ok ? '✓' : '✗'} ${label}`)
  console.log(`结论：${Object.values(checks).every(Boolean) ? '任务达成 ✓' : '任务未完全达成 ✗'}`)
} catch (error) {
  console.error(`失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
}
