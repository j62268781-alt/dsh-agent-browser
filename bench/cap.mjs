#!/usr/bin/env node
/**
 * **选项上限实验（换 judge 后必须重做）**：同一个页面、同一批目标，只改"送给判断层的候选数"。
 *
 * 我们现在的 `JUDGE_OPTION_CAP = 10` 是在 `decision-model-preview` 上量的：
 * 40 个候选时它的分布会不归一（Σp 0.95–0.98，被 dsh-judgment 整批拒绝）。
 * 换成真正的 jev-1.13 后，这个结论必须重测——参考实现里 ykl 一次给 240 个候选、
 * jkudish 给 240、ultrafast 给 250，说明真 Jev 未必怕大选项集。
 *
 * 用法：
 *   node bench/cap.mjs --connection TypeSafe --caps 10,16,24,40 --samples 3
 *   node bench/cap.mjs --url https://www.hao123.com/     # 换站点（目标用内置的）
 *
 * 指标：命中率（选中的候选是否就是目标元素）/ 不合法响应率 / tokens / 延迟。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentBrowser } from '../lib/cli.js'
import { candidatesFromExtracted, questionsOf } from '../lib/task.js'
import { createLiveJudge } from '../scripts/live-judge.mjs'
import { readAgentBrowserConfig } from '../scripts/profile-config.mjs'
import { globalArgsOf } from '../lib/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const caps = String(arg('caps', '10,16,24,40')).split(',').map(Number)
const samples = Number(arg('samples', '3'))
const connection = arg('connection', undefined)
const url = arg('url', new URL('./fixtures/fixture.html', import.meta.url).href)

/** 目标 → 期望选中的元素名包含的片段。fixture 与 hao123 两套。 */
const GOALS = url.includes('dense')
  ? [
      ['Open the linked article about Bletchley Park', 'Bletchley Park'],
      ['Open Article 37', 'Article 37'],
      ['Open Article 12', 'Article 12'],
    ]
  : url.includes('hao123')
  ? [
      ['点击「七日天气」链接', '七日天气'],
      ['点击「新华网」链接', '新华网'],
    ]
  : [
      ['type Lisbon into the Destination field', 'Destination'],
      ['submit the search with the Find stays button', 'Find stays'],
      ['choose the Design category in the Category selector', 'Stay category'],
      ['enable the Free cancellation checkbox', 'Free cancellation'],
      ['open the Casa Flora stay', 'Casa Flora'],
    ]

const config = readAgentBrowserConfig()
const browser = new AgentBrowser({
  command: config.browser.executablePath ?? '',
  globalArgs: globalArgsOf(config, 'default'),
  timeoutMs: 60_000,
})
const { judge, describe } = await createLiveJudge(config.judgment.purpose, connection)
console.log(`judge: ${describe}`)
console.log(`url: ${url}\ncaps: ${caps.join(',')} · samples: ${samples}\n`)

await browser.open(url)
const page = await browser.extract({})
const stateBase = { url: page.url, page_text: String(page.text).slice(0, 1500), page_title: page.title }

const rows = []
for (const cap of caps) {
  let hit = 0
  let invalid = 0
  let attempts = 0
  let tokens = 0
  let ms = 0
  const misses = []
  for (const [goal, expected] of GOALS) {
    const all = candidatesFromExtracted(page.items, goal)
    const subset = all.slice(0, cap)
    if (subset.length < 2) continue
    const state = { ...stateBase, goal, snapshot: subset.map((candidate) => `${candidate.role ?? ''} "${candidate.name ?? ''}"`).join('\n') }
    const questions = questionsOf(goal, subset)
    for (let sample = 0; sample < samples; sample += 1) {
      attempts += 1
      const started = Date.now()
      try {
        const result = await judge.ask(state, questions, { purpose: config.judgment.purpose })
        ms += Date.now() - started
        tokens += result.usage.inputTokens ?? 0
        const answer = result.answers.action
        const chosen = answer?.kind === 'choice' ? subset.find((candidate) => candidate.id === answer.optionId) : undefined
        if (chosen !== undefined && (chosen.name ?? '').includes(expected)) hit += 1
        else misses.push(`${goal} → ${chosen?.name ?? answer?.kind ?? 'none'}`)
      } catch (error) {
        invalid += 1
        ms += Date.now() - started
        misses.push(`${goal} → error: ${String(error instanceof Error ? error.message : error).slice(0, 60)}`)
      }
    }
  }
  rows.push({ cap, hit, attempts, invalid, avgTokens: Math.round(tokens / Math.max(attempts, 1)), avgMs: Math.round(ms / Math.max(attempts, 1)), misses })
  console.log(
    `cap=${String(cap).padEnd(3)} 命中 ${hit}/${attempts} · 不合法 ${invalid} · ` +
    `${Math.round(tokens / Math.max(attempts, 1))} tok/次 · ${Math.round(ms / Math.max(attempts, 1))}ms/次`,
  )
  for (const miss of misses.slice(0, 3)) console.log(`    ✗ ${miss}`)
}

const out = resolve(HERE, 'results', `cap-${(connection ?? 'default').replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ describe, url, caps, samples, rows }, null, 1))
console.log(`\n→ ${out}`)
