#!/usr/bin/env node
/**
 * 读一份 bench 结果 JSON，打成可读的账：
 *
 *   node bench/report.mjs bench/results/baseline-2.json
 *   node bench/report.mjs bench/results/*.json      # 多份对比
 *
 * 输出：总览 / 按类别 / 失败清单（带每一步的状态与原因）。
 */
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('用法：node bench/report.mjs <results.json…>')
  process.exit(2)
}

for (const file of files) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const records = data.records ?? []
  const evaluated = records.filter((record) => record.outcome === 'evaluated')
  const s = data.summary ?? {}
  console.log(`\n══════ ${file}`)
  console.log(`任务 ${s.tasks ?? evaluated.length} · 正确 ${s.correct ?? 0} · false-done ${s.falseDone ?? 0} · missed ${s.missed ?? 0}` +
    ` · 网络/环境失败 ${s.network ?? 0} · 跳过 ${s.skipped ?? 0}`)
  console.log(`judge ${s.calls ?? 0} 次 · ${s.tokens ?? 0} tokens · ${((s.ms ?? 0) / 1000).toFixed(1)}s`)

  const byCat = new Map()
  for (const record of evaluated) {
    const bucket = byCat.get(record.cat) ?? { tasks: 0, correct: 0 }
    bucket.tasks += 1
    if (record.correct) bucket.correct += 1
    byCat.set(record.cat, bucket)
  }
  console.log('\n按类别：')
  for (const [cat, bucket] of [...byCat].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${cat.padEnd(14)} ${bucket.correct}/${bucket.tasks}`)
  }

  const failures = evaluated.filter((record) => !record.correct)
  if (failures.length > 0) {
    console.log('\n失败清单：')
    for (const record of failures) {
      const last = record.steps.at(-1)
      const flags = [record.falseDone ? 'FALSE-DONE' : '', record.missed ? 'missed' : ''].filter(Boolean).join(' ')
      console.log(`  ✗ ${record.id.padEnd(22)} ${String(last?.status ?? '-').padEnd(18)} ${flags}`)
      console.log(`      ${String(record.error ?? last?.reason ?? '').slice(0, 160)}`)
    }
  }
  const network = records.filter((record) => record.outcome === 'network')
  if (network.length > 0) {
    console.log(`\n网络/环境失败（不计入正确率）：${network.map((record) => record.id).join(', ')}`)
  }
}
