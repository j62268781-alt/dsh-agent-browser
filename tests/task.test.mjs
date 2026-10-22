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
  candidatesOf,
  looksLikeErrorPage,
  namedSubmitGoal,
  submitControlOf,
  SNAPSHOT_STATE_CAP,
  pickAlternate,
  runSubgoals,
  runTask,
  stateSignature,
} from '../lib/task.js'

/* ─────────────────────────── 替身 ─────────────────────────── */

/** 一个极小的页面模型：refs + 文本；`act` 按元素决定是否改变页面。 */
function fakePage(elements, { withExtract = false } = {}) {
  const state = {
    origin: 'https://example.test/',
    title: 'Example',
    elements: elements.map((element) => ({ ...element })),
    text: '初始页面',
    acts: [],
    values: {},
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
    /** 页面**标题/字段值**（真实实现走 CLI 的 `get title` / `get value`）。 */
    get: async (what, target) => (what === 'title' ? 'E2E 单元测试页' : what === 'value' ? (state.values[target] ?? '') : ''),
    async act(action, target, payload) {
      state.acts.push(`${action} ${target}`)
      if (action === 'fill') state.values[target] = payload?.value ?? ''
      const raw = String(target)
      const byIndex = /^\[data-dsh-idx="(\d+)"\]$/.exec(raw)
      const ref = byIndex === null ? raw.replace(/^@/, '') : state.elements[Number(byIndex[1])]?.ref
      const element = state.elements.find((candidate) => candidate.ref === ref)
      element?.onClick?.(state)
    },
    async run(argv) {
      // 对话框探测是基础设施（每步一次），不算"动作"，也不让断言数组被它污染。
      if (argv[0] === 'dialog') return '✓ No dialog is currently open'
      state.acts.push(argv.join(' '))
    },
    ...(withExtract
      ? {
          // 走页面内抽取路径（mode='extract'）——「命名提交控件」收尾只在这条路径上生效。
          extract: async () => ({
            items: state.elements.map((element, index) => ({
              index,
              role: element.role,
              name: element.name,
              covered: false,
              ...(element.state === undefined ? {} : { state: element.state }),
              ...(element.inMain === undefined ? {} : { inMain: element.inMain }),
              ...(element.near === undefined ? {} : { near: element.near }),
              ...(element.groupId === undefined ? {} : { groupId: element.groupId }),
            })),
            text: state.text,
            title: state.title,
            url: state.origin,
          }),
        }
      : {}),
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

test('受范围限定的内容导航首轮排除页头同名链接并在目标链接导航后收尾', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'a', name: 'comments', inMain: false },
    {
      ref: 'e2', role: 'a', name: '42 comments', near: 'Top story 42 comments', groupId: 'row:1', inMain: true,
      onClick: (state) => { state.origin = 'https://example.test/item?id=1' },
    },
  ], { withExtract: true })
  const judge = fakeJudge([{ action: 'click:1', goalDone: 0.1 }])
  const result = await runTask('Open the comments page of the top story', deps(page.browser, judge))
  assert.equal(judge.asked.length, 0, '唯一且精确匹配的故事评论链接不需要模型重排')
  assert.deepEqual(page.state.acts.filter((action) => !action.startsWith('scrollintoview')), ['click [data-dsh-idx="1"]'])
  assert.equal(result.status, 'needs_verification')
  assert.equal(result.steps.at(-1)?.reason, 'scoped_content_navigation')
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

test('目标点名的提交控件点一次并且页面变了 → 收尾（不再反复点同一个按钮）', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'button', name: 'Find stays', onClick: (state) => { state.text = 'filtered results' } },
  ], { withExtract: true })
  // 判断层会一直选同一个按钮（真实 bench 里就是这样烧到 budget 的）。
  const judge = fakeJudge([
    { action: 'click:0' },
    { action: 'click:0' },
    { action: 'click:0', goalDone: 0.99 },
  ])
  const result = await runTask('submit the search with the Find stays button', deps(page.browser, judge))
  assert.equal(result.status, 'needs_verification')
  assert.equal(result.steps.filter((step) => step.executed).length, 1)
})

test('提交控件收尾的两条红线：登录类、数量型目标都不许用', () => {
  assert.equal(namedSubmitGoal('Log in'), false)
  assert.equal(namedSubmitGoal('Add elements until there are exactly 3 Delete buttons'), false)
  assert.equal(namedSubmitGoal('submit the search with the Find stays button'), true)
  assert.equal(submitControlOf('Find stays'), 'find')
  assert.equal(submitControlOf('Checkbox 1'), undefined)
})

test('导航失败的错误页不算"提交成功"（不能制造 false-done）', async () => {
  assert.equal(looksLikeErrorPage("This site can't be reached", 'ERR_CONNECTION_CLOSED'), true)
  assert.equal(looksLikeErrorPage('Form submitted. Received!'), false)
  const page = fakePage([
    { ref: 'e1', role: 'button', name: 'Submit', onClick: (state) => { state.text = "This site can't be reached ERR_CONNECTION_CLOSED" } },
  ], { withExtract: true })
  const judge = fakeJudge([
    { action: 'click:0' },
    { action: 'click:0', goalDone: 0.2 },
    { action: 'click:0', goalDone: 0.2 },
  ])
  const result = await runTask('Submit the form', deps(page.browser, judge, { maxSteps: 3 }))
  assert.equal(result.steps.some((step) => step.reason === 'named_submit_applied'), false)
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

test('动作因 ref 失效失败（页面在重建）→ 连续 3 次后熔断成 no_progress', async () => {
  // P1 之后 stale 不再靠"执行前再取一次树"判定，而是靠 CLI 的 ref 身份绑定：
  // 页面重建 → 旧 ref 失效（Unknown ref）→ 归类为 stale，重观察；连续 3 次就熔断。
  let snapshots = 0
  const browser = {
    snapshot: async () => {
      snapshots += 1
      return {
        origin: 'https://a.test/',
        digest: `digest-${snapshots}`,
        snapshot: 'button "继续" @e1\nbutton "取消" @e2',
        refs: { e1: { role: 'button', name: '继续' }, e2: { role: 'button', name: '取消' } },
      }
    },
    read: async () => '页面正文',
    get: async () => '标题',
    act: async () => { throw new Error('Unknown ref @e1') },
    run: async () => {},
  }
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.1, confirmProbability: 0.1 }])
  const result = await runTask('目标', deps(browser, judge, { maxSteps: 10 }))
  assert.equal(result.status, 'no_progress')
  assert.match(result.trace.join('\n'), /连续 3 次/)
  assert.ok(result.steps.length <= 4, `不该烧完 10 步，实际 ${result.steps.length} 步`)
})

/**
 * CLI 有两个"ref 指不到元素"的措辞，只认前一个是真机踩到过的 bug：
 *   `Unknown ref: e5`                               —— ref 不在当前快照里
 *   `Could not locate element with role=… name=…`   —— ref 还在，但元素已从 DOM 消失
 * 后一种被当成普通动作失败时，连错两次就 `action_error` 收尾——明明只是页面在重建。
 */
test('元素被删（CLI 报 Could not locate …）也归为 stale，而不是动作失败', async () => {
  let snapshots = 0
  const browser = {
    snapshot: async () => {
      snapshots += 1
      return {
        origin: 'https://a.test/',
        digest: `digest-${snapshots}`,
        snapshot: 'button "继续" @e1\nbutton "取消" @e2',
        refs: { e1: { role: 'button', name: '继续' }, e2: { role: 'button', name: '取消' } },
      }
    },
    read: async () => '页面正文',
    get: async () => '标题',
    act: async () => { throw new Error('agent-browser click 退出码 1：{"error":"Could not locate element with role=button name=继续"}') },
    run: async () => {},
  }
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.1, confirmProbability: 0.1 }])
  const result = await runTask('目标', deps(browser, judge, { maxSteps: 10 }))
  assert.equal(result.status, 'no_progress', `应该是页面重建后的熔断，而不是 action_error：${result.summary}`)
  const trace = result.trace.join('\n')
  assert.match(trace, /stale_state，连续 1 次/, `第一步就该归为 stale：${trace}`)
  assert.match(trace, /stale_state，连续 2 次/, `第二步仍在累加 stale，而不是动作失败计数：${trace}`)
  assert.doesNotMatch(trace, /action_error/)
  assert.equal(result.steps.filter((s) => s.executed).length, 0, '一次都没真执行成功，不该记 executed')
})

test('P1：每一步只取一次快照（不再有"执行前再取一次树"）', async () => {
  const page = fakePage([{ ref: 'e1', role: 'button', name: '完成', onClick: (state) => { state.text = '完成了' } }])
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.99 }])
  const result = await runTask('目标', deps(page.browser, judge))
  assert.equal(result.status, 'needs_verification')
  assert.equal(result.steps.length, 1)
  // 第 1 步观察 1 次；停止后 goal 确认里不再取树（用同一份 snapshot）
  assert.equal(page.state.snapshots, 1, `期望 1 次快照，实际 ${page.state.snapshots}`)
})

test('P2：页面上没有可操作元素 → 不发判断请求就停（no-request bypass）', async () => {
  const browser = {
    snapshot: async () => ({ origin: 'https://a.test/', digest: 'd', snapshot: 'heading "无操作"', refs: {} }),
    read: async () => '页面正文',
    get: async () => '标题',
    act: async () => {},
    run: async () => {},
  }
  const judge = fakeJudge([{ action: 'control:scroll_down' }])
  const result = await runTask('目标', deps(browser, judge))
  // 现在会先做一次**独立确认**（不是动作选择）：确认通过→needs_verification，不通过→no_progress。
  assert.ok(['no_progress', 'needs_verification'].includes(result.status), `实际 ${result.status}`)
  // 允许一次"独立确认"（它不是动作选择）；但**动作问题**一次都不该问。
  assert.equal(judge.asked.filter((entry) => entry.questions.action !== undefined).length, 0, '没有可操作元素时不该问动作')
})

test('P2：唯一可操作元素是输入框（且 goal 点名了它）→ 免判断直接交回宿主', async () => {
  // 免判断只在"这个输入框就是目标"时成立：goal 带打字动词，或框名出现在 goal 里。
  // 真机 shadow-checkbox 教训：页面上只有一个 textbox 但目标是 "Check the checkbox"，
  // 旧逻辑直接免判断 → input_required，连判断层都没见过目标。
  const page = fakePage([{ ref: 'e1', role: 'textbox', name: '搜索' }])
  const judge = fakeJudge([])
  const result = await runTask('在搜索框里输入关键词', deps(page.browser, judge))
  assert.equal(judge.asked.length, 0, '唯一的输入框不必问判断层')
  assert.equal(result.status, 'input_required')
})

test('P2b：唯一输入框与目标无关 → 不走免判断（会问判断层）', async () => {
  const page = fakePage([{ ref: 'e1', role: 'textbox', name: '搜索' }])
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.1 }])
  const result = await runTask('Check the checkbox', deps(page.browser, judge))
  assert.ok(judge.asked.length > 0, '目标与输入框无关时应该问判断层')
  assert.notEqual(result.status, 'input_required')
})

test('P3：快照失败会自动重试（文档在变时不该直接失败）', async () => {
  let attempts = 0
  const page = fakePage([{ ref: 'e1', role: 'button', name: '完成' }])
  page.browser.snapshot = async () => {
    attempts += 1
    if (attempts <= 2) throw new Error('Document changed during evaluation')
    page.state.snapshots += 1
    return {
      origin: page.state.origin,
      digest: 'd',
      snapshot: 'button "完成" @e1',
      refs: { e1: { role: 'button', name: '完成' } },
    }
  }
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.99 }])
  const result = await runTask('目标', deps(page.browser, judge))
  assert.equal(result.status, 'needs_verification')
  assert.ok(attempts >= 3, `应该重试过，实际 ${attempts} 次`)
})

test('P4：结果带分项耗时与估算成本（可复跑的账）', async () => {
  const page = fakePage([{ ref: 'e1', role: 'button', name: '完成', onClick: (state) => { state.text = '完成' } }])
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.99 }])
  const result = await runTask('目标', deps(page.browser, judge))
  for (const key of ['snapshotMs', 'readMs', 'titleMs', 'askMs', 'actMs', 'totalMs']) {
    assert.equal(typeof result.timings[key], 'number', `timings.${key} 应该是数字`)
  }
  assert.ok(result.timings.totalMs >= 0)
  assert.equal(typeof result.usage.estCostUsd, 'number')
  assert.ok(result.usage.estCostUsd > 0, '有 tokens 就应有正的估算成本')
})

test('无名称的可交互元素也要进候选（真实站点：hao123 首页的搜索框没有可访问名）', () => {
  const snapshot = {
    origin: 'https://www.hao123.com/',
    digest: 'd',
    snapshot: 'textbox @e1\nbutton "百度一下" @e2',
    refs: {
      e1: { role: 'textbox', name: '' },
      e2: { role: 'button', name: '百度一下' },
    },
  }
  const candidates = candidatesOf(snapshot, '搜索 jev')
  assert.ok(candidates.some((candidate) => candidate.id === 'input:e1'), '无名称的搜索框必须出现在输入候选里')
  const input = candidates.find((candidate) => candidate.id === 'input:e1')
  assert.match(input.description, /无名称的 textbox/)
})

test('P6：observe 一次拿齐树+正文+标题（batch 合并，少两次进程启动）', async () => {
  let observes = 0
  let snapshots = 0
  const browser = {
    async observe() {
      observes += 1
      return {
        origin: 'https://a.test/',
        digest: 'd',
        snapshot: 'button "完成" @e1',
        refs: { e1: { role: 'button', name: '完成' } },
        text: '页面正文',
        title: '标题',
      }
    },
    async snapshot() {
      snapshots += 1
      throw new Error('不该单独取快照（应该走 observe 的 batch）')
    },
    async read() { return '页面正文' },
    async get() { return '标题' },
    async act() {},
    async run() {},
  }
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.99 }])
  const result = await runTask('目标', deps(browser, judge))
  assert.equal(result.status, 'needs_verification')
  assert.equal(observes, 1, '一次 observe = 一次进程')
  assert.equal(snapshots, 0, '不该再单独取整树')
})

test('P8：优先用页面内抽取（一次 eval 拿候选），判断层收到的选项不超过上限', async () => {
  let extractCalls = 0
  let treeCalls = 0
  const items = Array.from({ length: 60 }, (_, index) => ({
    index,
    role: index === 0 ? 'textbox' : 'link',
    name: index === 0 ? '搜索' : `链接 ${index}`,
    covered: false,
  }))
  const browser = {
    async extract() {
      extractCalls += 1
      return { items, text: '页面正文'.repeat(20), title: '标题', url: 'https://a.test/' }
    },
    async snapshot() { treeCalls += 1; throw new Error('不该退回整树') },
    async observe() { treeCalls += 1; throw new Error('不该退回整树') },
    async read() { return '页面正文'.repeat(20) },
    async get() { return '标题' },
    async act() {},
    async run() {},
  }
  const judge = fakeJudge([{ action: 'click:5', goalDone: 0.99 }])
  const result = await runTask('点击链接 5', deps(browser, judge))
  assert.equal(extractCalls, 1, '一次抽取 = 一次进程')
  assert.equal(treeCalls, 0, '抽取成功就不该退回整树')
  assert.equal(result.status, 'needs_verification')
  // 候选超过上限时会先问"组"（两阶段），所以取**带 action 的那一次**来检查选项数。
  const actionAsk = judge.asked.find((entry) => entry.questions.action !== undefined)
  assert.ok(actionAsk !== undefined, '应该有一次带 action 的判断')
  const asked = actionAsk.questions.action.options
  assert.ok(Object.keys(asked).length <= 10, `判断层选项 ${Object.keys(asked).length} 个，超过上限`)
})

test('P8：首轮 snapshot 发结构大纲，action options 保留文案且 digest 覆盖全候选', async () => {
  const makeItems = (lastName) => Array.from({ length: 12 }, (_, row) => {
    const recordName = row === 11 ? lastName : `Record ${row}`
    return [
      { index: row * 3, role: 'link', name: recordName, covered: false, groupId: `g${row}` },
      { index: row * 3 + 1, role: 'button', name: 'Edit', covered: false, groupId: `g${row}` },
      { index: row * 3 + 2, role: 'button', name: 'Delete', covered: false, groupId: `g${row}` },
    ]
  }).flat()
  const makeBrowser = (lastName) => ({
    async extract() { return { items: makeItems(lastName), text: 'Table with repeated records. '.repeat(4), title: 'Records', url: 'https://a.test/records' } },
    async snapshot() { throw new Error('抽取成功不应退回整树') },
    async read() { return 'Table with repeated records.' },
    async get() { return 'Records' },
    async act() {},
    async run() {},
  })
  const run = async (lastName) => {
    const judge = fakeJudge([{ action: 'click:0', goalDone: 0.99 }])
    const result = await runTask('Open Record 0', deps(makeBrowser(lastName), judge))
    const actionAsk = judge.asked.find((entry) => entry.questions.action !== undefined)
    assert.ok(actionAsk !== undefined)
    return { result, state: actionAsk.state, options: JSON.stringify(actionAsk.questions.action.options) }
  }

  const first = await run('Record 11')
  const second = await run('Changed record 11')
  assert.match(first.state.snapshot, /group×\d+: link:link \+ button:button/)
  assert.ok(!first.state.snapshot.includes('Record') && !first.state.snapshot.includes('Edit'))
  assert.ok(first.options.includes('Record') || first.options.includes('Edit'), '详细候选文案仍由 action options 提供')
  assert.ok(first.state.snapshot.length < first.options.length, '大纲应比详细选项短')
  assert.notEqual(first.result.steps[0]?.digest, second.result.steps[0]?.digest, '尾部候选变化仍应改变完整 digest')
})

test('P8：抽取失败时退回整树（功能不降级）', async () => {
  const page = fakePage([{ ref: 'e1', role: 'button', name: '完成', onClick: (state) => { state.text = '完成' } }])
  page.browser.extract = async () => { throw new Error('CSP 拦住了 eval') }
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.99 }])
  const result = await runTask('目标', deps(page.browser, judge))
  assert.equal(result.status, 'needs_verification')
  assert.ok(result.trace.some((line) => /退回整树/.test(line)), '应该记录退回原因')
})

test('P8：目标英文、页面中文时不因"相关性为 0"误退回整树', async () => {
  let treeCalls = 0
  const items = [
    { index: 0, role: 'a', name: '七日天气', covered: false },
    { index: 1, role: 'a', name: '今日头条', covered: false },
  ]
  const browser = {
    async extract() {
      return { items, text: '页面正文'.repeat(20), title: '标题', url: 'https://a.test/' }
    },
    async snapshot() { treeCalls += 1; throw new Error('不该退回整树') },
    async observe() { treeCalls += 1; throw new Error('不该退回整树') },
    async read() { return '页面正文'.repeat(20) },
    async get() { return '标题' },
    async act() {},
    async run() {},
  }
  const judge = fakeJudge([{ action: 'click:0', goalDone: 0.99 }])
  const result = await runTask('click the top-left locality', deps(browser, judge))
  assert.equal(treeCalls, 0, '语言不一致时不该退回整树')
  assert.ok(result.trace.some((line) => /页面内抽取/.test(line)))
})

/* ───────────────── 调用方一次给全字段值（inputs）与状态守卫 ───────────────── */

function extractPage(items) {
  return {
    async extract() {
      return { items, text: '页面正文'.repeat(20), title: '标题', url: 'https://a.test/' }
    },
    async snapshot() { throw new Error('不该退回整树') },
    async read() { return '页面正文' },
    async get() { return '标题' },
    async act(action, target, payload) { this.acts = [...(this.acts ?? []), `${action} ${target} ${JSON.stringify(payload ?? {})}`] },
    async run() {},
  }
}

test('inputs：调用方给值 → 同一次调用内直接 fill，不再 input_required', async () => {
  const browser = extractPage([
    { index: 0, role: 'searchbox', name: 'Destination', covered: false, state: '' },
  ])
  // 第 1 步填值（goal_done 低），第 2 步才宣布完成
  const judge = fakeJudge([{ action: 'input:0', goalDone: 0.1 }, { action: 'control:wait', goalDone: 0.99 }])
  const result = await runTask('type Lisbon into Destination', deps(browser, judge, { inputs: { Destination: 'Lisbon' } }))
  assert.equal(result.status, 'needs_verification', '不该再返回 input_required')
  assert.ok((browser.acts ?? []).some((line) => line.startsWith('fill ')), `应该执行 fill，实际：${browser.acts}`)
  assert.ok(result.trace.some((line) => /按调用方的值填/.test(line)))
})

test('inputs：下拉框 → select（不是 fill）', async () => {
  const browser = extractPage([
    { index: 0, role: 'combobox', name: 'Stay category', covered: false, state: '当前值: all' },
  ])
  const judge = fakeJudge([{ action: 'input:0', goalDone: 0.99 }])
  await runTask('choose the Design category', deps(browser, judge, { inputs: { 'Stay category': 'Design' } }))
  assert.ok((browser.acts ?? []).some((line) => line.startsWith('select ')), `应该执行 select，实际：${browser.acts}`)
})

test('inputs：勾选框 → check（幂等，不是 click 切换）', async () => {
  const browser = extractPage([
    { index: 0, role: 'checkbox', name: 'Free cancellation', covered: false, state: '未勾选' },
  ])
  const judge = fakeJudge([{ action: 'click:0', goalDone: 0.1 }])
  await runTask('enable Free cancellation', deps(browser, judge, { inputs: { 'Free cancellation': 'true' } }))
  assert.ok((browser.acts ?? []).some((line) => line.startsWith('check ')), `应该执行 check，实际：${browser.acts}`)
})

test('状态守卫：已勾选又要求 enable → 不再点它（避免把开关点回去）', async () => {
  const browser = extractPage([
    { index: 0, role: 'checkbox', name: 'Free cancellation', covered: false, state: '已勾选' },
    { index: 1, role: 'button', name: 'Open Casa Flora', covered: false, state: '' },
  ])
  const judge = fakeJudge([{ action: 'click:1', goalDone: 0.99 }])
  const result = await runTask('enable Free cancellation then open Casa Flora', deps(browser, judge))
  assert.ok(result.trace.some((line) => /已处于目标状态/.test(line)), '应该记录状态守卫跳过')
  const asked = judge.asked[0]?.questions.action.options ?? {}
  assert.ok(!Object.keys(asked).includes('click:0'), `已满足的候选不该发给判断层：${Object.keys(asked)}`)
  assert.ok(!(browser.acts ?? []).some((line) => line.includes('checkbox') || /click \[data-dsh-idx="0"\]/.test(line)), '不该点那个已勾选的复选框')
})

test('状态守卫：可操作元素全已满足 → needs_verification（交回宿主复核）', async () => {
  const browser = extractPage([
    { index: 0, role: 'checkbox', name: 'Free cancellation', covered: false, state: '已勾选' },
  ])
  const judge = fakeJudge([])
  const result = await runTask('enable Free cancellation', deps(browser, judge))
  assert.equal(result.status, 'needs_verification')
  assert.equal(judge.asked.length, 0, '全已满足时不该花判断请求')
})

/* ───────────────── 结构化校验失败 → 确定性缩容（dsh-judgment §B） ───────────────── */

test('nextJudgeOptionCap：用 optionCount 减半，而不是固定阶梯', async () => {
  const { nextJudgeOptionCap } = await import('../lib/task.js')
  const error = Object.assign(new Error('分布不合法'), {
    code: 'invalid-response',
    validation: { optionCount: 40, sum: 0.95, tolerance: 0.02 },
  })
  assert.equal(nextJudgeOptionCap(error, 40), 20)
  assert.equal(nextJudgeOptionCap(error, 20), 10)
  assert.equal(nextJudgeOptionCap(error, 10), 5)
  assert.equal(nextJudgeOptionCap(error, 6), 4, '不低于下限 4')
})

test('nextJudgeOptionCap：没有结构化数值时退回减半，且一定比当前小', async () => {
  const { nextJudgeOptionCap } = await import('../lib/task.js')
  const error = Object.assign(new Error('x'), { code: 'invalid-response' })
  assert.equal(nextJudgeOptionCap(error, 40), 20)
  assert.equal(nextJudgeOptionCap(error, 5), 4)
  const tiny = Object.assign(new Error('x'), { code: 'invalid-response', validation: { optionCount: 3 } })
  assert.equal(nextJudgeOptionCap(tiny, 3), 2, 'optionCount 很小时仍要缩到更小')
})

test('distribution 不合法 → 用结构化数值缩容，并在 trace 里写出 Σp 与容差', async () => {
  const page = fakePage([{ ref: 'e1', role: 'button', name: '完成', onClick: (state) => { state.text = '完成' } }])
  let calls = 0
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.99 }])
  const wrapped = {
    apiVersion: judge.apiVersion,
    async ask(state, questions, options) {
      calls += 1
      if (calls === 1) {
        throw Object.assign(new Error('答案 "action" 的概率和 0.95 偏离 1 超过容差 0.02'), {
          code: 'invalid-response',
          validation: { optionCount: 5, sum: 0.95, tolerance: 0.02 },
        })
      }
      return judge.ask(state, questions, options)
    },
  }
  const result = await runTask('目标', deps(page.browser, wrapped))
  const trace = result.trace.join('\n')
  assert.match(trace, /Σp 0\.95/)
  assert.match(trace, /容差 0\.02/)
  assert.match(trace, /缩到 4 个/)
  assert.equal(result.status, 'needs_verification')
})

/* ───────────────── 一次请求问全：页面错误 / 不可逆（Ying-Kai-Liao/jev-browser） ───────────────── */

function judgeWith(extra) {
  const base = fakeJudge([{ action: extra.action ?? 'click:e1', goalDone: 0.1 }])
  return {
    apiVersion: base.apiVersion,
    asked: base.asked,
    async ask(state, questions, options) {
      const result = await base.ask(state, questions, options)
      return { ...result, answers: { ...result.answers, ...extra.answers } }
    },
  }
}

test('页面显示错误 → status=page_error（不是"没做完"）', async () => {
  const page = fakePage([{ ref: 'e1', role: 'button', name: '登录', onClick: (state) => { state.text = '错误' } }])
  const judge = judgeWith({ answers: { page_error: { kind: 'noul', probability: 0.95 } } })
  const result = await runTask('登录', deps(page.browser, judge))
  assert.equal(result.status, 'page_error')
  assert.ok(result.trace.some((line) => /页面显示错误/.test(line)))
  assert.deepEqual(page.state.acts, [], '报错时不该继续动作')
})

test('不可逆动作 → status=needs_confirmation，且不执行', async () => {
  const page = fakePage([{ ref: 'e1', role: 'button', name: '提交订单', onClick: (state) => { state.text = '已下单' } }])
  const judge = judgeWith({ answers: { irreversible: { kind: 'noul', probability: 0.92 } } })
  const result = await runTask('下单', deps(page.browser, judge))
  assert.equal(result.status, 'needs_confirmation')
  assert.deepEqual(page.state.acts, [], '未确认前不该执行不可逆动作')
})

test('不可逆动作：调用方确认后（allowIrreversible）照常执行', async () => {
  const page = fakePage([{ ref: 'e1', role: 'button', name: '提交订单', onClick: (state) => { state.text = '已下单' } }])
  const judge = judgeWith({ answers: { irreversible: { kind: 'noul', probability: 0.92 }, goal_done: { kind: 'noul', probability: 0 } } })
  const result = await runTask('下单', deps(page.browser, judge, { allowIrreversible: true }))
  assert.notEqual(result.status, 'needs_confirmation')
  assert.ok(page.state.acts.length >= 1, `确认后应该真的执行，实际：${page.state.acts}`)
})

/* ───────────────── values 语义：判断层只选 key，值由调用方给 ───────────────── */

test('多个值时问"用哪个值"（敏感 key 只显示名字，不展示值）', async () => {
  const { questionsOf } = await import('../lib/task.js')
  const candidates = [{ id: 'input:0', description: '在「Password」里输入', kind: 'input', ref: '[data-dsh-idx="0"]' }]
  const questions = questionsOf('登录', candidates, { email: 'a@b.c', password: 'hunter2', otp: '123456' })
  assert.ok(questions.value !== undefined, '有多个值时应带 value 问题')
  const options = questions.value.options
  assert.match(options['value:email'], /a@b\.c/, '非敏感值可以展示')
  assert.ok(!options['value:password'].includes('hunter2'), '密码值绝不出现在给判断层的问题里')
  assert.match(options['value:password'], /敏感值/)
  assert.ok(options['value:none'] !== undefined, '要允许"都不合适"')
})

test('只有一个值时不问（直接用）', async () => {
  const { questionsOf } = await import('../lib/task.js')
  const candidates = [{ id: 'input:0', description: '在「Destination」里输入', kind: 'input', ref: '[data-dsh-idx="0"]' }]
  assert.equal(questionsOf('搜索', candidates, { Destination: 'Lisbon' }).value, undefined)
})

test('字段名对不上时，用判断层选的值 key 来填', async () => {
  const browser = extractPage([
    { index: 0, role: 'searchbox', name: 'Search destinations', covered: false, state: '' },
  ])
  const base = fakeJudge([{ action: 'input:0', goalDone: 0.1 }])
  const judge = {
    apiVersion: base.apiVersion,
    asked: base.asked,
    async ask(state, questions, options) {
      const result = await base.ask(state, questions, options)
      return { ...result, answers: { ...result.answers, value: { kind: 'choice', optionId: 'value:city', probabilities: { 'value:city': 1 }, confidence: 1 } } }
    },
  }
  const result = await runTask('search somewhere', deps(browser, judge, { inputs: { city: 'Lisbon', other: 'X' } }))
  assert.ok((browser.acts ?? []).some((line) => line.startsWith('fill ')), `应该用选中的值填，实际：${browser.acts}`)
  assert.ok(result.trace.some((line) => /判断层选了调用方的值「city」/.test(line)))
})

test('调用方给的字段还没生效时，不允许 goal_done 结束（假阳性守卫）', async () => {
  const browser = extractPage([
    { index: 0, role: 'checkbox', name: 'Free cancellation', covered: false, state: '未勾选' },
  ])
  // 判断层两次都说"已完成"（模拟它看到页面正文里有相关词就判完成）
  const judge = judgeWith({ action: 'click:0', answers: { goal_done: { kind: 'noul', probability: 0.95 } } })
  const result = await runTask('enable Free cancellation', deps(browser, judge, { inputs: { 'Free cancellation': 'true' } }))
  assert.ok(result.trace.some((line) => /还没生效/.test(line)), '应该记录"待生效字段"守卫')
  assert.ok((browser.acts ?? []).some((line) => line.startsWith('check ')), `应该先把字段弄生效，实际：${browser.acts}`)
})

/* ───────────────── likely_done / ambiguous（Ying-Kai-Liao/jev-browser） ───────────────── */

test('goal_done 落在中间带 + 确认不低 → likely_done（交回宿主验证，不继续乱点）', async () => {
  const page = fakePage([{ ref: 'e1', role: 'button', name: '继续', onClick: (state) => { state.text = `step-${++state.counter ?? 1}` } }])
  const judge = fakeJudge([
    { action: 'click:e1', goalDone: 0.1 },
    { action: 'click:e1', goalDone: 0.7, confirmProbability: 0.8 },
  ])
  const result = await runTask('目标', deps(page.browser, judge))
  assert.equal(result.status, 'likely_done')
  assert.equal(page.state.acts.length, 1, '中间带之后不该继续执行动作')
  assert.ok(result.trace.some((line) => /likely_done/.test(line)))
})

test('置信度低且前两名接近 → ambiguous，并给出前 3 名候选', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'button', name: '保存' },
    { ref: 'e2', role: 'button', name: '提交' },
    { ref: 'e3', role: 'button', name: '取消' },
  ])
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.1, confidence: 0.3, probabilities: { 'click:e1': 0.35, 'click:e2': 0.30, 'click:e3': 0.2 } }])
  const result = await runTask('目标', deps(page.browser, judge))
  assert.equal(result.status, 'ambiguous')
  assert.deepEqual(page.state.acts, [], 'ambiguous 时不该执行动作')
  assert.equal(result.candidates?.length, 3)
  assert.match(result.candidates[0].description, /保存|提交|取消/)
})

/* ───────────────── 有序子目标（subgoals）：只在 needs_verification 后推进 ───────────────── */

test('subgoals：每个阶段验证通过后按顺序推进，并标出阶段号', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'button', name: '继续', onClick: (state) => { state.text = '第一步完成' } },
    { ref: 'e2', role: 'button', name: '完成', onClick: (state) => { state.text = '第二步完成' } },
  ])
  const judge = fakeJudge([
    { action: 'click:e1', goalDone: 0.1, confirmProbability: 0.95 },
    { action: 'click:e1', goalDone: 0.95 },
    { action: 'click:e2', goalDone: 0.1, confirmProbability: 0.95 },
    { action: 'click:e2', goalDone: 0.93 },
  ])
  const result = await runSubgoals('先继续再完成', [
    { goal: '点击继续' },
    { goal: '点击完成' },
  ], deps(page.browser, judge))

  assert.equal(result.status, 'needs_verification')
  assert.deepEqual(page.state.acts, ['click @e1', 'click @e2'], '两个阶段都要执行，且顺序不能反')
  assert.deepEqual(result.steps.map((step) => step.phase), [1, 1, 2, 2])
  assert.deepEqual(result.steps.map((step) => step.step), [1, 2, 3, 4], '总步数在阶段之间连续')
  assert.ok(result.trace.some((line) => line.includes('按顺序执行 2 个子目标')))
})

test('subgoals：阶段返回 likely_done 就停下，不自动跑下一阶段', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'button', name: '继续', onClick: (state) => { state.text = '第一步完成' } },
    { ref: 'e2', role: 'button', name: '完成' },
    { ref: 'e3', role: 'button', name: '不该点我' },
  ])
  const judge = fakeJudge([
    { action: 'click:e1', goalDone: 0.1, confirmProbability: 0.9 },
    { action: 'click:e1', goalDone: 0.95 },
    { action: 'click:e2', goalDone: 0.7, confirmProbability: 0.8 },
  ])
  const result = await runSubgoals('两阶段', [
    { goal: '点击继续' },
    { goal: '点击完成' },
    { goal: '点击不该点我' },
  ], deps(page.browser, judge))

  assert.equal(result.status, 'likely_done', '不确定的完成只交回宿主验证')
  assert.ok(!page.state.acts.includes('click @e3'), '第三阶段不能跑')
  assert.equal(page.state.acts.filter((line) => line === 'click @e2').length, 1, '第二阶段停下后不再重复点')
  assert.ok(result.trace.some((line) => line.includes('停止在子目标 2/3')))
})

test('subgoals：needs_confirmation 原样交回，不跨过不可逆门', async () => {
  const page = fakePage([{ ref: 'e1', role: 'button', name: '下单' }])
  const judge = {
    apiVersion: 1,
    async ask() {
      return {
        answers: {
          action: { kind: 'choice', optionId: 'click:e1', probabilities: { 'click:e1': 1 }, confidence: 1 },
          goal_done: { kind: 'noul', probability: 0 },
          stuck: { kind: 'noul', probability: 0 },
          irreversible: { kind: 'noul', probability: 0.95 },
        },
        usage: { inputTokens: 1, outputTokens: 0 },
        model: 'test', provider: 'test', connection: 'test', fingerprint: 'test',
      }
    },
  }
  const result = await runSubgoals('下单', [{ goal: '提交订单' }, { goal: '查看结果' }], deps(page.browser, judge))
  assert.equal(result.status, 'needs_confirmation')
  assert.deepEqual(page.state.acts, [], '不可逆动作未确认前不能执行')
  assert.ok(result.trace.some((line) => line.includes('停止在子目标 1/2')))
})

test('subgoals：整体步数上限跨阶段共享', async () => {
  const page = fakePage([{ ref: 'e1', role: 'button', name: '继续', onClick: (state) => { state.text = '动了一下' } }])
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.1 }])
  const result = await runSubgoals('两阶段', [{ goal: '点击继续' }, { goal: '再点一次' }], deps(page.browser, judge, { maxSteps: 1 }))
  assert.equal(result.status, 'budget')
  assert.equal(result.steps.length, 1, '总步数不能因为分阶段而翻倍')
  assert.ok(result.trace.some((line) => line.includes('子目标 2/2 未开始')))
})

test('subgoals：空列表或空目标 → 显式报错（不静默当成已完成）', async () => {
  const page = fakePage(BUTTONS)
  await assert.rejects(() => runSubgoals('目标', [], deps(page.browser, fakeJudge([]))), /subgoals/)
  await assert.rejects(() => runSubgoals('目标', [{ goal: '  ' }], deps(page.browser, fakeJudge([]))), /subgoals/)
})

/* ───────────────── "填完再继续"不能被购物车页的 Checkout 跳转提前收尾 ───────────────── */

test('目标要求填值：跳转到收货页时还没填过任何字段 → 不收尾，继续填', async () => {
  const page = fakePage([
    {
      ref: 'e1',
      role: 'button',
      name: 'Checkout',
      onClick: (state) => {
        state.origin = 'https://example.test/checkout-step-one.html'
        state.text = 'Checkout: Your Information'
        state.elements = [
          { ref: 'e2', role: 'textbox', name: 'First Name' },
          { ref: 'e3', role: 'button', name: 'Continue' },
        ]
      },
    },
  ], { withExtract: true })
  const judge = fakeJudge([
    { action: 'click:0', goalDone: 0.05 },
    { action: 'input:0', goalDone: 0.05 },
    { action: 'click:1', goalDone: 0.05, confirmProbability: 0.95 },
  ])
  const result = await runTask('Fill in the checkout information and continue', deps(page.browser, judge, {
    inputs: { first_name: 'Ada' },
  }))

  const trace = result.trace.join('\n')
  assert.match(trace, /还没填过 → 不按完成收尾/, '在购物车页点 Checkout 跳转后不能宣布完成')
  assert.ok(
    result.steps.some((step) => step.reason === 'filled_from_inputs'),
    `跳转后应该继续把 First Name 填上：${JSON.stringify(result.steps)}`,
  )
  assert.ok(page.state.acts.some((line) => line.startsWith('fill ')), `应该执行 fill，实际：${page.state.acts}`)
  assert.equal(result.status, 'needs_verification')
})

/* ───────────────── 登录成功 / 加入购物车：确定性证据（不是靠 goal_done 抖） ───────────────── */

/** 会随动作变化的抽取页：fill 会把 state 写成"当前值"，click 由 handler 决定页面怎么变。 */
function liveExtractPage(items, handlers = {}) {
  const state = { items: items.map((item) => ({ ...item })), text: '初始页面', title: '标题', url: 'https://a.test/' }
  return {
    state,
    browser: {
      async extract() {
        return { items: state.items, text: state.text, title: state.title, url: state.url }
      },
      // 抽取覆盖不足时会退回整树：这里给一棵"没有文本输入框"的空树，正好符合登录后的页面。
      async snapshot() { return { origin: state.url, digest: 'tree-digest', snapshot: '', refs: {} } },
      async read() { return state.text },
      async get() { return state.title },
      async act(action, ref, payload) {
        const index = state.items.findIndex((_, i) => String(ref) === `[data-dsh-idx="${i}"]`)
        if (action === 'fill' && index >= 0) state.items[index].state = `当前值: ${payload.value}`
        handlers[action]?.(state, { index, payload })
      },
      async run() {},
    },
  }
}

test('登录后只剩下拉框（没有文本输入框）也算表单已翻页 → 不收 ambiguous', async () => {
  const page = liveExtractPage([
    { index: 0, role: 'textbox', name: 'Password', covered: false, state: '' },
    { index: 1, role: 'button', name: 'Login', covered: false, state: '' },
  ], {
    click: (state) => {
      state.text = 'Products'
      state.items = [{ index: 0, role: 'combobox', name: 'Sort products', covered: false, state: '当前值: Name (A to Z)' }]
    },
  })
  const judge = fakeJudge([{ action: 'input:0', goalDone: 0.1 }, { action: 'click:1', goalDone: 0.2 }])
  const result = await runTask('Log in', deps(page.browser, judge, { inputs: { password: 'secret_sauce' } }))
  assert.equal(result.status, 'needs_verification')
  assert.match(result.trace.join('\n'), /密钥字段已填、页面已无输入框/)
})

test('点过 Add to cart 后出现 Remove → 商品已进车，不用判断层再猜', async () => {
  const page = liveExtractPage([
    { index: 0, role: 'button', name: 'Add to cart', covered: false, state: '' },
    { index: 1, role: 'button', name: 'View details', covered: false, state: '' },
  ], {
    click: (state) => {
      state.text = '1 item in cart'
      // 别的商品仍然有 Add to cart：真实列表页也这样，抽取的"目标覆盖检查"才不会退回整树。
      state.items = [
        { index: 0, role: 'button', name: 'Remove', covered: false, state: '' },
        { index: 1, role: 'button', name: 'Add to cart', covered: false, state: '' },
        { index: 2, role: 'button', name: 'View details', covered: false, state: '' },
      ]
    },
  })
  const judge = fakeJudge([{ action: 'click:0', goalDone: 0.1 }, { action: 'click:1', goalDone: 0.1 }])
  const result = await runTask('Add the Sauce Labs Backpack to the cart', deps(page.browser, judge))
  assert.equal(result.status, 'needs_verification')
  assert.match(result.trace.join('\n'), /商品已进购物车/)
})

/* ───────────────── 单步判定 / 动词排序（粗粒度目标不能提前收尾） ───────────────── */

test('singleStepGoal：逗号+and 串起来的多个行动子句算多步', async () => {
  const { singleStepGoal } = await import('../lib/task.js')
  assert.equal(singleStepGoal('Log in, buy the Sauce Labs Backpack and complete the checkout'), false)
  assert.equal(singleStepGoal('Fill in the checkout information and continue'), true, 'continue 单独不算独立子句')
  assert.equal(singleStepGoal('Add the Sauce Labs Backpack to the cart'), true)
  assert.equal(singleStepGoal('Log in'), true)
})



/* ───────────────── 整树路径的读回验证（iframe 表单：填了但判断层永远判不出） ───────────────── */

test('整树路径：读回值一致 → 纯填值目标直接交回宿主（不再 budget）', async () => {
  // 无名称 textbox 是 iframe 里的典型形态：候选没有 name/state，inputsApplied 靠读回值。
  const page = fakePage([{ ref: 'e1', role: 'textbox', name: '' }])
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.05 }])
  const result = await runTask('Type the email address into the email field of the embedded form', deps(page.browser, judge, {
    inputs: { email: 'jev@example.com' },
  }))
  assert.equal(result.status, 'needs_verification', `应该靠读回值收尾，实际：${result.status} / ${result.reason}`)
  assert.match(result.trace.join('\n'), /读回值确认/)
})

test('整树路径：读回值被页面清空 → 不当作已生效，也不声称完成', async () => {
  const page = fakePage([{ ref: 'e1', role: 'textbox', name: '' }])
  // 页面把值吞掉：fill 之后读回空串
  const browser = { ...page.browser, get: async (what) => (what === 'title' ? 'E2E 单元测试页' : '') }
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.05 }])
  const result = await runTask('Type the date into the date field', deps(browser, judge, {
    inputs: { date: '09/16/2026' }, maxSteps: 6,
  }))
  assert.notEqual(result.status, 'needs_verification')
  assert.notEqual(result.status, 'likely_done')
  assert.match(result.trace.join('\n'), /不一致/)
})

test('FOLLOW_UP_VERBS：address 里的 add 不算"还要添加"', async () => {
  const { FOLLOW_UP_VERBS } = await import('../lib/task.js')
  assert.equal(FOLLOW_UP_VERBS.test('Type the email address into the field'), false)
  assert.equal(FOLLOW_UP_VERBS.test('Add the backpack to the cart'), true)
})

/* ───────────────── 确定性加购 / 填完提交 ───────────────── */

test('addToCartTarget：目标点名的商品只有一个加购控件对得上 → 返回它', async () => {
  const { addToCartTarget } = await import('../lib/task.js')
  const candidates = [
    { id: 'click:1', kind: 'click', name: 'Add to cart', near: 'Sauce Labs Backpack $29.99' },
    { id: 'click:2', kind: 'click', name: 'Add to cart', near: 'Sauce Labs Bike Light $9.99' },
    { id: 'click:3', kind: 'click', name: 'View details for Sauce Labs Backpack', near: 'Sauce Labs Backpack' },
  ]
  const target = addToCartTarget('Add the Sauce Labs Backpack to the cart', candidates)
  assert.equal(target?.id, 'click:1')
  assert.equal(addToCartTarget('Open the cart page', candidates), undefined, '非加购目标不触发')
})

test('fillThenSubmitGoal：填一下再提交是两动作单目标，多动作目标不算', async () => {
  const { fillThenSubmitGoal } = await import('../lib/task.js')
  assert.equal(fillThenSubmitGoal('Type into the text input, then submit the form'), true)
  assert.equal(fillThenSubmitGoal('Fill in the text input, password, textarea and choose the second radio, then submit'), false)
  assert.equal(fillThenSubmitGoal('Log in'), false)
})

/* ───────────────── 终态页：跳转后没有任何可操作元素 ───────────────── */

/** 一个"点一下就跳到只剩正文的终态页"的替身（new-window / webform 提交页的真实形状）。 */
function terminalPage({ navigate = true } = {}) {
  const state = { url: 'https://a.test/windows', text: 'Click Here for a new window', navigated: false }
  // 页面都会变成"只剩正文的终态"；`navigate` 决定地址是否也跟着变
  // （同一形态的两种真实情况：真跳转 vs 原地把内容换掉）。
  const enterTerminal = () => {
    state.navigated = true
    state.text = 'New Window'
    if (navigate) state.url = 'https://a.test/windows/new'
  }
  const browser = {
    async extract() {
      const items = state.navigated ? [] : [{ index: 0, role: 'a', name: 'Open the new window', covered: false, tag: 'a' }]
      return { items, text: state.text, title: state.navigated ? 'New Window' : 'Windows', url: state.url }
    },
    async snapshot() {
      return {
        origin: state.url,
        digest: state.navigated ? 'terminal' : 'windows',
        snapshot: state.navigated ? 'text  New Window' : 'link "Open the new window" @e1',
        refs: state.navigated ? {} : { e1: { name: 'Open the new window', role: 'link' } },
      }
    },
    async read() { return state.text },
    async get() { return state.navigated ? 'New Window' : 'Windows' },
    async act(action) {
      if (action === 'click') enterTerminal()
    },
    async jsClick() { enterTerminal() },
    async run() {},
  }
  return { state, browser }
}

test('终态页：确实跳转过 + 独立确认高 → needs_verification（不再 no_progress）', async () => {
  const page = terminalPage()
  const judge = fakeJudge([{ action: 'click:0', goalDone: 0.2 }]) // confirm 默认 0.95
  const result = await runTask('Open the new window', deps(page.browser, judge))
  assert.equal(result.status, 'needs_verification')
  assert.ok(result.trace.some((line) => /终态/.test(line)), `trace 里应有终态判定，实际：${result.trace.join('\n')}`)
})

test('终态页：**没跳转过**的空页面仍然 no_progress（空页面本身不是完成证据）', async () => {
  const page = terminalPage({ navigate: false })
  const judge = fakeJudge([{ action: 'click:0', goalDone: 0.2 }])
  const result = await runTask('Open the new window', deps(page.browser, judge))
  assert.equal(result.status, 'no_progress')
  assert.match(result.reason, /没有可操作的元素/)
})

test('终态页：**数据录入/提交类目标不享受这条通道**（webform-fine 的 false-done 归因）', async () => {
  const page = terminalPage()
  const judge = fakeJudge([{ action: 'click:0', goalDone: 0.2 }])
  // 提交后页面同样跳到"只剩正文"的终态页、确认 p 也高，但字段可能已被站点脚本清空：
  // 这类目标的成功必须由提交前的读回证明，不能由"跳到了终态页"证明。
  const result = await runTask('Submit the form', deps(page.browser, judge))
  assert.equal(result.status, 'no_progress')
  assert.doesNotMatch(result.trace.join('\n'), /终态/) 
})

test('搜索目标：填完搜索框后按 Enter 提交搜索（不让判断层点建议里的陷阱链接）', async () => {
  const items = [
    { index: 0, role: 'searchbox', name: 'Search Wikipedia', covered: false },
    { index: 1, role: 'a', name: 'Alan Turing: The Enigma Biography', covered: false },
    { index: 2, role: 'a', name: 'Search for pages containing Alan Turing', covered: false },
  ]
  const browser = extractPage(items)
  // 判断层两次都点了"名字里有目标词"的陷阱链接（真机 wiki-search 的实测行为）。
  const judge = fakeJudge([{ action: 'input:0', goalDone: 0.1 }, { action: 'click:1', goalDone: 0.95 }])
  const result = await runTask('Search for the article and open it', deps(browser, judge, { inputs: { query: 'Alan Turing' } }))
  assert.ok(
    (browser.acts ?? []).some((line) => line.startsWith('press body') && /enter/i.test(line)),
    `应该按 Enter 提交搜索，实际动作：${(browser.acts ?? []).join(' | ')}`,
  )
  assert.ok(result.trace.some((line) => /按 Enter 提交搜索/.test(line)))
})

test('弹层关闭：点过 Close 之后该控件从候选里消失 → needs_verification（不再 budget）', async () => {
  const state = { closed: false }
  const browser = {
    async extract() {
      const items = state.closed
        ? [{ index: 0, role: 'a', name: 'click here', covered: false }]
        : [{ index: 1, role: 'p', name: 'Close', covered: false }]
      return { items, text: 'ad page', title: 'Entry Ad', url: 'https://a.test/entry_ad' }
    },
    async snapshot() {
      return {
        origin: 'https://a.test/entry_ad',
        digest: state.closed ? 'closed' : 'open',
        snapshot: state.closed ? 'link "click here"' : 'p "Close"',
        refs: {},
      }
    },
    async read() { return 'ad page' },
    async get() { return 'Entry Ad' },
    async act() { state.closed = true },
    async jsClick() { state.closed = true },
    async run() {},
  }
  const judge = fakeJudge([{ action: 'click:1', goalDone: 0.1 }])
  const result = await runTask('Close the advertisement modal', deps(browser, judge))
  assert.equal(result.status, 'needs_verification')
  assert.ok(result.trace.some((line) => /弹层已关/.test(line)), result.trace.join('\n'))
})

test('低成本交回上游 LLM：次优候选概率低于 0.25 时拒绝盲点（防 p=0.06 跳走），附带含 ref 的 candidates 与 pageText', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'button', name: '无效按钮' },
    { ref: 'e2', role: 'link', name: '外部首页链接', onClick: (state) => { state.origin = 'https://wrong.example/' } },
  ])
  const judge = fakeJudge([
    { action: 'click:e1', probabilities: { 'click:e1': 0.94, 'click:e2': 0.06 }, confirmProbability: 0.1 },
    { action: 'click:e1', probabilities: { 'click:e1': 0.94, 'click:e2': 0.06 }, confirmProbability: 0.1 },
  ])
  const result = await runTask('完成某操作', deps(page.browser, judge))
  assert.equal(result.status, 'no_progress')
  assert.equal(page.state.origin, 'https://example.test/', '绝不能去点 p=0.06 的次优外链把页面跳走')
  assert.ok(Array.isArray(result.candidates) && result.candidates.length > 0, '交回上游 LLM 时应携带现场 candidates')
  assert.equal(result.candidates[0]?.ref, '@e1', '交回的 candidate 应包含可直接给 browser_act 用的 ref')
  assert.ok(typeof result.pageText === 'string' && result.pageText.length > 0, '交回上游 LLM 时应携带 pageText')
})

test('input[role=combobox]（如 GitHub Search issues）走 fill 而非 select，且打完字未按 Enter 前不假完成', async () => {
  const state = { filled: false, submitted: false }
  const browser = {
    acts: [],
    async extract() {
      const items = [
        {
          index: 0,
          role: 'combobox',
          name: 'Search issues',
          covered: false,
          state: state.filled ? '已有内容: flaky screenshot' : '已有内容: is:issue state:open',
        },
        { index: 1, role: 'option', name: 'Suggestion 1', covered: false },
      ]
      return {
        items,
        text: state.submitted ? 'Results for flaky screenshot'.repeat(3) : 'Issues list'.repeat(5),
        title: 'Issues',
        url: state.submitted ? 'https://github.com/a/b/issues?q=flaky+screenshot' : 'https://github.com/a/b/issues',
      }
    },
    async snapshot() { throw new Error('不该退回整树') },
    async read() { return 'Issues list'.repeat(5) },
    async get() { return 'Issues' },
    async act(action, target, payload) {
      this.acts.push(`${action} ${target} ${JSON.stringify(payload ?? {})}`)
      if (action === 'fill') state.filled = true
      if (action === 'press' && payload?.value === 'Enter') state.submitted = true
    },
    async run() {},
  }
  // 第 2 步故意给 goal_done=0.82（中间带）：修复前会因自动补全下拉导致 lastChange.added 而在按 Enter 前触发 likely_done 假完成
  const judge = fakeJudge([
    { action: 'input:0', goalDone: 0.2 },
    { action: 'click:1', goalDone: 0.82 },
    { action: 'click:1', goalDone: 0.95 },
  ])
  const result = await runTask("Search this repository's issues for the given words", deps(browser, judge, {
    inputs: { query: 'flaky screenshot' },
  }))
  assert.ok(browser.acts.some((a) => a.startsWith('fill ')), `应对 input[role=combobox] 执行 fill 而非 select：${browser.acts.join(' | ')}`)
  assert.ok(browser.acts.some((a) => a.startsWith('press body') && /Enter/.test(a)), `应按 Enter 提交搜索：${browser.acts.join(' | ')}`)
  assert.equal(state.submitted, true, '必须真正提交搜索后才结束')
  assert.equal(result.status, 'needs_verification')
})

test('按 Enter 提交后输入框变空（TodoMVC 模式）视为已消费，不再反复重填，且 confirm 不问 control 的 target_match', async () => {
  const state = { val: '', todos: [] }
  const browser = {
    acts: [],
    async extract() {
      const items = [
        {
          index: 0,
          role: 'textbox',
          name: 'What needs to be done?',
          covered: false,
          state: state.val === '' ? '' : `已有内容: ${state.val}`,
        },
        { index: 99, role: 'a', name: 'TodoMVC', covered: false },
        ...state.todos.map((t, idx) => ({ index: idx + 1, role: 'checkbox', name: t, covered: false, state: '未勾选' })),
      ]
      return {
        items,
        text: `todos: ${state.todos.join(', ')}`.padEnd(50, ' '),
        title: 'TodoMVC',
        url: 'https://demo.playwright.dev/todomvc/#/',
      }
    },
    async snapshot() { throw new Error('不该退回整树') },
    async read() { return `todos: ${state.todos.join(', ')}`.padEnd(50, ' ') },
    async get() { return 'TodoMVC' },
    async act(action, target, payload) {
      this.acts.push(`${action} ${target}`)
      if (action === 'fill') state.val = payload.value
      if (action === 'press' && payload?.value === 'Enter' && state.val !== '') {
        state.todos.push(state.val)
        state.val = ''
      }
    },
    async run() {},
  }
  const judge = fakeJudge([
    { action: 'input:0', goalDone: 0.1 },
    { action: 'control:press_enter', goalDone: 0.7 },
    { action: 'control:wait', goalDone: 0.92, confirmProbability: 0.9 },
  ])
  const result = await runTask("Add a new todo item that says 'buy milk'", deps(browser, judge, {
    inputs: { todo: 'buy milk' },
  }))
  assert.equal(result.status, 'needs_verification')
  assert.deepEqual(state.todos, ['buy milk'], '只应添加一次 buy milk，不能在清空后重填第二次')
  assert.equal(browser.acts.filter((a) => a.startsWith('fill ')).length, 1, 'fill 只应执行 1 次')
})

test('多字段表单单步批量填充：同一页的多个匹配字段在 1 个 step / 1 次 Jev 调用内一次性填完', async () => {
  const state = { first: '', last: '', zip: '', submitted: false }
  const browser = {
    acts: [],
    async extract() {
      return {
        items: [
          { index: 0, role: 'textbox', name: 'First Name', covered: false, state: state.first ? `已有内容: ${state.first}` : '' },
          { index: 1, role: 'textbox', name: 'Last Name', covered: false, state: state.last ? `已有内容: ${state.last}` : '' },
          { index: 2, role: 'textbox', name: 'Postal Code', covered: false, state: state.zip ? `已有内容: ${state.zip}` : '' },
          { index: 3, role: 'button', name: 'Continue', covered: false, state: '' },
        ],
        text: (state.submitted ? 'Checkout: Overview' : 'Checkout: Your Information').padEnd(50, ' '),
        title: 'Swag Labs',
        url: state.submitted ? 'https://www.saucedemo.com/checkout-step-two.html' : 'https://www.saucedemo.com/checkout-step-one.html',
      }
    },
    async snapshot() { throw new Error('不该退回整树') },
    async read() { return 'Checkout'.padEnd(50, ' ') },
    async get() { return 'Swag Labs' },
    async act(action, target, payload) {
      this.acts.push(`${action} ${target} ${payload?.value ?? ''}`.trim())
      if (action === 'fill' && target === '[data-dsh-idx="0"]') state.first = payload.value
      if (action === 'fill' && target === '[data-dsh-idx="1"]') state.last = payload.value
      if (action === 'fill' && target === '[data-dsh-idx="2"]') state.zip = payload.value
      if (action === 'click' && target === '[data-dsh-idx="3"]') state.submitted = true
    },
    async run() {},
  }
  const judge = fakeJudge([
    { action: 'input:0', goalDone: 0.1 },
    { action: 'click:3', goalDone: 0.2 },
  ])
  const result = await runTask('Fill in the checkout information and continue', deps(browser, judge, {
    inputs: { first_name: 'Ada', last_name: 'Lovelace', postal_code: '10001' },
  }))
  assert.equal(result.status, 'needs_verification')
  assert.equal(state.first, 'Ada')
  assert.equal(state.last, 'Lovelace')
  assert.equal(state.zip, '10001')
  assert.equal(state.submitted, true)
  assert.equal(judge.asked.length, 2, `3 个字段批填 + 点 Continue 只需 2 次 Jev 调用（省掉 2 次），实际：${judge.asked.length}`)
})

test('已禁用的输入框（已禁用）不抢先填值：先点 Enable 解禁再填（ti-dynamic-controls 模式）', async () => {
  const state = { enabled: false, val: '' }
  const browser = {
    acts: [],
    async extract() {
      return {
        items: [
          {
            index: 0,
            role: 'textbox',
            name: 'Text input',
            covered: false,
            state: !state.enabled ? '已禁用' : state.val ? `已有内容: ${state.val}` : '',
          },
          { index: 1, role: 'button', name: state.enabled ? 'Disable' : 'Enable', covered: false, state: '' },
        ],
        text: (state.enabled ? "It's enabled!" : 'Enable the input').padEnd(50, ' '),
        title: 'Dynamic Controls',
        url: 'https://the-internet.herokuapp.com/dynamic_controls',
      }
    },
    async snapshot() { throw new Error('不该退回整树') },
    async read() { return 'Dynamic Controls'.padEnd(50, ' ') },
    async get() { return 'Dynamic Controls' },
    async act(action, target, payload) {
      this.acts.push(`${action} ${target}`)
      if (action === 'fill' && !state.enabled) throw new Error('Element is disabled')
      if (action === 'fill') state.val = payload.value
      if (action === 'click' && target === '[data-dsh-idx="1"]') state.enabled = true
    },
    async run() {},
  }
  const judge = fakeJudge([
    { action: 'click:1', goalDone: 0.1 },
    { action: 'input:0', goalDone: 0.2 },
    { action: 'control:wait', goalDone: 0.95 },
  ])
  const result = await runTask('Enable the text field, then type into it', deps(browser, judge, {
    inputs: { text: 'hello' },
  }))
  assert.equal(result.status, 'needs_verification')
  assert.deepEqual(
    browser.acts.filter((a) => !a.startsWith('scrollintoview')),
    ['click [data-dsh-idx="1"]', 'fill [data-dsh-idx="0"]'],
    '必须先点 Enable 再填值',
  )
  assert.equal(state.val, 'hello')
})

test('Completed 筛选只有路由和可见复选框状态一致时才确定性收尾', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'a', name: 'Completed', inMain: true, onClick: (state) => { state.origin = 'https://todo.test/#/completed' } },
    { ref: 'e2', role: 'checkbox', name: 'buy milk', state: '已勾选', inMain: true },
  ], { withExtract: true })
  const judge = fakeJudge([{ action: 'click:0', goalDone: 0.1 }])
  const result = await runTask('Show only the completed todos', deps(page.browser, judge))
  const actionOptions = judge.asked[0]?.questions.action.options ?? {}
  assert.ok(actionOptions['click:0'], 'Completed 筛选项应保留')
  assert.equal(actionOptions['click:1'], undefined, '不应把已完成的 todo 条目 checkbox 当成筛选动作')
  assert.equal(result.status, 'needs_verification')
  assert.equal(result.steps.at(-1)?.reason, 'filter_state_verified')
  assert.match(result.reason, /筛选路由与可见条目状态/)
})

test('Completed 路由没有可见匹配条目时停止重试且不声称完成', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'a', name: 'Completed', inMain: true, onClick: (state) => { state.origin = 'https://todo.test/#/completed' } },
  ], { withExtract: true })
  const judge = fakeJudge([{ action: 'click:0', goalDone: 0.99 }])
  const result = await runTask('Show only the completed todos', deps(page.browser, judge))
  assert.equal(result.status, 'no_progress')
  assert.equal(result.steps.at(-1)?.reason, 'filter_state_unverified')
  assert.equal(judge.asked.length, 1, '筛选路由已到达后不应重复点击筛选项')
})

test('明确要求向禁用字段输入、且没有启用入口时首轮直接 blocked', async () => {
  const page = fakePage([
    { ref: 'e1', role: 'textbox', name: 'My disabled input', state: '已禁用' },
  ], { withExtract: true })
  const judge = fakeJudge([{ action: 'click:e1', goalDone: 0.99 }])
  const result = await runTask('Type into the disabled input field', deps(page.browser, judge, {
    inputs: { text: 'x' },
  }))
  assert.equal(result.status, 'blocked')
  assert.equal(judge.asked.length, 0, '存在确定性阻塞时不应浪费一次 Jev 调用')
  assert.equal(result.steps[0]?.reason, 'disabled_target_no_unlock')
})
