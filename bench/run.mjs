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
import {
  annotateInitialStateStability,
  benchmarkOriginOf,
  isolateStorage,
  openWithEvidence,
  stepDiagnostics,
  summarizeNav,
} from './nav.mjs'

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
// 每个任务前清 cookie：任务之间共享标签会把上一条任务的登录态带进下一条
// （基线里 login-wall 因此在已登录状态下被判成完成）。
const clearCookies = !flag('no-clear')
// 0A：每个任务起始清**该任务 origin** 的 localStorage/sessionStorage 并 reload
// （TodoMVC 用 localStorage 持久化，复用标签会互相污染）。只清 benchmark 任务来源。
// `--no-isolate` 可关掉做对照。清理证据写在每条 record 的 nav.storage 里。
const isolateState = !flag('no-isolate')
const out = resolve(arg('out', resolve(HERE, 'results', `run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`)))
const verbose = flag('verbose')
// 把决策 trace 存进结果（定位"为什么在 bench 里失败、单独跑却通过"这类上下文差异）。
const keepTrace = flag('trace')
// **每任务重复跑 N 次**：同一份代码的正确数在 13–16/39 之间波动，单次基线不足以判断改动。
// repeat>1 时每条 record 带 run 字段，最后额外打印"多数票"结果（tie 不算通过）。
const repeat = Math.max(1, Number(arg('repeat', '1')) || 1)

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
// 导航/隔离探针的依赖：注入之后 nav.mjs 可以在单测里用假浏览器驱动（无需真 Chrome）。
const navDeps = {
  open: (url) => browser.open(url, { timeoutMs: 20000 }),
  readUrl: async () => stripBoundaries(await browser.run(['get', 'url'])).trim(),
  evaluate: (expression) => evaluate(expression),
  reload: () => browser.run(['reload']),
  waitForReady: (options) => browser.waitForReady(options),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
}
// 允许清理 storage 的来源 = 任务集里出现的 http(s) origin。别的来源一律拒绝（0A 安全门）。
const BENCH_ORIGINS = new Set(tasks.map((task) => benchmarkOriginOf(task.url)).filter((origin) => origin !== ''))
const { judge, describe } = await createLiveJudge(config.judgment.purpose, connectionName)
const judgeOptions = {
  purpose: config.judgment.purpose,
  goalThreshold: 0.85,
  stuckThreshold: 0.85,
}
console.log(`judge: ${describe}`)
console.log(`tasks: ${tasks.length}（tier=${tierNames.join(',')}），maxSteps=${maxStepsCap}\n`)

/**
 * 打开并**核实**地址（0B：证据化）——判定口径保持不变：
 * **只核对 host**（登录墙/重定向是任务场景本身），path/query/hash 与 open 后二次导航
 * 全部写进 `record.nav` 供归因，不改评分。实现见 bench/nav.mjs。
 */
async function openTaskPage(task) {
  return openWithEvidence(task.url, navDeps, { readyTimeoutMs: 3000, stablePolls: 3, pollMs: 120 })
}

/** 0A：任务起始清该任务 origin 的 storage 并 reload；证据写到 record.nav.storage。 */
async function isolateTaskState(task, nav) {
  return isolateStorage(task.url, navDeps, {
    allowedOrigins: BENCH_ORIGINS,
    // open 后的最终地址（避免为了"当前 origin"再花一次 CLI 往返）。
    currentUrl: nav.url_settled !== '' ? nav.url_settled : nav.url_after_ready,
    readyTimeoutMs: 3000,
  })
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
for (let run = 1; run <= repeat; run += 1) {
if (repeat > 1) console.log(`\n===== 轮次 ${run}/${repeat} =====`)
for (const [index, task] of tasks.entries()) {
  const label = `[${index + 1}/${tasks.length}] ${task.id}`
  if (task.skip !== undefined) {
    records.push({ id: task.id, cat: task.cat, run, tier: tierNames.find((name) => TIERS[name].includes(task)), outcome: 'skipped', reason: task.skip })
    console.log(`${label} — 跳过（${task.skip}）`)
    continue
  }

  const started = Date.now()
  const record = {
    id: task.id, cat: task.cat, run, expect: task.expect ?? 'pass', guard: task.guard === true,
    tier: tierNames.find((name) => TIERS[name].includes(task)), url: task.url, steps: [],
    // 0B：导航诊断（只做归因，不参与 scoreTask 的 correct/false-done 判定）。
    nav: {},
  }
  const abort = new AbortController()
  // **复用同一个窗口**：open 只是把当前标签导航到新 URL，不必每任务 close 再冷启动
  // （一次冷启动 2–4s，25 条任务就是一分多钟的纯浪费）。
  const watchdog = setTimeout(() => abort.abort(new Error('task timeout')), taskTimeoutMs)
  try {
    if (clearCookies) await browser.run(['cookies', 'clear']).catch(() => {})
    // 上一条任务可能留下未处理的 confirm/prompt（会让后续所有命令报 "dialog is blocking"）。
    await browser.run(['dialog', 'dismiss']).catch(() => {})
    const nav = await openTaskPage(task)
    // 先把证据放进 record，再决定是否抛错：跑错页面的现场不能随异常丢掉。
    record.nav = { ...nav }
    if (nav.ok !== true) {
      throw new Error(`open 后地址不符：想要 ${task.url}，实际 ${String(nav.url_after_open).slice(0, 120)}`)
    }
    if (verbose) {
      const bits = [`nav=${nav.diagnosis}`, `after_open=${nav.url_after_open.slice(0, 100)}`]
      if (nav.url_changed_during_ready || nav.url_changed_after_ready) bits.push(`url_changed(during_ready=${nav.url_changed_during_ready},after_ready=${nav.url_changed_after_ready})`)
      if (nav.stable === false) bits.push(`unstable(polls=${nav.url_polls.map((poll) => poll.url).join(' → ')})`)
      if (nav.same_host_other_path) bits.push(`path_differs(after_open=${nav.url_after_open.slice(0, 100)})`)
      console.log(`  ${bits.join(' · ')}`)
    }
    if (isolateState) {
      record.nav.storage = await isolateTaskState(task, nav)
      const storage = record.nav.storage
      if (verbose) {
        console.log(storage.skipped === undefined
          ? `  隔离 storage：cleared=${storage.storage_cleared} before=${storage.storage_before.local_count + storage.storage_before.session_count} reload=${storage.reloaded} dom=${storage.initial_dom?.digest ?? '-'}${storage.error === undefined ? '' : ` error=${storage.error}`}`
          : `  隔离 storage：跳过（${storage.skipped}）`)
      }
    }
    // runTask 前的地址只在 isolation reload 之后读才算数（open 时的地址早已作废）。
    record.nav.url_before_runTask = await navDeps.readUrl().catch(() => '')
    for (const step of task.steps) {
      const stepStarted = Date.now()
      // 每步 runTask 前的地址；第 1 步复用任务级读数，避免多一次 CLI 往返。
      const urlBeforeRunTask = record.steps.length === 0 ? record.nav.url_before_runTask : await navDeps.readUrl().catch(() => '')
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
          nav: { url_before_runTask: urlBeforeRunTask },
        })
        record.error = message.slice(0, 500)
        break
      }

      if (settleMs > 0) await new Promise((done) => setTimeout(done, settleMs))
      // 断言前地址：区分"动作生效但页面没跳" / "断言执行期间页面又跳走"。
      const urlBeforeAssert = await navDeps.readUrl().catch(() => '')
      let truth
      if (step.assert !== undefined) {
        try { truth = await evaluate(step.assert) } catch (error) { truth = `assert error: ${error instanceof Error ? error.message : String(error)}` }
      }
      const urlAfterAssert = await navDeps.readUrl().catch(() => '')

      const stepNav = {
        url_before_runTask: urlBeforeRunTask,
        // 0B 原文要的 result.url 原样留一个字段，url_after_runTask 同名同值方便对照。
        result_url: typeof result.url === 'string' ? result.url : '',
        url_after_runTask: typeof result.url === 'string' ? result.url : '',
        url_before_assert: urlBeforeAssert,
        url_after_assert: urlAfterAssert,
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
        nav: stepNav,
        // 0B：result.steps 的诊断子集（origin/action/executed/reason/digest），不送模型。
        resultSteps: stepDiagnostics(result.steps),
        ...(keepTrace ? { trace: result.trace } : {}),
      })
      const mark = truth === true ? '✓' : truth === false ? '✗' : '·'
      if (verbose) {
        console.log(`    ${mark} ${result.status} · ${result.reason}`)
        if (stepNav.url_before_assert !== stepNav.url_after_runTask) console.log(`    url: runTask→${stepNav.url_after_runTask.slice(0, 100)} assert前→${stepNav.url_before_assert.slice(0, 100)}`)
      }
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
  const navTag = record.nav !== undefined && record.nav.diagnosis !== undefined && record.nav.diagnosis !== 'ok'
    ? `  nav=${record.nav.diagnosis}`
    : ''
  console.log(
    `${tag} ${task.id.padEnd(24)} ${String(last?.status ?? '-').padEnd(18)} truth=${String(last?.truth ?? '-').padEnd(5)} ` +
    `${record.steps.length}/${task.steps.length} steps · ${record.calls} calls · ${(record.ms / 1000).toFixed(1)}s` +
    `${record.falseDone ? '  **FALSE-DONE**' : ''}${record.missed ? '  missed' : ''}${navTag}${record.error === undefined ? '' : `  error=${record.error.slice(0, 120)}`}`,
  )
  records.push(record)
}
}

// 默认**不关**浏览器：下次跑直接复用同一扇窗口（冷启动 2–4s，还容易触发风控）。
if (closeAtEnd) await browser.close().catch(() => {})

const summary = (await import('./score.mjs')).summarize(records)
// 0A 的可重复性证据：repeat>1 时比较同一 task 每次启动的 storage/DOM 初始态摘要。
const initialStability = annotateInitialStateStability(records)
const navSummary = summarizeNav(records)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ summary, navSummary, initialStability, describe, argv: process.argv.slice(2), records }, null, 1))
console.log(`\n${summary.correct}/${summary.tasks} correct · ${summary.falseDone} false-done · ${summary.missed} missed · ` +
  `${summary.calls} judge calls · ${summary.tokens} tokens · ${(summary.ms / 1000).toFixed(1)}s`)
if (summary.skipped > 0) console.log(`skipped: ${summary.skipped}`)
console.log(`status: ${Object.entries(summary.statuses).map(([name, count]) => `${name}=${count}`).join(' ')}`)
// 导航诊断（只读）：区分"跑错页面/迟到导航"和"逻辑失败"。
console.log(`nav: host_mismatch=${navSummary.counts.hostMismatch} unstable=${navSummary.counts.urlUnstable} ` +
  `late_navigation=${navSummary.counts.lateNavigation} same_host_other_path=${navSummary.counts.sameHostOtherPath} ` +
  `ready_timeout=${navSummary.counts.readyTimeout}`)
if (navSummary.counts.storageRan > 0 || navSummary.counts.storageSkipped > 0 || navSummary.counts.storageErrors > 0) {
  console.log(`storage 隔离：ran=${navSummary.counts.storageRan} cleared=${navSummary.counts.storageCleared} ` +
    `skipped=${navSummary.counts.storageSkipped} errors=${navSummary.counts.storageErrors}`)
}
if (navSummary.problems.length > 0) console.log(`导航问题：${navSummary.problems.join(' ')}`)
if (initialStability.compared > 0) {
  console.log(`初始态可重复：${initialStability.stable}/${initialStability.compared} 个任务` +
    (initialStability.unstable.length === 0 ? '' : ` · 不稳定：${initialStability.unstable.join(' ')}`))
}
console.log(`→ ${out}`)
if (summary.falseDone > 0) process.exitCode = 1

// repeat>1：按任务做多数票（tie 不算通过），避免被单次抖动带偏结论。
if (repeat > 1) {
  const groups = new Map()
  for (const record of records) {
    if (record.outcome === 'skipped') continue
    const list = groups.get(record.id) ?? []
    list.push(record)
    groups.set(record.id, list)
  }
  let ok = 0
  let falseDone = 0
  const unstable = []
  for (const [id, list] of groups) {
    const votes = list.filter((record) => record.correct === true).length
    const falseVotes = list.filter((record) => record.falseDone === true).length
    if (votes * 2 > list.length) ok += 1
    if (falseVotes * 2 >= list.length) falseDone += 1
    if (votes > 0 && votes < list.length) unstable.push(`${id}(${votes}/${list.length})`)
  }
  console.log(`\n多数票（repeat=${repeat}）：${ok}/${groups.size} 正确 · ${falseDone} 条 false-done`)
  if (unstable.length > 0) console.log(`跑不稳的任务：${unstable.join(' ')}`)
}
