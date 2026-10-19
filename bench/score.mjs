// 评分逻辑（纯函数，可单测）：把"一次 runTask + 一次页面内断言"归类。
//
// 关键口径（照抄 ykl 的、但按我们的状态名调整）：
//   - 本插件的循环**从不自称 done**：做完时返回 `needs_verification`（交回宿主验证），
//     不确定时返回 `likely_done`。两者都算"声称完成"，分开统计。
//   - 断言为真 + 声称完成 = correct；
//   - 断言为真 + 没声称完成 = **missed**（假阴性：其实做到了但没敢说）；
//   - 断言为假 + 声称完成 = **false done**（最危险，必须为 0）；
//   - 断言为假 + 没声称完成 = 正确地没完成（负例任务靠这个）。

/** 视为"声称完成"的状态。 */
export const CLAIMED_STATUSES = new Set(['needs_verification', 'likely_done'])

/**
 * @param {{ status: string, truth?: boolean, expectedStatus?: string }} step
 * @param {'pass' | 'fail'} [expect] 负例任务（expect: "fail"）只要求"不许声称完成"
 */
export function scoreStep(step, expect = 'pass') {
  const expected = step.expectedStatus ?? 'needs_verification'
  const claimed = CLAIMED_STATUSES.has(step.status)
  // `likely_done` 是"看起来完成了"，对默认期望（needs_verification）来说也达标。
  const statusOk = step.status === expected || (expected === 'needs_verification' && step.status === 'likely_done')
  let ok
  if (step.truth === undefined) ok = statusOk
  else if (expect === 'fail') ok = step.truth === false ? !claimed : statusOk
  else if (step.truth === true) ok = statusOk
  // 正例任务里断言为假 = 没做到，无论有没有声称完成都算失败。
  else ok = false
  return {
    claimed,
    statusOk,
    ok,
    falseDone: step.truth === false && claimed,
    missed: step.truth === true && !claimed,
  }
}

/**
 * @param {{ steps: { status: string, truth?: boolean, expectedStatus?: string }[] }} record
 * @param {number} plannedSteps 任务计划有几步（用于判断"是不是没跑完"）
 */
export function scoreTask(record, plannedSteps, expect = 'pass') {
  const steps = record.steps.map((step) => scoreStep(step, expect))
  const completed = record.steps.length === plannedSteps
  const last = record.steps[record.steps.length - 1]
  const lastScore = last === undefined ? undefined : scoreStep(last, expect)
  return {
    completed,
    correct: completed && steps.every((step) => step.ok),
    falseDone: steps.some((step) => step.falseDone),
    missed: completed && lastScore !== undefined && lastScore.missed,
    likelyDone: record.steps.some((step) => step.status === 'likely_done'),
  }
}

/** 汇总（runner 写入的 record 已带 correct / falseDone / missed）。 */
export function summarize(records) {
  const evaluated = records.filter((record) => record.outcome === 'evaluated')
  const skipped = records.filter((record) => record.outcome === 'skipped')
  const statuses = {}
  for (const record of evaluated) for (const step of record.steps) statuses[step.status] = (statuses[step.status] ?? 0) + 1
  const categories = {}
  for (const record of evaluated) {
    const bucket = (categories[record.cat] ??= { tasks: 0, correct: 0 })
    bucket.tasks += 1
    if (record.correct) bucket.correct += 1
  }
  return {
    tasks: evaluated.length,
    skipped: skipped.length,
    correct: evaluated.filter((record) => record.correct).length,
    falseDone: evaluated.filter((record) => record.falseDone).length,
    missed: evaluated.filter((record) => record.missed).length,
    likelyDone: evaluated.filter((record) => record.likelyDone).length,
    calls: evaluated.reduce((total, record) => total + record.calls, 0),
    tokens: evaluated.reduce((total, record) => total + record.tokens, 0),
    ms: evaluated.reduce((total, record) => total + record.ms, 0),
    askMs: evaluated.reduce((total, record) => total + record.askMs, 0),
    statuses,
    categories,
  }
}
