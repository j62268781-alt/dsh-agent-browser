/**
 * `browser_run` 的决策循环测试（**离线**：judge 与浏览器都是替身）。
 *
 * 这里验的是从三家参考实现移植过来的纪律，以及我们自己的门控：
 * - 停止门在动作**之前**（goal_done / stuck）；
 * - 动作域缺答案 → 中止，不"修复"；
 * - 文本/密钥 → `input_required`，绝不猜；
 * - **交付了但页面没变** → 从概率分布里换次优候选（jkudish/jev-browser），
 *   两次无效 → `no_progress`（ronadin2002/jev-cua 的 stalled_action）；
 * - 状态超长 → 截断并显式标注（wy-coliney/jev-browser-use）；
 * - 语义签名忽略 ref 编号（否则"没效果"和"推进了"分不开）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_CLICK_CANDIDATES,
  SNAPSHOT_STATE_CAP,
  pickAlternate,
  runTask,
  stateSignature,
} from '../lib/task.js'

/* ─────────────────────────── 替身 ─────────────────────────── */

/** 一个极小的页面模型：refs + 文本；`act` 按元素决定是否改变页面。 */
function fakePage(elements) {
  const state = {
    origin: 'https://example.test/',
    title: 'Example',
    elements: elements.map((element) => ({ ...element })),
    text: '初始页面',
    acts: [],
    snapshots: 0,
  }
  const refs = () => Object.fromEntries(state.elements.map((element) => [element.ref, { name: element.name, role: element.role }]))
  const render = () => state.elements.map((element) => `${element.role} "${element.name}" @${element.ref}`).join('\n')
  const snapshot = () => {
    state.snapshots += 1
    return {
      origin: state.origin,
      digest: `digest-${state.elements.map((e) => `${e.ref}:${e.name}:${e.state ?? ''}`).join('|')}`,
      snapshot: state.text === undefined ? render() : `${render()}\n\n${state.text}`,
      refs: refs(),
    }
  }
  const browser = {
    snapshot: async () => snapshot(),
    /** 页面**可见正文**（真实实现走 CLI 的 `read`）。 */
    read: async () => state.text,
    /** 页面**标题**（真实实现走 CLI 的 `get title`）。 */
    get: async (what) => (what === 'title' ? 'E2E 单元测试页' : ''),
    async act(action, target) {
      state.acts.push(`${action} ${target}`)
      const ref = String(target).replace(/^@/, '')
      const element = state.elements.find((candidate) => candidate.ref === ref)
      element?.onClick?.(state)
    },
    async run(argv) {
      state.acts.push(argv.join(' '))
    },
  }
  return { state, browser }
}

/** 按脚本回答的 judge：每一步给一组答案。 */
function fakeJudge(script, { apiVersion = 1 } = {}) {
  const asked = []
  let index = 0
  return {
    apiVersion,
    asked,
    async ask(state, questions) {
      asked.push({ state, questions })
      if (questions.confirm !== undefined) {
        // 独立确认：默认通过（脚本里可以用 confirmProbability 覆盖）
        const step = script[Math.min(index - 1, script.length - 1)] ?? {}
        return {
          answers: { confirm: { kind: 'noul', probability: step.confirmProbability ?? 0.95 } },
          usage: { inputTokens: 5, outputTokens: 0 },
          model: 'test',
          provider: 'test',
          connection: 'test',
          fingerprint: 'test',
        }
      }
      const step = script[Math.min(index, script.length - 1)]
      index += 1
      return {
        answers: {
          action: { kind: 'choice', optionId: step.action, probabilities: step.probabilities ?? { [step.action]: 1 }, ...(step.confidence === undefined ? {} : { confidence: step.confidence }) },
          goal_done: { kind: 'noul', probability: step.goalDone ?? 0 },
          stuck: { kind: 'noul', probability: step.stuck ?? 0 },
        },
        usage: { inputTokens: 10, outputTokens: 0 },
        model: 'test',
        provider: 'test',
        connection: 'test',
        fingerprint: 'test',
      }
    },
  }
}

const deps = (browser, judge, overrides = {}) => ({
  browser,
  judge,
  purpose: 'browser.action',
  maxSteps: 8,
  goalThreshold: 0.85,
  stuckThreshold: 0.85,
  signal: new AbortController().signal,
  ...overrides,
})

const BUTTONS = [
  { ref: 'e1', role: 'button', name: '继续' },
  { ref: 'e2', role: 'button', name: '查看结果' },
  { ref: 'e3', role: 'textbox', name: '搜索' },
]

/* ─────────────────────────── 门控 ─────────────────────────── */

test('goal_done 达标：**动作之前**就停，且不执行任何动作', async () => {
  const page = fakePage(BUTTONS)
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.93 }])
  const result = await runTask('把结果区弄成 SUCCESS', deps(page.browser, judge))
  assert.equal(result.status, 'needs_verification')
  assert.equal(page.state.acts.length, 0, '停止门必须在动作之前')
  assert.match(result.trace.join('\n'), /goal_done=0\.93/)
  assert.match(result.next ?? '', /browser_read/)
})

test('goal_done 假阳性：独立确认没通过 → **不停**，继续推进', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'button', name: '开始', onClick: (state) => { state.text = 'SUCCESS' } },
  ])
  // 第一步模型就说 0.99 完成了，但确认问题只有 0.1（页面正文还是初始状态）→ 应该继续
  const judge = fakeJudge([
    { action: 'click:e1', goalDone: 0.99, confirmProbability: 0.1 },
    { action: 'click:e1', goalDone: 0.97, confirmProbability: 0.95 },
  ])
  const result = await runTask('让页面显示 SUCCESS', deps(page.browser, judge))
  assert.equal(result.status, 'needs_verification', '确认通过后仍只到 needs_verification')
  assert.equal(page.state.acts.length, 1, '假阳性不该让循环空转结束，应该真的执行动作')
  assert.match(result.trace.join('\n'), /独立确认没通过/)
  assert.equal(result.steps.find((step) => step.action === 'stop:goal_done')?.confirm, 0.95)
})

test('stuck 达标 → blocked，同样不执行动作', async () => {
  const page = fakePage(BUTTONS)
  const judge = fakeJudge([{ action: 'click:e1', stuck: 0.9 }])
  const result = await runTask('目标', deps(page.browser, judge))
  assert.equal(result.status, 'blocked')
  assert.equal(page.state.acts.length, 0)
})

test('没有 judge → 显式失败（不假装还能判断）', async () => {
  await assert.rejects(() => runTask('目标', deps(fakePage(BUTTONS).browser, undefined)), /dsh-judgment/)
})

test('契约版本不匹配 → 显式失败', async () => {
  const judge = fakeJudge([{ action: 'click:e1' }], { apiVersion: 99 })
  await assert.rejects(() => runTask('目标', deps(fakePage(BUTTONS).browser, judge)), /契约版本/)
})

test('选了不存在的候选 → judge_error（不"修复"）', async () => {
  const page = fakePage(BUTTONS)
  const judge = fakeJudge([{ action: 'click:e404' }])
  const result = await runTask('目标', deps(page.browser, judge))
  assert.equal(result.status, 'judge_error')
  assert.match(result.trace.join('\n'), /不存在的候选/)
})

test('文本输入候选 → input_required（文字绝不猜）', async () => {
  const page = fakePage(BUTTONS)
  const judge = fakeJudge([{ action: 'input:e3' }])
  const result = await runTask('搜索点东西', deps(page.browser, judge))
  assert.equal(result.status, 'input_required')
  assert.match(result.reason, /搜索/)
  assert.equal(page.state.acts.length, 0)
  assert.match(result.next ?? '', /browser_act fill/)
})

test('正常推进：先点按钮，页面出现 SUCCESS 后第二步停（needs_verification）', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'button', name: '开始', onClick: (state) => { state.text = '结果：SUCCESS' } },
  ])
  const judge = fakeJudge([
    { action: 'click:e1', goalDone: 0.1 },
    { action: 'click:e1', goalDone: 0.96 },
  ])
  const result = await runTask('让页面显示 SUCCESS', deps(page.browser, judge))
  assert.equal(result.status, 'needs_verification')
  assert.deepEqual(page.state.acts, ['click @e1'])
  assert.equal(result.steps.length, 2)
  assert.equal(result.steps[0]?.executed, true)
  assert.equal(result.steps[1]?.action, 'stop:goal_done')
})

/* ───────────────── 交付了但没效果：换次优 / 停 ───────────────── */

test('重复无效动作 → 从概率分布换**次优候选**（不是重试同一个）', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'button', name: '继续' },      // 点了没反应
    { ref: 'e2', role: 'button', name: '查看结果', onClick: (state) => { state.text = 'SUCCESS' } },
  ])
  const judge = fakeJudge([
    { action: 'click:e1', probabilities: { 'click:e1': 0.6, 'click:e2': 0.3, 'control:wait': 0.1 } },
    { action: 'click:e1', probabilities: { 'click:e1': 0.6, 'click:e2': 0.3, 'control:wait': 0.1 } },
    { action: 'click:e1', goalDone: 0.95 },
  ])
  const result = await runTask('让页面显示 SUCCESS', deps(page.browser, judge))
  const executed = result.steps.filter((step) => step.executed)
  // 第一次交付 e1（没效果），第二次**不是重试 e1**，而是分布里的次优 e2。
  assert.deepEqual(executed.map((step) => step.action), ['click:e1', 'click:e2'])
  assert.equal(executed[1]?.alternateOf, 'click:e1')
  assert.match(result.trace.join('\n'), /改用次优候选 click:e2/)
  assert.equal(result.status, 'needs_verification')
})

test('重复无效动作且分布里没有替代 → no_progress', async () => {
  const page = fakePage([{ ref: 'e1', role: 'button', name: '继续' }])
  const judge = fakeJudge([
    { action: 'click:e1', probabilities: { 'click:e1': 1 } },
    { action: 'click:e1', probabilities: { 'click:e1': 1 }, confirmProbability: 0.1 },
  ])
  const result = await runTask('目标', deps(page.browser, judge))
  assert.equal(result.status, 'no_progress')
  assert.equal(page.state.acts.length, 1, '无效动作只该交付一次')
  assert.match(result.trace.join('\n'), /没有可替代的候选/)
})

test('同一无效动作第二次仍然被提出 → 直接停（stalled_action）', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'button', name: '继续' },
    { ref: 'e2', role: 'button', name: '别的' },
  ])
  const judge = fakeJudge([
    { action: 'click:e1', probabilities: { 'click:e1': 0.5, 'click:e2': 0.5 }, confirmProbability: 0.1 },
    { action: 'click:e1', probabilities: { 'click:e1': 0.5, 'click:e2': 0.5 }, confirmProbability: 0.1 }, // 换到 e2
    { action: 'click:e2', probabilities: { 'click:e1': 0.5, 'click:e2': 0.5 }, confirmProbability: 0.1 }, // e2 也没效果
    { action: 'click:e2', probabilities: { 'click:e1': 0.5, 'click:e2': 0.5 }, confirmProbability: 0.1 },
  ])
  const result = await runTask('目标', deps(page.browser, judge))
  assert.equal(result.status, 'no_progress')
  assert.ok(page.state.acts.length <= 2, `无效交付不该超过 2 次，实际 ${page.state.acts.length}`)
})

test('页面真的变了就重置"无效"记账（不会误判为卡住）', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'button', name: '下一步', onClick: (state) => { state.text = `第 ${state.elements.length} 步` } },
  ])
  // 每步都选同一个按钮，但页面文本每次都变 → 不算 stalled
  page.state.elements[0].onClick = (state) => { state.text = `step-${++state.counter}` }
  page.state.counter = 0
  const judge = fakeJudge([
    { action: 'click:e1' },
    { action: 'click:e1' },
    { action: 'click:e1', goalDone: 0.99 },
  ])
  const result = await runTask('目标', deps(page.browser, judge))
  assert.equal(result.status, 'needs_verification')
  assert.equal(result.steps.filter((step) => step.executed).length, 2)
})

/* ─────────────────────────── 状态载荷 ─────────────────────────── */

test('超长快照在状态里被截断，并**显式标注**（不装完整）', async () => {
  const page = fakePage(BUTTONS)
  page.state.text = 'x'.repeat(SNAPSHOT_STATE_CAP * 2)
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.99 }])
  await runTask('目标', deps(page.browser, judge))
  const state = judge.asked[0].state
  assert.equal(state.snapshot_truncated, true)
  assert.ok(state.snapshot_chars > SNAPSHOT_STATE_CAP)
  assert.ok(state.snapshot.length <= SNAPSHOT_STATE_CAP + 32, `实际长度 ${state.snapshot.length}`)
  assert.match(state.snapshot, /已截断/)
})

test('状态里带 goal / history / wall_clock（判断需要的上下文）', async () => {
  const page = fakePage(BUTTONS)
  const judge = fakeJudge([{ action: 'click:e1' }, { action: 'click:e1', goalDone: 0.99 }])
  await runTask('目标 X', deps(page.browser, judge))
  const state = judge.asked[1].state
  assert.equal(state.goal, '目标 X')
  assert.ok(Array.isArray(state.history) && state.history.length === 1)
  assert.match(String(state.wall_clock_utc), /^\d{4}-\d{2}-\d{2}T/)
})

test('动作候选封顶（choice 协议上限 255）', async () => {
  const page = fakePage(BUTTONS)
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.99 }])
  await runTask('目标', deps(page.browser, judge))
  const options = judge.asked[0].questions.action.options
  assert.ok(Object.keys(options).length <= MAX_CLICK_CANDIDATES + 40 + 4)
})

/* ─────────────────────────── 纯函数 ─────────────────────────── */

test('stateSignature 忽略 ref 编号（否则"没效果"和"推进了"分不开）', () => {
  const before = { origin: 'https://a.test/', refs: { e1: { role: 'button', name: '继续' } }, digest: 'a', snapshot: '' }
  const after = { origin: 'https://a.test/', refs: { e9: { role: 'button', name: '继续' } }, digest: 'b', snapshot: '' }
  assert.equal(stateSignature(before), stateSignature(after))

  const changed = { origin: 'https://a.test/', refs: { e9: { role: 'button', name: '下一步' } }, digest: 'c', snapshot: '' }
  assert.notEqual(stateSignature(before), stateSignature(changed))
})

test('pickAlternate 按概率降序、排除已试过与不允许的', () => {
  const probabilities = { a: 0.5, b: 0.3, c: 0.15, d: 0.05 }
  assert.equal(pickAlternate(probabilities, new Set(['a']), new Set(['a', 'b', 'c', 'd'])), 'b')
  assert.equal(pickAlternate(probabilities, new Set(['a', 'b']), new Set(['a', 'b', 'c', 'd'])), 'c')
  assert.equal(pickAlternate(probabilities, new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b', 'c', 'd'])), undefined)
  assert.equal(pickAlternate(probabilities, new Set(), new Set(['c'])), 'c', '只能从允许集里选')
  assert.equal(pickAlternate(undefined, new Set(), new Set(['a'])), undefined)
})

test('连续 stale_state（页面一直在动）→ 熔断成 no_progress，而不是把步数烧光', async () => {
  // 每次取快照 digest 都变：决策后必然"页面已变"（真机：点链接触发同页导航）
  let snapshots = 0
  const browser = {
    snapshot: async () => ({
      origin: 'https://a.test/',
      digest: `digest-${++snapshots}`,
      snapshot: 'button "继续" @e1',
      refs: { e1: { role: 'button', name: '继续' } },
    }),
    read: async () => '页面正文',
    get: async () => '标题',
    act: async () => {},
    run: async () => {},
  }
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.1, confirmProbability: 0.1 }])
  const result = await runTask('目标', deps(browser, judge, { maxSteps: 10 }))
  assert.equal(result.status, 'no_progress')
  assert.match(result.trace.join('\n'), /连续 3 次/)
  assert.ok(result.steps.length <= 4, `不该烧完 10 步，实际 ${result.steps.length} 步`)
})
