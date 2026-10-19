/**
 * 纯逻辑测试：动作映射、候选枚举、问题批次、页面侧的输入校验。
 * 这些都是"决定了就不会再变"的映射关系，值得被钉住。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionArgs, isSupportedVersion, nativeBinaryName, nativeSiblingPath, resolveCommand } from '../lib/cli.js'
import { FOLLOW_UP_VERBS, MAX_CLICK_CANDIDATES, candidatesFromExtracted, candidatesOf, diffCandidates, inputsApplied, isAlreadySatisfied, pendingFieldOf, questionsOf, soleValueFor, stateOf } from '../lib/task.js'
import { parseExtracted, stripBoundaries } from '../lib/extract.js'
import { parseSkillFile, pluginNote } from '../lib/skill.js'
import { parseDomains } from '../client/config.js'

test('动作 → CLI 参数：每个动作都拼对，缺参数就地拒绝', () => {
  assert.deepEqual(actionArgs('click', '@e2'), ['click', '@e2'])
  assert.deepEqual(actionArgs('fill', '@e3', { value: 'hello' }), ['fill', '@e3', 'hello'])
  assert.deepEqual(actionArgs('type', '#q', { value: 'x' }), ['type', '#q', 'x'])
  assert.deepEqual(actionArgs('select', '@e4', { values: ['a', 'b'] }), ['select', '@e4', 'a', 'b'])
  assert.deepEqual(actionArgs('upload', '@e5', { values: ['/tmp/a.png'] }), ['upload', '@e5', '/tmp/a.png'])
  assert.deepEqual(actionArgs('press', 'body', { value: 'Enter' }), ['press', 'Enter'])
  assert.deepEqual(actionArgs('scroll', 'body', { direction: 'down', amount: 800 }), ['scroll', 'down', '800'])
  // 无元素目标的动作：真机踩过——`wait` 的毫秒数曾经只能硬塞进 ref。
  assert.deepEqual(actionArgs('wait', '', { value: '800' }), ['wait', '800'])
  assert.deepEqual(actionArgs('press', '', { value: 'Escape' }), ['press', 'Escape'])
  assert.deepEqual(actionArgs('scroll', '', { direction: 'up' }), ['scroll', 'up'])
  assert.throws(() => actionArgs('wait', ''), /需要 value/)
  assert.throws(() => actionArgs('fill', '@e3', {}), /需要 value/)
  assert.throws(() => actionArgs('press', 'body', {}), /需要 value/)
  assert.throws(() => actionArgs('select', '@e4', {}), /至少一个 value/)
  assert.throws(() => actionArgs('teleport', '@e1'), /不支持的动作/)
})

const snapshot = {
  origin: 'https://example.com/',
  snapshot: '- button "Alpha" [ref=e1]\n- textbox "Search" [ref=e2]\n- link "" [ref=e3]',
  refs: {
    e1: { name: 'Alpha', role: 'button' },
    e2: { name: 'Search', role: 'textbox' },
    e3: { name: '', role: 'link' },
    e4: { name: 'Save', role: 'button' },
  },
  removedRefs: [],
  digest: 'abc123',
}

test('候选枚举：确定性、无名元素保留（真实站点常见）、文本字段单独标注 input', () => {
  const candidates = candidatesOf(snapshot)
  const ids = candidates.map((candidate) => candidate.id)
  assert.deepEqual(ids, [
    'click:e1', 'click:e3', 'click:e4',  // 可点角色，按快照顺序（e3 无名也要保留）
    'input:e2',                          // textbox → input（循环里交回宿主）
    'control:scroll_down', 'control:scroll_up', 'control:back', 'control:wait',
  ])
  // 无名元素用"无名称的角色 + ref"兜底描述，不猜语义
  const unnamed = candidates.find((candidate) => candidate.id === 'click:e3')
  assert.match(unnamed.description, /无名称/)
})

test('候选封顶在协议的 255 之下（给控制项留位置）', () => {
  const refs = {}
  for (let index = 0; index < 400; index += 1) refs[`e${index}`] = { name: `B${index}`, role: 'button' }
  const candidates = candidatesOf({ ...snapshot, refs })
  const clicks = candidates.filter((candidate) => candidate.kind === 'click')
  assert.equal(clicks.length, MAX_CLICK_CANDIDATES)
})

test('问题批次：一个 choice + 四个 noul（完成/卡住/不可逆/页面错误），候选键集合就是候选集合', () => {
  const candidates = candidatesOf(snapshot)
  const questions = questionsOf('在 example.com 找到 Alpha', candidates)
  assert.deepEqual(Object.keys(questions).sort(), ['action', 'goal_done', 'irreversible', 'page_error', 'stuck'])
  assert.equal(questions.action.kind, 'choice')
  for (const key of ['goal_done', 'stuck', 'irreversible', 'page_error']) assert.equal(questions[key].kind, 'noul')
  assert.deepEqual(Object.keys(questions.action.options).sort(), candidates.map((c) => c.id).sort())
  // 目标与不可信数据的纪律要写进 prompt，不能靠调用方自觉。
  assert.match(String(questions.action.prompt), /不可信数据/)
  assert.match(String(questions.goal_done.prompt), /在 example\.com 找到 Alpha/)
})

test('页面侧域名解析：接受 *. 形式、逗号与换行都算分隔，挑出不合法的', () => {
  assert.deepEqual(parseDomains('a.com, *.b.com'), { domains: ['a.com', '*.b.com'], invalid: [] })
  // 多行 textarea：一行一个、空行忽略、两种分隔符可以混用
  assert.deepEqual(parseDomains('a.com\n*.b.com\n\n c.com , d.com '), { domains: ['a.com', '*.b.com', 'c.com', 'd.com'], invalid: [] })
  assert.deepEqual(parseDomains('  '), { domains: [], invalid: [] })
  const bad = parseDomains('a.com, ht!tp://x')
  assert.equal(bad.domains.length, 2)
  assert.deepEqual(bad.invalid, ['ht!tp://x'])
})

test('原生二进制的同目录规则：按 platform-arch 命名，覆盖 npm 全局与 Homebrew 布局', () => {
  assert.equal(
    nativeSiblingPath('/opt/homebrew/lib/node_modules/agent-browser/bin/agent-browser.js', 'darwin', 'arm64'),
    '/opt/homebrew/lib/node_modules/agent-browser/bin/agent-browser-darwin-arm64',
  )
  assert.equal(
    nativeSiblingPath('/usr/local/lib/node_modules/agent-browser/bin/agent-browser.js', 'linux', 'x64'),
    '/usr/local/lib/node_modules/agent-browser/bin/agent-browser-linux-x64',
  )
  // win32 要带 .exe；win32+arm64 在原生缺失时退 x64（与 CLI 包装层的 getBinaryName 一致）。
  assert.equal(nativeBinaryName('/tmp/x', 'win32', 'x64'), 'agent-browser-win32-x64.exe')
  assert.equal(nativeBinaryName('/tmp/definitely-missing-dir', 'win32', 'arm64'), 'agent-browser-win32-x64.exe')
  // 不支持的平台/架构：返回 undefined，调用方诚实退回包装层。
  assert.equal(nativeBinaryName('/tmp/x', 'freebsd', 'x64'), undefined)
  assert.equal(nativeBinaryName('/tmp/x', 'darwin', 'ia32'), undefined)
})

test('版本区间判断与 --version 输出解耦（越界即拒）', () => {
  assert.equal(isSupportedVersion('0.38.0'), true)
  assert.equal(isSupportedVersion('0.38.2'), true)
  assert.equal(isSupportedVersion('0.39.0'), false)
  assert.equal(isSupportedVersion('0.37.9'), false)
  assert.equal(isSupportedVersion('garbage'), false)
})

test('显式配置的命令原样使用（自动跳过包装层只发生在没配置时）', () => {
  const resolved = resolveCommand('/custom/bin/agent-browser')
  assert.equal(resolved.kind, 'configured')
  assert.equal(resolved.command, '/custom/bin/agent-browser')
})

test('SKILL.md frontmatter 解析：只认单行 key: value，缺了就不猜', () => {
  const { fields, body } = parseSkillFile('---\nname: demo\ndescription: 一句话：带冒号也行\n---\n\n# 正文\n')
  assert.equal(fields.name, 'demo')
  assert.equal(fields.description, '一句话：带冒号也行')
  assert.equal(body.trim(), '# 正文')
  assert.throws(() => parseSkillFile('# 没有 frontmatter\n'), /frontmatter/)
})

test('插件补充会随工具/决策开关变化（工具关掉就说"用 bash 调 CLI"）', () => {
  const on = pluginNote({ tools: true, decision: true })
  assert.match(on, /browser_snapshot/)
  assert.match(on, /browser_run\(goal\)/)
  assert.match(on, /references\/commands\.md/)

  const off = pluginNote({ tools: false, decision: false })
  assert.match(off, /工具面当前\*\*关闭\*\*/)
  assert.ok(!off.includes('browser_snapshot'))
})

/* ───────────────── 页面内抽取（P8） ───────────────── */

test('抽取结果解析：eval 返回值再解一层，且带正文/标题/URL', () => {
  const payload = JSON.stringify({
    items: [[0, 'a', '七日天气', 0], [1, 'textbox', '', 0], [2, 'button', '被挡住的按钮', 1]],
    text: '页面正文',
    title: '标题',
    url: 'https://example.test/',
  })
  const page = parseExtracted(JSON.stringify(payload))
  assert.equal(page.items.length, 3)
  assert.deepEqual(page.items[0], { index: 0, role: 'a', name: '七日天气', covered: false, state: '' })
  assert.equal(page.items[2].covered, true)
  assert.equal(page.text, '页面正文')
  assert.equal(page.title, '标题')
  assert.equal(page.url, 'https://example.test/')
})

test('抽取候选：跳过被遮挡的、输入框单独标注、动作用 data 属性句柄', () => {
  const page = parseExtracted(JSON.stringify(JSON.stringify({
    items: [[3, 'a', '新闻', 0], [4, 'button', '挡住', 1], [5, 'textbox', '搜索', 0]],
    text: '', title: '', url: '',
  })))
  const candidates = candidatesFromExtracted(page.items, '搜索新闻')
  const ids = candidates.map((candidate) => candidate.id)
  assert.deepEqual(ids.sort(), ['click:3', 'input:5'])
  const click = candidates.find((candidate) => candidate.id === 'click:3')
  assert.equal(click.ref, '[data-dsh-idx="3"]')
  const input = candidates.find((candidate) => candidate.id === 'input:5')
  assert.equal(input.kind, 'input')
  assert.match(input.description, /搜索/)
})

test('抽取脚本不依赖容易被打字机吃掉的正则转义（真机：把所有 s 换成了空格）', async () => {
  const { EXTRACT_SCRIPT } = await import('../lib/extract.js')
  assert.ok(!/replace\(\/s\+/.test(EXTRACT_SCRIPT), '不能出现被吃成 /s+/ 的正则')
  assert.ok(!EXTRACT_SCRIPT.includes(String.fromCharCode(96)), '脚本里不能有反引号（它本身是模板内容）')
  assert.match(EXTRACT_SCRIPT, /split\(String\.fromCharCode\(10\)\)/, '空白归一化要用 split/join')
})

test('判断层选项上限是 10（实测：10 最准也最便宜；16/40 会选错或分布不合法）', async () => {
  const { JUDGE_OPTION_CAP } = await import('../lib/task.js')
  assert.equal(JUDGE_OPTION_CAP, 10)
})

test('内容边界剥离：origin 里带连字符（file:///…/dsh-agent-browser/…）也要剥掉', () => {
  const wrapped = [
    '--- AGENT_BROWSER_PAGE_CONTENT nonce=9863c5a143737799674ea380b1af5a2a origin=file:///Users/x/dsh-agent-browser/bench/fixtures/login.html ---',
    '"{\\"title\\":\\"Login Page\\"}"',
    '--- END_AGENT_BROWSER_PAGE_CONTENT nonce=9863c5a143737799674ea380b1af5a2a ---',
  ].join('\n')
  assert.equal(stripBoundaries(wrapped), '"{\\"title\\":\\"Login Page\\"}"')
})

test('密码框：值不出页面，只报“已填写”，且不会被当成“没填”反复重填', () => {
  const page = parseExtracted(JSON.stringify({
    items: [[0, 'textbox', 'Password', 0, '已有内容: ●●●'], [1, 'textbox', 'Username', 0, '已有内容: tomsmith']],
    text: '', title: '', url: '',
  }))
  const [password, username] = candidatesFromExtracted(page.items, 'log in')
  assert.deepEqual(stateOf(password), { redacted: true })
  assert.equal(stateOf(username).value, 'tomsmith')
  assert.equal(isAlreadySatisfied(password, 'type the password', { password: 's3cret' }), true)
  assert.equal(pendingFieldOf([password], { password: 's3cret' }), undefined)
  // 没给值时不能凭空"已满足"（避免把密码框当成无需操作）。
  assert.equal(isAlreadySatisfied(password, 'type the password'), false)
})

test('抽取状态里绝不出现密码原文', async () => {
  const { EXTRACT_SCRIPT } = await import('../lib/extract.js')
  assert.match(EXTRACT_SCRIPT, /type === 'password' \? '已有内容: ●●●'/)
})

test('填充类收尾：调用方给的值都已生效才算完成', () => {
  const page = parseExtracted(JSON.stringify({
    items: [[0, 'textbox', 'Destination', 0, '已有内容: Lisbon']], text: '', title: '', url: '',
  }))
  const candidates = candidatesFromExtracted(page.items, 'type Lisbon into Destination')
  assert.equal(inputsApplied(candidates, { Destination: 'Lisbon' }), true)
  assert.equal(inputsApplied(candidates, { Destination: 'Porto' }), false)
  assert.equal(inputsApplied(candidates, {}), false)
  assert.equal(inputsApplied(candidates, undefined), false)
  // 本轮刚填过、但页面状态还没刷新（filled 记账）也算生效。
  assert.equal(inputsApplied(candidates, { Destination: 'Porto' }, new Map([[candidates[0].id, 'Porto']])), true)
})

test('填完值之后还要提交/搜索/添加的目标不走确定性收尾', () => {
  assert.equal(FOLLOW_UP_VERBS.test('Log in'), true)
  assert.equal(FOLLOW_UP_VERBS.test('Fill in the fields with the given values, then submit the form'), true)
  assert.equal(FOLLOW_UP_VERBS.test("Add a new todo item that says 'buy milk'"), true)
  assert.equal(FOLLOW_UP_VERBS.test('Search for the article and open it'), true)
  assert.equal(FOLLOW_UP_VERBS.test('type Lisbon into the Destination field'), false)
  assert.equal(FOLLOW_UP_VERBS.test('choose Business in the Cabin dropdown'), false)
})

test('唯一输入框 + 唯一值：名字对不上也能确定性绑定', () => {
  const page = parseExtracted(JSON.stringify({
    items: [[0, 'textbox', '', 0, ''], [1, 'button', 'Submit', 0, '']], text: '', title: '', url: '',
  }))
  const candidates = candidatesFromExtracted(page.items, 'Enter the number 42')
  assert.equal(soleValueFor(candidates, { number: '42' }), '42')
  // 页面上有两个输入框时不猜。
  const two = candidatesFromExtracted(parseExtracted(JSON.stringify({
    items: [[0, 'textbox', '', 0, ''], [1, 'textbox', 'Password', 0, ''], [2, 'button', 'Submit', 0, '']], text: '', title: '', url: '',
  })).items, 'log in')
  assert.equal(soleValueFor(two, { username: 'a' }), undefined)
  // 两个值也不猜。
  assert.equal(soleValueFor(candidates, { a: '1', b: '2' }), undefined)
})

test('last_change：只报语义变化（控件增删 / 状态变化 / 正文 / URL）', () => {
  const candidate = (name, role, state) => ({ id: name, description: name, kind: 'click', role, name, state })
  const button = (name) => candidate(name, 'button', '')
  // 无变化 → 不产生 diff（避免给判断层塞噪声）
  assert.equal(diffCandidates([button('A')], [button('A')], 't', 't', 'u', 'u'), undefined)
  // 勾选框状态变化
  const changed = diffCandidates(
    [candidate('Free cancellation', 'checkbox', '未勾选')],
    [candidate('Free cancellation', 'checkbox', '已勾选')],
    't', 't', 'u', 'u',
  )
  assert.equal(changed.changed.length, 1)
  assert.match(changed.changed[0], /未勾选 → 已勾选/)
  // 新增 / 移除 / 正文 / URL
  const mixed = diffCandidates([button('A')], [button('B')], 'old text', 'new text', 'u1', 'u2')
  assert.deepEqual(mixed.added, ['B'])
  assert.deepEqual(mixed.removed, ['A'])
  assert.equal(mixed.text_changed, true)
  assert.equal(mixed.url_changed, true)
})

test('done_change 只在有 last_change 时才问（不增加无谓开销）', () => {
  const candidates = [{ id: 'click:1', description: '点击 A', kind: 'click', role: 'button', name: 'A' }]
  const withDiff = questionsOf('做点什么', candidates, undefined, { hasLastChange: true })
  const without = questionsOf('做点什么', candidates)
  assert.equal(withDiff.done_change?.kind, 'noul')
  assert.equal(without.done_change, undefined)
})

test('抽取上限截断会回传 truncated', () => {
  const page = parseExtracted(JSON.stringify({ items: [[0, 'button', 'A', 0]], text: '', title: '', url: '', truncated: true }))
  assert.equal(page.truncated, true)
  assert.equal(parseExtracted(JSON.stringify({ items: [], text: '', title: '', url: '' })).truncated, false)
})
