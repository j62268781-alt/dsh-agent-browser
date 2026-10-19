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
      // 对话框探测是基础设施（每步一次），不算"动作"，也不让断言数组被它污染。
      if (argv[0] === 'dialog') return '✓ No dialog is currently open'
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

test('P2：唯一可操作元素是输入框 → 免判断直接交回宿主', async () => {
  const page = fakePage([{ ref: 'e1', role: 'textbox', name: '搜索' }])
  const judge = fakeJudge([])
  const result = await runTask('目标', deps(page.browser, judge))
  assert.equal(judge.asked.length, 0, '唯一的输入框不必问判断层')
  assert.equal(result.status, 'input_required')
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
  const asked = judge.asked[0].questions.action.options
  assert.ok(Object.keys(asked).length <= 10, `判断层选项 ${Object.keys(asked).length} 个，超过上限`)
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
