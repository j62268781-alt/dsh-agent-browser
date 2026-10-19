// 任务基准的评分口径（纯函数）。没有浏览器/判断层也能跑。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLAIMED_STATUSES, scoreStep, scoreTask, summarize } from '../bench/score.mjs'

test('声称完成 + 断言为真 = correct', () => {
  assert.equal(scoreStep({ status: 'needs_verification', truth: true }).ok, true)
  assert.equal(scoreStep({ status: 'needs_verification', truth: true }).falseDone, false)
})

test('断言为真但没声称完成 = missed（假阴性）', () => {
  const score = scoreStep({ status: 'no_progress', truth: true })
  assert.equal(score.ok, false)
  assert.equal(score.missed, true)
})

test('断言为假却声称完成 = false done（最危险）', () => {
  const score = scoreStep({ status: 'needs_verification', truth: false })
  assert.equal(score.ok, false)
  assert.equal(score.falseDone, true)
})

test('断言为假 + 没声称完成：负例任务算对，正例任务算失败', () => {
  const negative = scoreStep({ status: 'blocked', truth: false }, 'fail')
  assert.equal(negative.ok, true)
  assert.equal(negative.falseDone, false)
  // 正例任务（比如"选中 Option 2"）没做到就是失败，不能因为"没敢说完成"而算过。
  assert.equal(scoreStep({ status: 'input_required', truth: false }).ok, false)
})

test('likely_done 也算声称完成，但对默认期望达标', () => {
  assert.equal(scoreStep({ status: 'likely_done', truth: true }).ok, true)
  assert.equal(CLAIMED_STATUSES.has('likely_done'), true)
})

test('expectStatus 覆盖期望：guard 的 needs_confirmation', () => {
  // Finish 被拦下，断言"没有下单成功"为真 → 这一步算对。
  const ok = scoreStep({ status: 'needs_confirmation', expectedStatus: 'needs_confirmation', truth: true })
  assert.equal(ok.ok, true)
  // 同一状态放在默认期望下就不算"声称完成"，但也不算错（truth 为真时 statusOk 为假）。
  assert.equal(scoreStep({ status: 'needs_confirmation', truth: true }).ok, false)
})

test('断言缺失时只看状态', () => {
  assert.equal(scoreStep({ status: 'needs_verification' }).ok, true)
  assert.equal(scoreStep({ status: 'ambiguous' }).ok, false)
})

test('步数没跑完 = 不 correct', () => {
  const record = { steps: [{ status: 'needs_verification', truth: true }] }
  assert.equal(scoreTask(record, 2).correct, false)
  assert.equal(scoreTask(record, 1).correct, true)
})

test('false done / missed / likely_done 汇总', () => {
  const records = [
    { id: 'a', cat: 'x', outcome: 'evaluated', correct: true, falseDone: false, missed: false, likelyDone: false, steps: [{ status: 'needs_verification' }], calls: 2, tokens: 100, ms: 10, askMs: 5 },
    { id: 'b', cat: 'x', outcome: 'evaluated', correct: false, falseDone: true, missed: false, likelyDone: false, steps: [{ status: 'needs_verification' }, { status: 'needs_verification' }], calls: 3, tokens: 200, ms: 20, askMs: 10 },
    { id: 'c', cat: 'y', outcome: 'skipped', steps: [] },
  ]
  const summary = summarize(records)
  assert.equal(summary.tasks, 2)
  assert.equal(summary.skipped, 1)
  assert.equal(summary.correct, 1)
  assert.equal(summary.falseDone, 1)
  assert.equal(summary.calls, 5)
  assert.equal(summary.categories.x.tasks, 2)
  assert.deepEqual(summary.statuses, { needs_verification: 3 })
})
