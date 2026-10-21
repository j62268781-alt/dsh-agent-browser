// 任务基准的评分口径（纯函数）。没有浏览器/判断层也能跑。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLAIMED_STATUSES, scoreStep, scoreTask, summarize } from '../bench/score.mjs'
import {
  DOM_STATE_EXPRESSION,
  STORAGE_CLEAR_EXPRESSION,
  STORAGE_READ_EXPRESSION,
  annotateInitialStateStability,
  benchmarkOriginOf,
  isolateStorage,
  openWithEvidence,
  stepDiagnostics,
  summarizeNav,
} from '../bench/nav.mjs'

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

// ---------------------------------------------------------------- 导航诊断（0B）

/** 按调用顺序返回 URL 的假 readUrl（用完后停在最后一个值）。 */
function urlSequence(values) {
  let index = 0
  return async () => values[Math.min(index++, values.length - 1)]
}

test('openWithEvidence：host 相同但 path 错误只记诊断，open 仍按旧口径通过', async () => {
  const requested = 'https://demo.playwright.dev/todomvc/'
  const wrongPath = 'https://demo.playwright.dev/todomvc/index.html'
  const evidence = await openWithEvidence(requested, {
    open: async () => {},
    readUrl: urlSequence(['about:blank', wrongPath, wrongPath, wrongPath]),
    waitForReady: async () => true,
    sleep: async () => {},
  })
  assert.equal(evidence.ok, true)
  assert.equal(evidence.host_matched, true)
  assert.equal(evidence.path_matched, false)
  assert.equal(evidence.same_host_other_path, true)
  assert.equal(evidence.diagnosis, 'same_host_other_path')
  assert.equal(evidence.url_before_open, 'about:blank')
  assert.equal(evidence.url_after_open, wrongPath)
  assert.equal(evidence.url_after_ready, wrongPath)
  assert.equal(evidence.url_settled, wrongPath)
  assert.equal(evidence.stable, true)
  assert.equal(evidence.attempts.length, 1)
})

test('openWithEvidence：host 不符重试后判失败（不把错误页面当成功）', async () => {
  const sleeps = []
  const evidence = await openWithEvidence('https://demo.playwright.dev/todomvc/', {
    open: async () => {},
    readUrl: urlSequence(['about:blank', 'https://stale.example/prev', 'https://stale.example/prev']),
    waitForReady: async () => true,
    sleep: async (ms) => { sleeps.push(ms) },
  }, { retryBackoffMs: 10, stablePolls: 2, pollMs: 3 })
  assert.equal(evidence.ok, false)
  assert.equal(evidence.diagnosis, 'host_mismatch')
  assert.equal(evidence.host_matched, false)
  assert.equal(evidence.attempts.length, 2)
  assert.deepEqual(sleeps, [10])
})

test('openWithEvidence：ready 等待期间再次导航 → 记录 url_after_ready 与 late_navigation', async () => {
  const base = 'https://demo.playwright.dev/todomvc/'
  const late = 'https://demo.playwright.dev/todomvc/#/todo'
  let current = base
  const evidence = await openWithEvidence(base, {
    open: async () => { current = base },
    readUrl: async () => current,
    // 站点在 ready 等待期间自己跳走（迟到导航）。
    waitForReady: async () => { current = late; return true },
    sleep: async () => {},
  })
  assert.equal(evidence.ok, true)
  assert.equal(evidence.url_after_open, base)
  assert.equal(evidence.url_after_ready, late)
  assert.equal(evidence.url_changed_during_ready, true)
  assert.equal(evidence.url_settled, late)
  assert.equal(evidence.stable, true)
  assert.equal(evidence.diagnosis, 'late_navigation')
})

test('openWithEvidence：URL 不稳定时有界轮询并记录（没有固定长 sleep）', async () => {
  const sleeps = []
  const evidence = await openWithEvidence('https://a.example/x', {
    open: async () => {},
    readUrl: urlSequence([
      'about:blank',
      'https://a.example/x',
      'https://a.example/x',
      'https://a.example/y',
      'https://a.example/z',
      'https://a.example/w',
    ]),
    waitForReady: async () => true,
    sleep: async (ms) => { sleeps.push(ms) },
  }, { stablePolls: 3, pollMs: 7 })
  assert.equal(evidence.ok, true)
  assert.equal(evidence.stable, false)
  assert.equal(evidence.url_changed_after_ready, true)
  // 有界：最多 stablePolls 次，绝不等成固定 3s。
  assert.equal(evidence.url_polls.length, 3)
  assert.deepEqual(evidence.url_polls.map((poll) => poll.url), ['https://a.example/y', 'https://a.example/z', 'https://a.example/w'])
  assert.deepEqual(sleeps, [7, 7, 7])
  assert.equal(evidence.diagnosis, 'url_unstable')
})

test('benchmarkOriginOf：只有 http(s) 任务来源可清理（file:// 一律拒绝）', () => {
  assert.equal(benchmarkOriginOf('https://demo.playwright.dev/todomvc/'), 'https://demo.playwright.dev')
  assert.equal(benchmarkOriginOf('file:///tmp/bench/fixtures/fixture.html'), '')
  assert.equal(benchmarkOriginOf('not a url'), '')
})

// ---------------------------------------------------------------- 任务态隔离（0A）

/**
 * 假浏览器世界：localStorage/sessionStorage 是进程内 Map，DOM 由 storage 派生。
 * `evaluate` 按 nav.mjs 导出的探针表达式语义执行，等价于真实页面上的一次 eval。
 */
function createStorageWorld(options = {}) {
  const origin = options.origin ?? 'https://demo.playwright.dev'
  const state = {
    url: options.url ?? `${origin}/todomvc/`,
    local: new Map((options.local ?? []).map((key) => [key, '1'])),
    session: new Map((options.session ?? []).map((key) => [key, '1'])),
    blockedClear: options.blockedClear === true,
    reloads: 0,
    evaluateCalls: 0,
  }
  const deps = {
    readUrl: async () => state.url,
    evaluate: async (expression) => {
      state.evaluateCalls += 1
      if (expression === STORAGE_READ_EXPRESSION) {
        return { local: [...state.local.keys()], session: [...state.session.keys()] }
      }
      if (expression === STORAGE_CLEAR_EXPRESSION) {
        if (state.blockedClear) return { local: false, session: false, local_error: 'blocked by policy' }
        state.local.clear()
        state.session.clear()
        return { local: true, session: true }
      }
      if (expression === DOM_STATE_EXPRESSION) {
        return { url: state.url, title: 'TodoMVC', text: [...state.local.keys()].join('|'), html_length: state.local.size }
      }
      throw new Error(`unexpected expression: ${String(expression).slice(0, 60)}`)
    },
    reload: async () => { state.reloads += 1 },
    waitForReady: async () => true,
    sleep: async () => {},
  }
  return { state, deps }
}

const DEMO_ORIGINS = new Set(['https://demo.playwright.dev'])

test('storage 隔离可重复：同一 task 第二次启动时 storage 与初始 DOM 与第一次一致', async () => {
  const world = createStorageWorld()
  const first = await isolateStorage(world.state.url, world.deps, { allowedOrigins: DEMO_ORIGINS })
  assert.equal(first.ran, true)
  assert.equal(first.skipped, undefined)
  assert.equal(first.storage_cleared, true)
  assert.deepEqual(first.storage_before.local, [])
  const firstDigest = first.initial_dom.digest

  // 模拟第一轮任务把 todo 写进 localStorage（TodoMVC 的真实持久化行为）。
  world.state.local.set('todomvc-buy milk', '1')
  world.state.local.set('todomvc-walk the dog', '1')
  const second = await isolateStorage(world.state.url, world.deps, { allowedOrigins: DEMO_ORIGINS })
  assert.equal(second.ran, true)
  assert.equal(second.storage_before.local_count, 2)
  assert.equal(second.storage_cleared, true)
  assert.deepEqual(second.storage_after.local, [])
  assert.equal(second.reloaded, true)
  // 关键验收：第二次启动的初始 DOM 摘要与第一次相同（storage 污染没有带进来）。
  assert.equal(second.initial_dom.digest, firstDigest)
})

test('storage 隔离失败时留下证据，并让初始态可重复性检查报不稳定', async () => {
  const clean = createStorageWorld()
  const first = await isolateStorage(clean.state.url, clean.deps, { allowedOrigins: DEMO_ORIGINS })
  const dirty = createStorageWorld({ local: ['todomvc-buy milk'], blockedClear: true })
  const second = await isolateStorage(dirty.state.url, dirty.deps, { allowedOrigins: DEMO_ORIGINS })
  assert.equal(second.storage_cleared, false)
  assert.equal(second.storage_after.local_count, 1)

  const records = [
    { id: 'todomvc-fine', nav: { storage: first } },
    { id: 'todomvc-fine', nav: { storage: second } },
  ]
  const stability = annotateInitialStateStability(records)
  assert.equal(stability.compared, 1)
  assert.equal(stability.stable, 0)
  assert.deepEqual(stability.unstable, ['todomvc-fine(2)'])
  assert.equal(records[0].nav.storage.initial_dom_stable, false)
})

test('storage 隔离只清 benchmark 来源：非白名单 / file:// / 跑错页面一律不动', async () => {
  // 1) 非 benchmark 来源（用户生产数据）→ 拒绝，且不执行任何页面写操作。
  const bank = createStorageWorld({ origin: 'https://user-bank.example', url: 'https://user-bank.example/account', local: ['session-token'] })
  const notAllowed = await isolateStorage('https://user-bank.example/account', bank.deps, { allowedOrigins: DEMO_ORIGINS })
  assert.equal(notAllowed.ran, false)
  assert.equal(notAllowed.skipped, 'origin_not_allowed')
  assert.equal(bank.state.evaluateCalls, 0)
  assert.deepEqual([...bank.state.local.keys()], ['session-token'])

  // 2) file:// fixture：Chrome 的 file origin 可能与其他本地页面共享 storage → 拒绝。
  const fileWorld = createStorageWorld()
  const fileSkipped = await isolateStorage('file:///tmp/bench/fixtures/fixture.html', fileWorld.deps, { allowedOrigins: new Set(['file://']) })
  assert.equal(fileSkipped.skipped, 'non_http_origin')
  assert.equal(fileWorld.state.evaluateCalls, 0)

  // 3) open 没真正落到任务页（当前页还在别的 origin）→ 不清，先报跑错页面。
  const wrongPage = createStorageWorld({ url: 'https://mail.example/inbox', local: ['draft'] })
  const mismatch = await isolateStorage('https://demo.playwright.dev/todomvc/', wrongPage.deps, { allowedOrigins: DEMO_ORIGINS })
  assert.equal(mismatch.skipped, 'origin_mismatch')
  assert.equal(wrongPage.state.evaluateCalls, 0)
})

// ---------------------------------------------------------------- 诊断字段不打分

test('0B 诊断字段不改变旧 score：correct/false-done 只看 status/truth', () => {
  const base = { steps: [{ status: 'needs_verification', truth: true }] }
  const withDiagnostics = {
    nav: { diagnosis: 'late_navigation', url_polls: [{ wait_ms: 120, url: 'https://a.example/x' }] },
    steps: [{
      ...base.steps[0],
      nav: { url_before_runTask: 'a', url_after_runTask: 'b', url_before_assert: 'b', url_after_assert: 'b' },
      resultSteps: [{ step: 1, origin: 'b', action: 'click', executed: true, reason: 'ok', digest: 'd' }],
    }],
  }
  assert.deepEqual(scoreTask(withDiagnostics, 1), scoreTask(base, 1))
})

test('stepDiagnostics 只保留 origin/action/executed/reason/digest 并截断', () => {
  const diagnostics = stepDiagnostics([
    { step: 2, origin: 'https://a/x', action: 'click:e1', executed: true, reason: 'ok', digest: 'abc', goal: '不应出现', trace: 'x' },
    { origin: 'https://b/y', action: 'stop:done', executed: false, reason: 'r'.repeat(400), digest: 'd'.repeat(400) },
    null,
  ])
  assert.deepEqual(diagnostics[0], { step: 2, origin: 'https://a/x', action: 'click:e1', executed: true, reason: 'ok', digest: 'abc' })
  assert.equal(Object.hasOwn(diagnostics[0], 'goal'), false)
  assert.equal(diagnostics[1].step, 2)
  assert.equal(diagnostics[1].executed, false)
  assert.equal(diagnostics[1].action, 'stop:done')
  assert.ok(diagnostics[1].reason.length <= 201)
  assert.ok(diagnostics[1].digest.length <= 201)
  assert.equal(diagnostics[2].origin, '')
  assert.equal(diagnostics[2].executed, false)
})

test('summarizeNav 汇总导航/隔离诊断（只报告，不影响评分）', () => {
  const records = [
    { id: 'a', nav: { diagnosis: 'ok', ready: true, ready_method: 'waitForReady', storage: { ran: true, storage_cleared: true } } },
    { id: 'b', nav: { diagnosis: 'late_navigation', ready: false, ready_method: 'waitForReady', storage: { skipped: 'non_http_origin' } } },
    { id: 'c', nav: { diagnosis: 'url_unstable', ready: true, ready_method: 'waitForReady', storage: { ran: true, error: 'boom' } } },
    { id: 'd', nav: {} },
  ]
  const summary = summarizeNav(records)
  assert.equal(summary.counts.tasks, 4)
  assert.equal(summary.counts.lateNavigation, 1)
  assert.equal(summary.counts.urlUnstable, 1)
  assert.equal(summary.counts.readyTimeout, 1)
  assert.equal(summary.counts.storageRan, 2)
  assert.equal(summary.counts.storageCleared, 1)
  assert.equal(summary.counts.storageSkipped, 1)
  assert.equal(summary.counts.storageErrors, 1)
  assert.deepEqual(summary.problems, ['b:late_navigation', 'c:url_unstable'])
})
