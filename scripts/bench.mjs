#!/usr/bin/env node
/**
 * **耗时基准**：同一个任务、两种模式，量"决策"到底值不值。
 *
 * 任务（可重复、无验证码）：在 hao123 首页点开「12306」链接。
 *
 * 三种耗时：
 *   1. **CLI 固定成本**（与模式无关）：open / snapshot / click / read / title；
 *   2. **有决策**（`browser_run`）：每步 `snapshot → ctx.judgment 选动作 → 执行`；
 *      量总耗时、步数、Jev 调用次数、token；
 *   3. **无决策**（原子工具）：每步固定成本相同，但"选动作"由**调用方模型**做——
 *      这部分由上游 agent 决定，真机对照见 `scripts/live-profile.mjs` + DESIGN。
 *
 * 用法：`pnpm bench`（需要 judgment 凭据，与 `pnpm try` 同一套）
 */

import { AgentBrowser } from '../lib/cli.js'
import { runTask } from '../lib/task.js'
import { createLiveJudge } from './live-judge.mjs'
import { readAgentBrowserConfig } from './profile-config.mjs'
import { globalArgsOf } from '../lib/index.js'

const SITE = 'https://www.hao123.com/'
const TARGET = '切换城市'
const GOAL = `点击页面顶部的城市切换入口（名称含「${TARGET}」），打开城市选择面板`
const SESSION = 'dsh-ab-bench'

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000 // ms
async function timed(label, run) {
  const started = now()
  const result = await run()
  const ms = now() - started
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(0).padStart(6)} ms`)
  return { ms, result }
}

const config = readAgentBrowserConfig()
const globalArgs = globalArgsOf(config, SESSION)
const headed = globalArgs.includes('--headed')
const browser = new AgentBrowser({
  command: config.browser.executablePath ?? '',
  globalArgs,
  timeoutMs: 60_000,
})
const { judge, describe } = await createLiveJudge()
console.log(`judge：${describe}`)
console.log(`站点：${SITE} · 任务：${GOAL} · 有头：${headed ? '开' : '关'}`)

try {
  await browser.close().catch(() => {})

  const open = await timed('打开页面（含落地等待）', () => browser.open(SITE))

  console.log('\n① 无决策（原子工具的固定成本）')
  const snapshots = []
  for (let index = 1; index <= 3; index += 1) {
    const snap = await timed(`snapshot #${index}`, () => browser.snapshot({ interactiveOnly: true }))
    snapshots.push(snap.ms)
  }
  const state = await browser.snapshot({ interactiveOnly: true })
  const findTarget = async () => {
    const fresh = await browser.snapshot({ interactiveOnly: true })
    return Object.entries(fresh.refs).find(([, info]) => info.name.includes(TARGET) && info.role.toLowerCase() !== 'link')?.[0]
  }
  let target = await findTarget()
  if (target === undefined) throw new Error(`没找到「${TARGET}」链接`)
  // 门户页有广告遮罩：点不动就重取快照再点一次（真实调用方也会这么做）
  const click = await timed(`click @${target}「${TARGET}」`, async () => {
    try {
      return await browser.act('click', `@${target}`)
    } catch {
      target = await findTarget()
      return browser.act('click', `@${target}`)
    }
  })
  const read = await timed('read（结果页正文）', () => browser.read(undefined))
  const title = await timed('get title', () => browser.get('title', undefined, undefined))

  console.log('\n② 有决策（browser_run：ctx.judgment 每步选动作）')
  await browser.open(SITE)
  const decision = await timed('browser_run', () =>
    runTask(GOAL, {
      browser,
      judge,
      purpose: config.judgment.purpose,
      maxSteps: 4,
      goalThreshold: Number(config.limits.goalThreshold) || 0.85,
      stuckThreshold: Number(config.limits.stuckThreshold) || 0.85,
      signal: new AbortController().signal,
    }))

  const snapshotAvg = snapshots.reduce((sum, value) => sum + value, 0) / snapshots.length
  console.log('\n分项（毫秒）')
  console.log(`  open ${open.ms.toFixed(0)} · snapshot 均值 ${snapshotAvg.toFixed(0)} · click ${click.ms.toFixed(0)} · read ${read.ms.toFixed(0)} · title ${title.ms.toFixed(0)}`)
  // 无决策的固定成本 = 打开 + 快照 + 点击；**再加**调用方模型每一步的决策时间
  const atomicFixed = open.ms + snapshotAvg + click.ms
  console.log(`  无决策固定成本（open+snapshot+click）= ${atomicFixed.toFixed(0)} ms，另加调用方模型每步的决策时间`)
  const d = decision.result
  console.log(`  有决策总耗时 = ${decision.ms.toFixed(0)} ms · status=${d.status} · steps=${d.steps.length} · Jev ${d.usage.calls} 次 · tokens ${d.usage.inputTokens} · 估算 $${(d.usage.estCostUsd ?? 0).toFixed(6)}`)
  console.log(`  分项实测：snapshot ${d.timings.snapshotMs}ms · read ${d.timings.readMs}ms · title ${d.timings.titleMs}ms · ask ${d.timings.askMs}ms · act ${d.timings.actMs}ms · 总计 ${d.timings.totalMs}ms`)
  for (const line of decision.result.trace) console.log(`    · ${line}`)
  const finalUrl = await browser.get('url', undefined, undefined).catch(() => '')
  console.log(`  最终 URL：${finalUrl}`)
} catch (error) {
  console.error(`基准失败：${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
} finally {
  if (!headed) await browser.close().catch(() => {})
}
