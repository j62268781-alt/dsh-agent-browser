#!/usr/bin/env node
/**
 * **"少选项 + 多次采样投票"实验**（用户的提案）。
 *
 * 问题：选项越多，判断层越容易给出不合法分布（实测 Σp 0.95–0.98）、也越容易选错。
 * 方案：一次只给 K 个选项（K=10），但**独立采 N 次**，按票数取胜利者；比单次采样的命中率与开销。
 *
 * 用法：node scripts/bench-vote.mjs
 */
import { AgentBrowser } from '../lib/cli.js'
import { candidatesFromExtracted, questionsOf } from '../lib/task.js'
import { createLiveJudge } from './live-judge.mjs'
import { readAgentBrowserConfig } from './profile-config.mjs'
import { globalArgsOf } from '../lib/index.js'

const SAMPLES = 6
const CAPS = [10, 16, 40]
const config = readAgentBrowserConfig()
const browser = new AgentBrowser({ command: config.browser.executablePath ?? '', globalArgs: globalArgsOf(config, 'dsh-ab-vote'), timeoutMs: 60_000 })
const { judge } = await createLiveJudge()

/** 每个站点：打开 → 目标 + 期望命中的元素名（参与统计）+ 是否要在打开后先做点操作。 */
const SITES = [
  {
    name: 'fixture（酒店）',
    url: 'http://127.0.0.1:8899/fixture.html',
    goals: [
      ['type Lisbon into the Destination field', 'Destination'],
      ['submit the search', 'Find stays'],
      ['choose the Design category', 'Stay category'],
      ['enable Free cancellation', 'Free cancellation'],
      ['open the Casa Flora stay', 'View Casa Flora'],
    ],
  },
  {
    name: 'hao123',
    url: 'https://www.hao123.com/',
    goals: [
      ['点击「七日天气」链接', '七日天气'],
      ['点击「新华网」链接', '新华网'],
    ],
  },
]

const rows = []
for (const site of SITES) {
  await browser.close().catch(() => {})
  await browser.open(site.url)
  const page = await browser.extract({})
  // 注意：候选要**按目标排序**后再截断——这正是真实循环的做法（rankByGoal → slice(cap)）。
  const candidates = candidatesFromExtracted(page.items, '')
  console.log(`\n=== ${site.name}：抽取 ${page.items.length} 元素 / ${candidates.length} 候选 ===`)
  const state = {
    goal: '',
    url: page.url,
    snapshot: page.items.map((item) => `${item.role} "${item.name}"`).join('\n'),
    page_title: page.title,
    page_text: page.text.slice(0, 2000),
    history: [],
    wall_clock_utc: new Date().toISOString(),
  }
  for (const [goal, expectedName] of site.goals) {
    const expected = candidates.find((candidate) => candidate.description.includes(expectedName))
    if (expected === undefined) { console.log(`  ✗ 抽取里没有期望候选「${expectedName}」`); continue }
    const ranked = candidatesFromExtracted(page.items, goal)
    for (const cap of CAPS) {
      const subset = ranked.slice(0, cap)
      if (!subset.some((candidate) => candidate.id === expected.id)) continue
      const picks = []
      let tokens = 0
      let ms = 0
      let invalid = 0
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const started = performance.now()
        let picked
        try {
          const result = await judge.ask({ ...state, goal }, questionsOf(goal, subset), { purpose: config.judgment.purpose })
          const answer = result.answers.action
          picked = answer?.kind === 'choice' ? answer.optionId : undefined
          tokens += result.usage.inputTokens ?? 0
        } catch {
          invalid += 1
        }
        ms += performance.now() - started
        picks.push(picked)
      }
      const singleHit = picks.filter((pick) => pick === expected.id).length
      const voteHit = (windowSize) => {
        let hit = 0
        let total = 0
        for (let index = 0; index + windowSize <= picks.length; index += windowSize) {
          const tally = new Map()
          for (const pick of picks.slice(index, index + windowSize)) if (pick !== undefined) tally.set(pick, (tally.get(pick) ?? 0) + 1)
          if ([...tally.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] === expected.id) hit += 1
          total += 1
        }
        return total === 0 ? '—' : `${hit}/${total}`
      }
      rows.push({
        site: site.name,
        goal: goal.slice(0, 24),
        cap,
        single: `${singleHit}/${SAMPLES}`,
        vote3: voteHit(3),
        vote5: voteHit(5),
        tokens: Math.round(tokens / SAMPLES),
        ms: Math.round(ms / SAMPLES),
        invalid: `${invalid}/${SAMPLES}`,
        usd: (tokens * 0.042) / 1e6,
      })
    }
  }
}

const header = ['站点', '目标', '上限', '单次命中', '投票3', '投票5', 'tokens/次', '延迟/次', '不合法', '成本/决策']
console.log('\n' + header.join(' | '))
for (const row of rows) {
  console.log([row.site, row.goal, row.cap, row.single, row.vote3, row.vote5, row.tokens, `${row.ms}ms`, row.invalid, `$${row.usd.toFixed(6)}`].join(' | '))
}
await browser.close().catch(() => {})
