#!/usr/bin/env node
/**
 * **手试工具**：拿一句自然语言 goal 驱动真浏览器（真 Chrome + 真 Jev）。
 *
 * 和 `pnpm e2e` 的分工：e2e 是固定场景的回归（本地页面、断言写死）；
 * 这里是"随手试一个真实网站"，goal 和验证条件都从命令行给。
 *
 * 用法：
 *   pnpm try --url https://jevusers.com/ --goal "把分类切到 Browser，然后打开 jev-browser-use 的页面" \
 *            --expect "jev-browser-use"
 *
 * 参数：
 *   --url <url>      先打开这个页面（不给就用当前会话的页面）
 *   --goal <text>    交给 ctx.judgment 的目标（必填）
 *   --expect <re>    结束后的独立验证：最终 URL 或标题匹配这个正则（可选）
 *   --steps <n>      最大步数（默认 12）
 *   --headed         显示浏览器窗口
 *
 * **不信任 runTask 的自我汇报**：结束后自己再看一眼 URL / 标题 / 正文。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentBrowser } from '../lib/cli.js'
import { globalArgsOf } from '../lib/index.js'
import { runTask } from '../lib/task.js'
import { createLiveJudge } from './live-judge.mjs'
import { readAgentBrowserConfig } from './profile-config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

function readArgs(argv) {
  const args = { maxSteps: 12, headed: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--url') { args.url = value; index += 1 }
    else if (flag === '--goal') { args.goal = value; index += 1 }
    else if (flag === '--expect') { args.expect = value; index += 1 }
    else if (flag === '--steps') { args.maxSteps = Number(value); index += 1 }
    else if (flag === '--headed') { args.headed = true }
  }
  return args
}

const args = readArgs(process.argv.slice(2))
if (args.goal === undefined) {
  console.error('用法：pnpm try --url <url> --goal "<目标>" [--expect <正则>] [--steps 12] [--headed]')
  process.exit(2)
}

const { judge, describe } = await createLiveJudge()
console.log(`judge：${describe}`)
console.log(`goal ：${args.goal}`)

// **按 profile 里的插件配置**组装全局参数（与插件同一个 `globalArgsOf`）：
// 这样用户在设置页打开的 `browser.headed`（有头模式）、白名单、idleTimeout 都会生效。
const config = readAgentBrowserConfig()
const globalArgs = globalArgsOf(config, 'dsh-ab-try')
if (args.headed === true && !globalArgs.includes('--headed')) globalArgs.push('--headed')
console.log(`配置来源：${config.source}`)
console.log(`有头模式：${globalArgs.includes('--headed') ? '开（会弹出浏览器窗口）' : '关（无头）'} · idleTimeout=${config.browser.idleTimeout || '默认'}`)
// 手试的是**真实站点**：慢站（首次 TTFB 5s+）要更宽的预算，CLI 自己的动作超时也放宽。
process.env.AGENT_BROWSER_DEFAULT_TIMEOUT ??= '45000'
const browser = new AgentBrowser({
  command: config.browser.executablePath ?? '',
  globalArgs,
  timeoutMs: Math.max(Number(config.limits.commandTimeoutMs) || 30_000, 60_000),
})

const failures = []
try {
  if (args.url !== undefined) {
    await browser.close().catch(() => {})
    await browser.open(args.url)
    console.log(`已打开：${args.url}`)
  } else {
    console.log(`沿用当前会话页面：${await browser.get('url', undefined, undefined).catch(() => '(读不到)')}`)
  }

  let runError
  const result = await runTask(args.goal, {
    browser,
    judge,
    purpose: config.judgment.purpose,
    maxSteps: args.maxSteps ?? Number(config.limits.maxSteps) ?? 12,
    goalThreshold: Number(config.limits.goalThreshold) || 0.85,
    stuckThreshold: Number(config.limits.stuckThreshold) || 0.85,
    signal: new AbortController().signal,
  }).catch((error) => {
    runError = error
    return { status: 'error', reason: String(error?.message ?? error), steps: [], trace: [], url: '', usage: { calls: 0, inputTokens: 0, outputTokens: 0 } }
  })

  console.log('\n执行轨迹')
  for (const line of result.trace) console.log(`  · ${line}`)
  console.log(`\n结果 status=${result.status} reason=${result.reason}`)
  console.log(`judge 调用 ${result.usage.calls} 次 · tokens in=${result.usage.inputTokens}`)
  if (result.next !== undefined) console.log(`下一步建议：${result.next}`)

  /* ───── 独立验证：不信 runTask 的自述 ───── */
  console.log('\n独立验证')
  const finalUrl = await browser.get('url', undefined, undefined).catch((error) => `ERR ${error.message}`)
  const title = await browser.get('title', undefined, undefined).catch(() => '')
  console.log(`  最终 URL：${finalUrl}`)
  console.log(`  标题    ：${title}`)
  const text = await browser.read(undefined).catch(() => '')
  const snippet = text.replace(/\s+/g, ' ').slice(0, 240)
  console.log(`  正文摘要：${snippet}`)

  const shot = await browser.screenshot(join(REPO, 'node_modules/.cache/try.png'), true)
  console.log(`  截图    ：${shot}`)

  if (runError !== undefined) failures.push(`runTask 失败：${runError.message}`)
  if (args.expect !== undefined) {
    const pattern = new RegExp(args.expect, 'i')
    const hit = pattern.test(finalUrl) || pattern.test(title) || pattern.test(text)
    console.log(`\n  期望匹配 /${args.expect}/：${hit ? '✓ 命中' : '✗ 未命中'}`)
    if (!hit) failures.push(`最终页面不匹配 /${args.expect}/（URL=${finalUrl}，标题=${title}）`)
  }
  if (result.status === 'input_required') failures.push('运行停在需要输入内容（input_required）')
} catch (error) {
  console.error(`\n失败：${error instanceof Error ? error.stack : String(error)}`)
  failures.push(String(error instanceof Error ? error.message : error))
} finally {
  if (args.headed !== true) await browser.close().catch(() => {})
}

console.log('')
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}
console.log('✓ 完成')
