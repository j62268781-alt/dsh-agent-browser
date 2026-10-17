#!/usr/bin/env node
/**
 * 对照 bench：**jev-ultrafast 的本地酒店 fixture**（他们公布 1.896 s）。
 *
 * 任务：搜索 Lisbon → 分类 Design → 勾 Free cancellation → 打开 Casa Flora。
 *
 * 两种跑法对比：
 *   A. `inputs` 模式（新增）：**一次** `browser_run` 调用就把字段值给进来，插件在同一轮里填/选/勾；
 *   B. 分阶段模式（旧）：每个字段返回 `input_required`，宿主填完再调一次（每字段一轮）。
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
  { goal: 'type Lisbon into the Destination field', inputs: { Destination: 'Lisbon' } },
  { goal: 'submit the search with the Find stays button' },
  { goal: 'choose the Design category in the Category selector', inputs: { 'Stay category': 'Design' } },
  { goal: 'enable the Free cancellation checkbox', inputs: { 'Free cancellation': 'true' } },
  { goal: 'open the Casa Flora stay' },
]
const config = readAgentBrowserConfig()
const browser = new AgentBrowser({ command: config.browser.executablePath ?? '', globalArgs: globalArgsOf(config, 'dsh-ab-fixture'), timeoutMs: 60_000 })
const { judge } = await createLiveJudge()
const judgeOptions = { purpose: config.judgment.purpose, maxSteps: 4, goalThreshold: 0.85, stuckThreshold: 0.85 }

async function verify() {
  const title = await browser.get('title', undefined, undefined).catch(() => '')
  const text = await browser.read(undefined).catch(() => '')
  return {
    title,
    checks: {
      'Casa Flora': /Casa Flora/.test(text),
      'Destination Lisbon': /Destination Lisbon/.test(text),
      'Design 分类': /Design/.test(text),
      'Free cancellation 已勾选': /Free cancellation enabled/.test(text),
    },
  }
}

async function run(label, useInputs) {
  await browser.close().catch(() => {})
  await browser.open(URL)
  const started = performance.now()
  let calls = 0
  let tokens = 0
  let hostFills = 0
  for (const phase of PHASES) {
    let result
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await runTask(phase.goal, {
        browser, judge, signal: new AbortController().signal, ...judgeOptions,
        ...(useInputs && phase.inputs !== undefined ? { inputs: phase.inputs } : {}),
      })
      calls += result.usage.calls
      tokens += result.usage.inputTokens
      if (result.status !== 'input_required') break
      // 无 inputs 时：宿主按角色自己填（这就是"每个字段多一轮"的成本）
      const wanted = /需要\s*(\w+)/.exec(result.reason)?.[1]?.toLowerCase() ?? ''
      const page = await browser.extract({})
      const field = page.items.find((item) => item.role.toLowerCase() === wanted)
      if (field === undefined) break
      const handle = `[data-dsh-idx="${field.index}"]`
      if (field.role.toLowerCase() === 'combobox') await browser.act('select', handle, { value: 'Design' })
      else if (field.role.toLowerCase() === 'checkbox') await browser.act('check', handle, {})
      else await browser.act('fill', handle, { value: 'Lisbon' })
      hostFills += 1
    }
  }
  const totalMs = performance.now() - started
  const { title, checks } = await verify()
  const ok = Object.values(checks).every(Boolean)
  console.log(`\n=== ${label} ===`)
  console.log(`耗时 ${totalMs.toFixed(0)} ms · Jev ${calls} 次 · tokens ${tokens} · 宿主补填 ${hostFills} 次 · ${ok ? '达成 ✓' : '未达成 ✗'}`)
  console.log(`验证（${title.slice(0, 30)}）：${Object.entries(checks).map(([name, pass]) => `${pass ? '✓' : '✗'} ${name}`).join(' · ')}`)
  return { totalMs, calls, tokens, ok, hostFills }
}

try {
  const withInputs = await run('A. inputs 模式（字段值一次给进来）', true)
  const phased = await run('B. 无 inputs（字段值交回宿主填）', false)
  console.log('\n对照（他们公布 1.896 s）：')
  console.log(`  A: ${withInputs.totalMs.toFixed(0)}ms · ${withInputs.calls} 次判断 · ${withInputs.tokens} tokens · 宿主补填 ${withInputs.hostFills} · ${withInputs.ok ? '达成 ✓' : '未达成 ✗'}`)
  console.log(`  B: ${phased.totalMs.toFixed(0)}ms · ${phased.calls} 次判断 · ${phased.tokens} tokens · 宿主补填 ${phased.hostFills} · ${phased.ok ? '达成 ✓' : '未达成 ✗'}`)
} catch (error) {
  console.error(`失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await browser.close().catch(() => {})
}
