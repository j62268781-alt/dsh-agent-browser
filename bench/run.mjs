#!/usr/bin/env node
/**
 * **任务基准**：把参考实现的任务集跑在本插件上，用页面内 JS 断言判对错。
 *
 *   node bench/run.mjs                       # 默认 tier=offline,base
 *   node bench/run.mjs --tier offline        # 只跑本地 fixture（离线、可重复）
 *   node bench/run.mjs --only ti-dropdown,wiki-link
 *   node bench/run.mjs --tier base --max-steps 8 --out bench/results/base.json
 *
 * 与 `pnpm bench` / `bench:vote` 的区别：那两个量时间与 token，**不判对错**；
 * 这个有 ground truth，能回答"哪些场景真的强 / 哪些会假完成"。
 *
 * 跑法：脚本自己起 cordis + dsh-judgment（与 `pnpm e2e` 同一条通路），
 * 真 Chrome（agent-browser 会话），每个任务先 close 再 open 一个新页面。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentBrowser } from '../lib/cli.js'
import { runTask } from '../lib/task.js'
import { stripBoundaries } from '../lib/extract.js'
import { globalArgsOf } from '../lib/index.js'
import { createLiveJudge } from '../scripts/live-judge.mjs'
import { readAgentBrowserConfig } from '../scripts/profile-config.mjs'
import { scoreTask } from './score.mjs'
import { TIERS } from './tasks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const flag = (name) => process.argv.includes(`--${name}`)

const tierNames = arg('tier', 'offline,base').split(',').filter(Boolean)
for (const name of tierNames) if (TIERS[name] === undefined) throw new Error(`未知 tier：${name}`)
const only = arg('only', undefined)?.split(',').filter(Boolean)
const maxStepsCap = Number(arg('max-steps', '10'))
const settleMs = Number(arg('settle', '300'))
const taskTimeoutMs = Number(arg('task-timeout', '180000'))
// **复用浏览器**：默认接一个已经存在的会话（用户开着的那扇窗口），不再自己冷启动。
// 想另起一个隔离会话时显式 --session <name>；想跑完关掉时加 --close。
const session = arg('session', 'default')
// 用哪条 judgment 连接（Settings → 决策 里配置的多条连接可以按名字选）。
const connectionName = arg('connection', undefined)
const connect = arg('connect', undefined)
const closeAtEnd = flag('close')
const out = resolve(arg('out', resolve(HERE, 'results', `run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`)))
const verbose = flag('verbose')

const tasks = tierNames.flatMap((name) => TIERS[name]).filter((task) => only === undefined || only.includes(task.id))
if (tasks.length === 0) throw new Error('没有匹配的任务')

const config = readAgentBrowserConfig()
const browser = new AgentBrowser({
  command: config.browser.executablePath ?? '',
  globalArgs: [
    ...globalArgsOf(config, session),
    ...(connect === undefined ? [] : ['--cdp', connect]),
  ],
  timeoutMs: 60_000,
})
const { judge, describe } = await createLiveJudge(config.judgment.purpose, connectionName)
const judgeOptions = {
  purpose: config.judgment.purpose,
  goalThreshold: 0.85,
  stuckThreshold: 0.85,
}
console.log(`judge: ${describe}`)
console.log(`tasks: ${tasks.length}（tier=${tierNames.join(',')}），maxSteps=${maxStepsCap}\n`)

/**
 * 打开并**核实**地址：共用同一个标签时，偶发 "open 返回成功但其实还停在上一个任务页"，
 * 会让后面的任务在错误的页面上跑（baseline-2 里 ti-entry-ad 跑到了 todomvc 页）。
 */
async function openVerified(url) {
  let last = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await browser.open(url)
    last = stripBoundaries(await browser.run(['get', 'url'])).trim()
    try {
      const want = new URL(url)
      const got = new URL(last)
      if (got.host === want.host && (want.pathname === '/' || got.pathname.startsWith(want.pathname))) return
    } catch {
      /* 解析失败就走重试 */
    }
  }
  throw new Error(`open 后地址不符：想要 ${url}，实际 ${last.slice(0, 120)}`)
}

/** `agent-browser eval` 的输出外面有内容边界，且结果常是 JSON 字符串。 */
async function evaluate(expression) {
  const script = `JSON.stringify((${expression})())`
  const raw = await browser.run(['eval', script])
  const inner = stripBoundaries(raw).trim()
  if (inner === '') return undefined
  let value = inner
  try { value = JSON.parse(inner) } catch { /* 非 JSON：原样返回 */ }
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return value }
  }
  return value
}

const records = []
for (const [index, task] of tasks.entries()) {
  const label = `[${index + 1}/${tasks.length}] ${task.id}`
  if (task.skip !== undefined) {
    records.push({ id: task.id, cat: task.cat, tier: tierNames.find((name) => TIERS[name].includes(task)), outcome: 'skipped', reason: task.skip })
    console.log(`${label} — 跳过（${task.skip}）`)
    continue
  }

  const started = Date.now()
  const record = {
    id: task.id, cat: task.cat, expect: task.expect ?? 'pass', guard: task.guard === true,
    tier: tierNames.find((name) => TIERS[name].includes(task)), url: task.url, steps: [],
  }
  const abort = new AbortController()
  // **复用同一个窗口**：open 只是把当前标签导航到新 URL，不必每任务 close 再冷启动
  // （一次冷启动 2–4s，25 条任务就是一分多钟的纯浪费）。
  const watchdog = setTimeout(() => abort.abort(new Error('task timeout')), taskTimeoutMs)
  try {
    await openVerified(task.url)
    for (const step of task.steps) {
      const stepStarted = Date.now()
      let result
      try {
        result = await runTask(step.goal, {
          browser,
          judge,
          signal: abort.signal,
          maxSteps: Math.min(step.maxSteps ?? maxStepsCap, maxStepsCap),
          ...judgeOptions,
          ...(step.values === undefined ? {} : { inputs: step.values }),
          allowIrreversible: task.guard !== true,
        })
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        record.steps.push({
          goal: step.goal, status: 'error', reason: message.slice(0, 300),
          truth: undefined, expectedStatus: step.expectStatus, calls: 0, tokens: 0, askMs: 0, ms: Date.now() - stepStarted,
        })
        record.error = message.slice(0, 500)
        break
      }

      if (settleMs > 0) await new Promise((done) => setTimeout(done, settleMs))
      let truth
      if (step.assert !== undefined) {
        try { truth = await evaluate(step.assert) } catch (error) { truth = `assert error: ${error instanceof Error ? error.message : String(error)}` }
      }

      record.steps.push({
        goal: step.goal,
        status: result.status,
        reason: result.reason,
        expectedStatus: step.expectStatus,
        truth,
        calls: result.usage.calls,
        tokens: result.usage.inputTokens,
        usd: Number(result.usage.estCostUsd.toFixed(6)),
        askMs: Math.round(result.timings.askMs),
        ms: Date.now() - stepStarted,
        rounds: result.steps.length,
      })
      const mark = truth === true ? '✓' : truth === false ? '✗' : '·'
      if (verbose) console.log(`    ${mark} ${result.status} · ${result.reason}`)
      // 断言为假且已经声称完成 → 后面不用再跑，避免在错误状态下继续烧钱。
      if (truth === false && (result.status === 'needs_verification' || result.status === 'likely_done')) break
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record.error = message.slice(0, 500)
    // 网络类失败（连不上站点）不能算"逻辑失败"：单独一档，否则基线会被机房网络污染。
    if (/(ERR_CONNECTION|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|net::ERR_|Navigation failed)/i.test(message)) record.network = true
    // 卡住的 JS dialog（confirm/prompt）会让后续每条命令都失败：先尝试关掉/接受它。
    if (/(dialog|JavaScript dialog|被取消|command was cancelled)/i.test(message)) {
      await browser.run(['dialog', 'dismiss']).catch(() => {})
    }
  } finally {
    clearTimeout(watchdog)
  }

  record.ms = Date.now() - started
  record.calls = record.steps.reduce((total, step) => total + (step.calls ?? 0), 0)
  record.tokens = record.steps.reduce((total, step) => total + (step.tokens ?? 0), 0)
  record.askMs = record.steps.reduce((total, step) => total + (step.askMs ?? 0), 0)
  record.outcome = record.network === true ? 'network' : 'evaluated'
  Object.assign(record, scoreTask(record, task.steps.length, record.expect))

  const last = record.steps.at(-1)
  const tag = record.correct ? '✓' : '✗'
  console.log(
    `${tag} ${task.id.padEnd(24)} ${String(last?.status ?? '-').padEnd(18)} truth=${String(last?.truth ?? '-').padEnd(5)} ` +
    `${record.steps.length}/${task.steps.length} steps · ${record.calls} calls · ${(record.ms / 1000).toFixed(1)}s` +
    `${record.falseDone ? '  **FALSE-DONE**' : ''}${record.missed ? '  missed' : ''}${record.error === undefined ? '' : `  error=${record.error.slice(0, 120)}`}`,
  )
  records.push(record)
}

// 默认**不关**浏览器：下次跑直接复用同一扇窗口（冷启动 2–4s，还容易触发风控）。
if (closeAtEnd) await browser.close().catch(() => {})

const summary = (await import('./score.mjs')).summarize(records)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ summary, describe, argv: process.argv.slice(2), records }, null, 1))
console.log(`\n${summary.correct}/${summary.tasks} correct · ${summary.falseDone} false-done · ${summary.missed} missed · ` +
  `${summary.calls} judge calls · ${summary.tokens} tokens · ${(summary.ms / 1000).toFixed(1)}s`)
if (summary.skipped > 0) console.log(`skipped: ${summary.skipped}`)
console.log(`status: ${Object.entries(summary.statuses).map(([name, count]) => `${name}=${count}`).join(' ')}`)
console.log(`→ ${out}`)
if (summary.falseDone > 0) process.exitCode = 1
