#!/usr/bin/env node
/**
 * **失败分析**：把 bench 结果里的失败逐条拆成"卡在哪一环节、花了多少次判断"。
 *
 * 用法：
 *   node bench/analyze.mjs bench/results/xxx.json
 *   node bench/analyze.mjs bench/results/*.json          # 多轮合并（按任务聚合）
 *   node bench/analyze.mjs bench/results/xxx.json --json # 输出机器可读
 *
 * 为什么要它：单次跑的分数只有 19/39 这一个数字，看不出"哪一类失败最贵"。
 * 这里按 5 个维度归因：
 *   1) 最终状态（ambiguous/budget/no_progress/needs_verification/page_error…）
 *   2) 判断次数（谁在烧钱）
 *   3) 失败发生在第几步 / 是否撞到步数上限
 *   4) trace 里的**关键信号**（判断层分不清 / 动作无效 / 无候选 / 页面报错 / 确认未通过）
 *   5) 是否 false-done（声称完成但断言为假）——红线
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const asJson = process.argv.includes('--json')
if (files.length === 0) {
  console.error('用法: node bench/analyze.mjs <result.json...> [--json]')
  process.exit(2)
}

/** trace 信号 → 归因标签（按优先级匹配，命中第一个）。 */
const SIGNALS = [
  ['判断层分不清', /判断层分不清|请从候选里挑/],
  ['确认没通过', /独立确认没通过|确认没通过/],
  ['动作无效果', /没有效果|执行过但页面语义状态没变|重复且页面没有变化/],
  ['没有可操作元素', /没有可操作的元素|没有剩余可操作元素/],
  ['页面报错', /页面显示错误/],
  ['退回整树', /退回整树/],
  ['填值被跳过', /已按调用方的值填过/],
  ['等待加载', /页面在加载|页面还在加载/],
  ['跳转延迟', /跳转是延迟的|页面在跳转/],
  ['命中步数上限', /达到最大步数/],
  ['需要输入值', /需要 .*的值|input_required/],
  ['多子目标被拦', /填完还要/],
]

const tasks = new Map()
for (const file of files) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  for (const record of data.records ?? []) {
    if (record.outcome === 'skipped' || record.outcome === 'network') continue
    const list = tasks.get(record.id) ?? []
    list.push(record)
    tasks.set(record.id, list)
  }
}

const rows = []
for (const [id, runs] of tasks) {
  const best = runs[runs.length - 1]
  const votes = runs.filter((run) => run.correct === true).length
  const majority = votes * 2 > runs.length
  if (majority) continue
  // 取"最接近成功"的那一轮做归因（避免用一次崩坏的结果代表整条任务）
  const focus = runs.find((run) => run.steps?.some((step) => step.truth === true)) ?? best
  const steps = focus.steps ?? []
  const last = steps[steps.length - 1] ?? {}
  const trace = steps.flatMap((step) => step.trace ?? []).join('\n')
  const hits = SIGNALS.filter(([, pattern]) => pattern.test(trace)).map(([label]) => label)
  rows.push({
    id,
    cat: focus.cat,
    status: last.status ?? '-',
    reason: String(last.reason ?? '').slice(0, 80),
    calls: focus.calls ?? 0,
    tokens: focus.tokens ?? 0,
    ms: focus.ms ?? 0,
    steps: steps.length,
    rounds: steps.reduce((total, step) => total + (step.rounds ?? 0), 0),
    truth: last.truth,
    falseDone: focus.falseDone === true,
    signals: hits,
    votes: `${votes}/${runs.length}`,
  })
}

rows.sort((left, right) => right.calls - left.calls)

if (asJson) {
  console.log(JSON.stringify(rows, null, 1))
  process.exit(0)
}

const totalCalls = rows.reduce((sum, row) => sum + row.calls, 0)
const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0)
console.log(`失败任务 ${rows.length} 条（来自 ${files.map((file) => basename(file)).join(', ')}）`)
console.log(`合计判断 ${totalCalls} 次 · ${Math.round(totalTokens / 1000)}k tokens · ${(rows.reduce((sum, row) => sum + row.ms, 0) / 1000).toFixed(0)}s\n`)

console.log('— 按判断次数（贵 → 便宜）')
console.log('   任务                 状态              判断  步/轮  票    关键信号')
for (const row of rows) {
  const flag = row.falseDone ? ' FD' : ''
  console.log(
    `   ${row.id.padEnd(20)} ${String(row.status).padEnd(18)} ${String(row.calls).padStart(4)}  ` +
    `${row.steps}/${row.rounds}`.padEnd(6) + ` ${row.votes.padEnd(4)} ${row.signals.slice(0, 3).join('·') || '—'}${flag}`,
  )
}

const byStatus = {}
const bySignal = {}
for (const row of rows) {
  byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
  for (const signal of row.signals) bySignal[signal] = (bySignal[signal] ?? 0) + 1
}
console.log('\n— 按最终状态')
for (const [status, count] of Object.entries(byStatus).sort((left, right) => right[1] - left[1])) {
  console.log(`   ${String(count).padStart(2)}  ${status}`)
}
console.log('\n— 按关键信号（可叠加）')
for (const [signal, count] of Object.entries(bySignal).sort((left, right) => right[1] - left[1])) {
  console.log(`   ${String(count).padStart(2)}  ${signal}`)
}
const falseDone = rows.filter((row) => row.falseDone)
if (falseDone.length > 0) {
  console.log(`\n— false-done（红线）${falseDone.length} 条：${falseDone.map((row) => row.id).join(', ')}`)
}
