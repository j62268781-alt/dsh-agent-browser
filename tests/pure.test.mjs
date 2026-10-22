/**
 * 纯逻辑测试：动作映射、候选枚举、问题批次、页面侧的输入校验。
 * 这些都是"决定了就不会再变"的映射关系，值得被钉住。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionArgs, isSupportedVersion, nativeBinaryName, nativeSiblingPath, resolveCommand } from '../lib/cli.js'
import { FOLLOW_UP_VERBS, MAX_CLICK_CANDIDATES, SELECT_OPTION_CAP, addToCartTarget, bestEmptyInputForGoal, candidatesFromExtracted, candidatesOf, diffCandidates, disabledTargetWithoutUnlock, fieldName, filterStateMatchesGoal, goalMentions, groupOutlineOf, inputMatchesOf, inputsApplied, isAlreadySatisfied, isTargetToggleCandidate, matchInputValue, pendingFieldOf, questionsOf, rankByGoal, requiresPrimaryContentTarget, scopeCandidatesOf, selectOptionQuestion, soleValueFor, specificallyNamed, stateOf, urlChangeMatchesGoal } from '../lib/task.js'
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
    'control:scroll_down', 'control:scroll_up', 'control:back', 'control:wait', 'control:press_enter',
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
  assert.deepEqual(Object.keys(questions).sort(), ['action', 'goal_done', 'irreversible', 'login', 'page_error', 'stuck'])
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

test('版本判断只锁下限：低于 0.38.2 拒绝，更新版本一律放行', () => {
  assert.equal(isSupportedVersion('0.38.2'), true)
  assert.equal(isSupportedVersion('0.38.9'), true)
  // 关键回归：0.39.x 曾被写死的上限判成「环境失败」。
  assert.equal(isSupportedVersion('0.39.0'), true)
  assert.equal(isSupportedVersion('0.39.1'), true)
  assert.equal(isSupportedVersion('0.40.0'), true)
  assert.equal(isSupportedVersion('1.0.0'), true)
  assert.equal(isSupportedVersion('0.38.1'), false)
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
  assert.match(on, /browser_run\(goal, inputs\?, subgoals\?\)/)
  assert.match(on, /只有 `needs_verification` 才推进/)
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

test('通用值 key 不得把"已有别的值"的字段判成 pending（否则反复覆写）', () => {
  const page = parseExtracted(JSON.stringify({
    items: [
      [0, 'textbox', 'Text input', 0, '已有内容: pw123'],
      [1, 'textbox', 'Textarea', 0, '已有内容: hello world'],
      [2, 'textbox', 'Date picker', 0, '已有内容: 09/16/2026'],
    ],
    text: '', title: '', url: '',
  }))
  const candidates = candidatesFromExtracted(page.items, 'type the date into the date picker field')
  // `{text: …}` 会宽松命中 Text input / Textarea —— 但它们已有别的值，不构成"还没生效"。
  // 真机 bench（webform-fine）：这条不成立时会一路覆写 + 烧到 budget，最后提交错数据。
  assert.equal(pendingFieldOf(candidates, { text: '09/16/2026' }), undefined)
  // 具体的字段名仍然允许覆盖旧值。
  assert.equal(pendingFieldOf(candidates, { 'Text input': 'Jev' })?.name, 'Text input')
  // 空字段 + 目标点名了它 → 仍然算 pending（"先填上"的路径不变）。
  const empty = candidatesFromExtracted(parseExtracted(JSON.stringify({
    items: [[0, 'textbox', 'Text input', 0, '']], text: '', title: '', url: '',
  })).items, 'fill the text input')
  assert.equal(pendingFieldOf(empty, { text: 'Jev' }, 'fill the text input')?.name, 'Text input')
  // 没给 goal 时通用 key 不再把空字段当 pending（宁可少拦，也不要反复填）。
  assert.equal(pendingFieldOf(empty, { text: 'Jev' }), undefined)
})

test('导航完成证据：只认地址新增段里命中的目标词', () => {
  // 起始页本来就有的词不算（wikipedia 的 /wiki/ 是起始页的一部分）。
  assert.equal(
    urlChangeMatchesGoal('open the linked article about Bletchley Park', 'https://en.wikipedia.org/wiki/Alan_Turing', 'https://en.wikipedia.org/wiki/Alan_Turing'),
    undefined,
  )
  assert.equal(
    urlChangeMatchesGoal('open the linked article about Bletchley Park', 'https://en.wikipedia.org/wiki/Alan_Turing', 'https://en.wikipedia.org/wiki/Bletchley_Park'),
    'bletchley',
  )
  // hash-only 导航（本地 fixture）：新增段的 `#casa-flora` 命中目标词。
  assert.equal(
    urlChangeMatchesGoal('open the Casa Flora stay', 'file:///x/fixture.html', 'file:///x/fixture.html#casa-flora'),
    'casa',
  )
  // 新增段里没有目标词 → 不给证据（不能因为"地址变了"就宣告完成）。
  assert.equal(urlChangeMatchesGoal('open the secure area', 'https://ti.example/login', 'https://ti.example/random'), undefined)
})

test('地址证据只给导航目标：状态操作的域名/路由词不算完成（todomvc 假完成归因）', () => {
  const start = 'https://demo.playwright.dev/todomvc/'
  // 目标里的 `todo` 同时是域名与 hash 路由的一部分 —— 状态操作不得据此收尾。
  assert.equal(urlChangeMatchesGoal("Mark the 'buy milk' todo as completed", start, `${start}#/todo`), undefined)
  assert.equal(urlChangeMatchesGoal("Mark the 'buy milk' todo as completed", start, `${start}#/completed`), undefined)
  // 过滤目标：`#/completed` 只是筛选器状态，不能替代"结果区只剩 1 条"的验证。
  assert.equal(urlChangeMatchesGoal('Show only the completed todos', start, `${start}#/completed`), undefined)
  assert.equal(urlChangeMatchesGoal('Clear all completed todos', start, `${start}#/completed`), undefined)
  assert.equal(urlChangeMatchesGoal('Select the second radio button', 'https://a.test/form', 'https://a.test/form#radio-2'), undefined)
  // **跨 origin 不拿域名当新增段**：站点名里的词不是"目标页面存在"的证据。
  assert.equal(urlChangeMatchesGoal('Open the todomvc app', 'https://a.test/', 'https://todomvc.com/'), undefined)
  // 跨 origin 的真导航仍按**路径**给证据。
  assert.equal(
    urlChangeMatchesGoal('Open the Poetry category', 'https://books.toscrape.com/', 'https://mirror.test/catalogue/category/books/poetry_23/index.html'),
    'poetry',
  )
  // 真导航目标：新增 path/hash 命中目标词照旧收尾。
  assert.equal(
    urlChangeMatchesGoal(
      'Open the book "Shakespeare\'s Sonnets"',
      'https://books.toscrape.com/catalogue/page-1.html',
      'https://books.toscrape.com/catalogue/shakespeares-sonnets_1/index.html',
    ),
    'shakespeare',
  )
  // 地址解析失败时不给证据（不许退回"整串 URL 子串匹配"）。
  assert.equal(urlChangeMatchesGoal('open the dashboard', 'not a url', 'also not a url !'), undefined)
})

test('字段名与目标词：通用 key 宽松匹配、词边界区分 Textarea / Text input', () => {
  assert.equal(specificallyNamed({ id: 'input:0', description: 'x', kind: 'input', name: 'Text input' }, { text: 'Jev' }), false)
  assert.equal(specificallyNamed({ id: 'input:0', description: 'x', kind: 'input', name: 'Destination' }, { Destination: 'Lisbon' }), true)
  // `text` 是 Text input 的词，但不是 Textarea 的词。
  assert.equal(goalMentions('Text input', 'type into the text input'), true)
  assert.equal(goalMentions('Textarea', 'type into the text input'), false)
  assert.equal(goalMentions('Textarea', 'type into the textarea'), true)
})

test('抽取状态里绝不出现标准敏感字段原文', async () => {
  const { JSDOM } = await import('jsdom')
  const { EXTRACT_SCRIPT } = await import('../lib/extract.js')
  const dom = new JSDOM(
    '<input type="password" aria-label="Secret" value="pw-value">' +
      '<input autocomplete="section-login one-time-code" aria-label="Otp" value="123456">' +
      '<input autocomplete="cc-number" aria-label="Card" value="4111111111111111">' +
      '<input autocomplete="email" aria-label="Email" value="person@example.test">',
    { url: 'https://a.test/secrets', pretendToBeVisual: true },
  )
  const { window } = dom
  window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 24, top: 10, left: 10, right: 110, bottom: 34, x: 10, y: 10, toJSON() {} })
  window.document.elementFromPoint = () => null
  Object.defineProperty(window.Element.prototype, 'innerText', { get() { return this.textContent }, configurable: true })
  const run = new Function('document', 'innerWidth', 'innerHeight', 'getComputedStyle', 'location', `return ${EXTRACT_SCRIPT}`)
  const page = parseExtracted(run(window.document, 1024, 768, window.getComputedStyle.bind(window), window.location))
  const candidates = candidatesFromExtracted(page.items)
  for (const name of ['Secret', 'Otp', 'Card']) {
    const item = page.items.find((candidate) => candidate.name === name)
    assert.equal(item?.state, '已有内容: ●●●', `${name} 应只报告掩码状态`)
  }
  assert.equal(candidates.find((candidate) => candidate.name === 'Otp')?.groupRole, 'otp')
  const email = page.items.find((candidate) => candidate.name === 'Email')
  assert.equal(email?.state, '已有内容: person@example.test')
  assert.ok(!JSON.stringify(page.items).includes('pw-value'))
  assert.ok(!JSON.stringify(page.items).includes('123456'))
  assert.ok(!JSON.stringify(page.items).includes('4111111111111111'))
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

test('抽取解析：select 选项与所在行上下文（near）', () => {
  const page = parseExtracted(JSON.stringify({
    items: [
      [0, 'combobox', 'Cabin', 0, '当前值: economy', [['Economy', 'economy'], ['Business', 'business']], ''],
      [1, 'a', 'comments', 0, '链接: news.ycombinator.com/newcomments', null, ''],
      [2, 'a', '42 comments', 0, '链接: news.ycombinator.com/item', null, '123 points by someone 2 hours ago | 42 comments'],
    ],
    text: '', title: '', url: '',
  }))
  assert.deepEqual(page.items[0].options, [['Economy', 'economy'], ['Business', 'business']])
  assert.equal(page.items[2].near.includes('123 points'), true)
  const candidates = candidatesFromExtracted(page.items, 'open the comments of the top story')
  assert.equal(candidates.find((candidate) => candidate.name === 'Cabin').options?.length, 2)
  // 导航条那条没有 near，故事那条的 near 必须进描述（判断层靠它区分同名链接）。
  const story = candidates.find((candidate) => candidate.name === '42 comments')
  assert.match(story.description, /附近: 123 points/)
})

test('select 二阶段问题：选项封顶 + 始终带 none 兜底', () => {
  const options = Array.from({ length: 30 }, (_, index) => ({ label: `Option ${index}`, value: `v${index}` }))
  const question = selectOptionQuestion('Cabin', 'choose Business', options)
  assert.equal(question.kind, 'choice')
  assert.equal(Object.keys(question.options).length, SELECT_OPTION_CAP + 1)
  assert.equal(question.options.none !== undefined, true)
  assert.equal(question.options.o1, 'Option 1')
  assert.match(question.prompt, /Cabin/)
})

test('字段名归一：下划线/连字符/大小写都算同一个字段', () => {
  assert.equal(fieldName('First_Name'), 'first name')
  assert.equal(fieldName('first-name'), 'first name')
  assert.equal(fieldName('  First   Name '), 'first name')
  const candidate = { id: 'input:1', description: '', kind: 'input', role: 'textbox', name: 'First Name' }
  assert.equal(matchInputValue(candidate, { first_name: 'Ada' }), 'Ada')
  assert.equal(matchInputValue(candidate, { postal_code: '10001' }), undefined)
})

test('候选排序：near 上下文对同一 token 只贡献一次，精确名称保持优先', () => {
  const generic = { id: 'click:generic', description: '', kind: 'click', role: 'button', name: 'View', near: 'top story' }
  const exact = { id: 'click:exact', description: '', kind: 'click', role: 'button', name: 'top' }
  assert.equal(rankByGoal([generic, exact], 'top')[0]?.id, 'click:exact')
})

test('字段匹配：精确名优先，宽松词组匹配唯一时才绑定', () => {
  const fields = [
    { id: 'input:text', description: '', kind: 'input', role: 'textbox', name: 'Text input' },
    { id: 'input:textarea', description: '', kind: 'input', role: 'textbox', name: 'Textarea' },
  ]
  const matches = inputMatchesOf(fields, { text: 'hello' })
  assert.equal(matches.get('input:text')?.value, 'hello')
  assert.equal(matches.has('input:textarea'), false)

  const ambiguous = [
    { id: 'input:first', description: '', kind: 'input', role: 'textbox', name: 'First Name' },
    { id: 'input:billing', description: '', kind: 'input', role: 'textbox', name: 'First Name Billing' },
  ]
  assert.equal(inputMatchesOf(ambiguous, { first: 'Ada' }).size, 0)
  assert.equal(pendingFieldOf(ambiguous, { first: 'Ada' }), undefined)
})

test('抽取：可排序表头（th.header / role=columnheader / cursor:pointer）进候选池', async () => {
  const { JSDOM } = await import('jsdom')
  const { EXTRACT_SCRIPT } = await import('../lib/extract.js')
  const dom = new JSDOM(
    '<table><thead><tr><th class="header"><span>Last Name</span></th><th>First Name</th></tr></thead>' +
      '<tbody><tr><td>Smith</td><td>John</td></tr></tbody></table>' +
      '<div role="columnheader">Amount</div>',
    { url: 'https://a.test/tables', pretendToBeVisual: true },
  )
  const { window } = dom
  // jsdom 没有布局：给固定尺寸，否则抽取脚本的 `rect.width < 2` 会把所有元素过滤掉。
  window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, x: 10, y: 10, toJSON() {} })
  window.document.elementFromPoint = () => null
  // jsdom 没有实现 `innerText`（抽取脚本用它取可见名）：用 textContent 顶上。
  Object.defineProperty(window.Element.prototype, 'innerText', { get() { return this.textContent }, configurable: true })
  const run = new Function('document', 'innerWidth', 'innerHeight', 'getComputedStyle', 'location', `return ${EXTRACT_SCRIPT}`)
  const raw = run(window.document, 1024, 768, window.getComputedStyle.bind(window), window.location)
  const page = parseExtracted(raw)
  const headers = page.items.filter((item) => item.role === 'columnheader')
  assert.ok(headers.some((item) => item.name === 'Last Name'), `表头应进候选，实际：${JSON.stringify(page.items)}`)
  assert.ok(headers.some((item) => item.name === 'Amount'), 'role=columnheader 的表头也要进')
  assert.ok(!headers.some((item) => item.name === 'First Name'), '没有排序迹象的普通表头不该进（噪声）')
})

test('抽取：外语表单只凭标准属性与最近容器得到 formId、槽位和签名', async () => {
  const { JSDOM } = await import('jsdom')
  const { EXTRACT_SCRIPT } = await import('../lib/extract.js')
  const dom = new JSDOM(
    '<form id="credential-form"><div><input type="text" autocomplete="username" aria-label="Compte"></div>' +
      '<div><input type="password" autocomplete="current-password" aria-label="Secret"></div>' +
      '<button>Envoyer</button></form>' +
      '<div><input type="search" aria-label="Chercher"><button type="button" aria-label="Action"></button></div>',
    { url: 'https://a.test/foreign', pretendToBeVisual: true },
  )
  const { window } = dom
  window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 24, top: 10, left: 10, right: 110, bottom: 34, x: 10, y: 10, toJSON() {} })
  window.document.elementFromPoint = () => null
  Object.defineProperty(window.Element.prototype, 'innerText', { get() { return this.textContent }, configurable: true })
  const run = new Function('document', 'innerWidth', 'innerHeight', 'getComputedStyle', 'location', `return ${EXTRACT_SCRIPT}`)
  const page = parseExtracted(run(window.document, 1024, 768, window.getComputedStyle.bind(window), window.location))
  const account = page.items.find((item) => item.name === 'Compte')
  const password = page.items.find((item) => item.name === 'Secret')
  const submit = page.items.find((item) => item.name === 'Envoyer')
  const search = page.items.find((item) => item.name === 'Chercher')
  assert.equal(account?.inputType, 'text')
  assert.equal(account?.autocomplete, 'username')
  assert.equal(account?.formId, 'id:credential-form')
  assert.equal(password?.inputType, 'password')
  assert.equal(password?.autocomplete, 'current-password')
  assert.equal(submit?.inputType, 'submit')
  assert.equal(account?.groupId, password?.groupId)
  assert.equal(password?.groupId, submit?.groupId)
  assert.equal(search?.inputType, 'search')
  const candidates = candidatesFromExtracted(page.items)
  const accountCandidate = candidates.find((candidate) => candidate.name === 'Compte')
  const passwordCandidate = candidates.find((candidate) => candidate.name === 'Secret')
  const submitCandidate = candidates.find((candidate) => candidate.name === 'Envoyer')
  const searchCandidate = candidates.find((candidate) => candidate.name === 'Chercher')
  assert.equal(accountCandidate?.groupRole, 'username')
  assert.equal(passwordCandidate?.groupRole, 'password')
  assert.equal(submitCandidate?.groupRole, 'submit')
  assert.equal(searchCandidate?.groupRole, 'search')
  assert.equal(accountCandidate?.groupSignature, 'textbox:username+textbox:password+button:submit')
  const outline = groupOutlineOf(candidates)
  assert.match(outline, /textbox:username/)
  assert.match(outline, /textbox:password/)
  assert.ok(!outline.includes('Envoyer') && !outline.includes('Secret'), '大纲不重复候选标签')
})

test('候选大纲把重复同构行折叠为组计数', () => {
  const items = Array.from({ length: 12 }, (_, row) => [
    { index: row * 3, role: 'a', name: `Record ${row}`, covered: false, groupId: `g${row}` },
    { index: row * 3 + 1, role: 'button', name: 'Edit', covered: false, groupId: `g${row}` },
    { index: row * 3 + 2, role: 'button', name: 'Delete', covered: false, groupId: `g${row}` },
  ]).flat()
  const candidates = candidatesFromExtracted(items)
  const legacy = candidates.map((candidate) => `${candidate.role} ${candidate.name}`).join('\n')
  const outline = groupOutlineOf(candidates)
  assert.match(outline, /group×12: a:a \+ button:button \+ button:button/)
  assert.ok(outline.length < legacy.length / 5, `大纲 ${outline.length} 字符，应显著短于逐候选 ${legacy.length} 字符`)
  assert.ok(!outline.includes('Record 0') && !outline.includes('Delete'))
})

test('抽取：超过 300 上限时先保主内容区，导航链接不挤掉目标控件', async () => {
  const { JSDOM } = await import('jsdom')
  const { EXTRACT_SCRIPT } = await import('../lib/extract.js')
  const navLinks = Array.from({ length: 320 }, (_, index) => `<a href="/nav${index}">Nav ${index}</a>`).join('')
  const dom = new JSDOM(
    `<nav>${navLinks}</nav><main><button>Checkout</button></main>`,
    { url: 'https://a.test/dense', pretendToBeVisual: true },
  )
  const { window } = dom
  window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, x: 10, y: 10, toJSON() {} })
  window.document.elementFromPoint = () => null
  Object.defineProperty(window.Element.prototype, 'innerText', { get() { return this.textContent }, configurable: true })
  const run = new Function('document', 'innerWidth', 'innerHeight', 'getComputedStyle', 'location', `return ${EXTRACT_SCRIPT}`)
  const page = parseExtracted(run(window.document, 1024, 768, window.getComputedStyle.bind(window), window.location))
  assert.equal(page.truncated, true)
  assert.ok(
    page.items.some((item) => item.name === 'Checkout'),
    `主内容区控件不能被导航挤掉，实际候选数：${page.items.length}`,
  )
})

test('抽取：可见弹层里 cursor:pointer 的叶子控件（<p>Close</p>）进候选池', async () => {
  const { JSDOM } = await import('jsdom')
  const { EXTRACT_SCRIPT } = await import('../lib/extract.js')
  const dom = new JSDOM(
    '<div id="modal"><div class="modal"><p>正文</p><div class="modal-footer"><p style="cursor: pointer">Close</p></div></div></div>',
    { url: 'https://a.test/entry_ad', pretendToBeVisual: true },
  )
  const { window } = dom
  window.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 120, top: 10, left: 10, right: 310, bottom: 130, x: 10, y: 10, toJSON() {} })
  window.document.elementFromPoint = () => null
  Object.defineProperty(window.Element.prototype, 'innerText', { get() { return this.textContent }, configurable: true })
  const run = new Function('document', 'innerWidth', 'innerHeight', 'getComputedStyle', 'location', `return ${EXTRACT_SCRIPT}`)
  const page = parseExtracted(run(window.document, 1024, 768, window.getComputedStyle.bind(window), window.location))
  assert.ok(page.items.some((item) => item.name === 'Close'), `弹层关闭键应进候选，实际：${JSON.stringify(page.items)}`)
})

test('pendingFieldOf：填过又被清空的字段算 pending（读回校验），但有重填上限与 Enter 消费豁免', () => {
  // 字段当前是空的（state.value === undefined），但 filled 里记着它被填过 → 值没留住，要重填。
  const empty = [{ id: 'input:0', kind: 'input', role: 'textbox', name: 'Date picker', description: '在…里输入' }]
  const filled = new Map([['input:0', '09/16/2026']])
  assert.equal(pendingFieldOf(empty, { date: '09/16/2026' }, 'submit the form', filled)?.id, 'input:0')
  // 重填到上限（站点每次清空）→ 不再当 pending，交给正常判断，不无限拉锯。
  assert.equal(pendingFieldOf(empty, { date: '09/16/2026' }, 'submit the form', filled, new Set(['input:0'])), undefined)
  // 按 Enter 提交消费后变空的字段（如 TodoMVC 新建框）→ 不再当 pending 重填。
  assert.equal(pendingFieldOf(empty, { date: '09/16/2026' }, 'Add a todo', filled, new Set(), new Set(['input:0'])), undefined)
  // 没填过的空字段 + 通用 key：不当作 pending（否则所有空文本框都会被反复填）。
  assert.equal(pendingFieldOf(empty, { text: 'x' }, 'submit the form', new Map()), undefined)
})

test('抽取：checkbox 不把默认 value="on" 当名字，且能从紧邻文本/同级 label 取名（ti-checkboxes / todomvc）', async () => {
  const { JSDOM } = await import('jsdom')
  const { EXTRACT_SCRIPT } = await import('../lib/extract.js')
  const dom = new JSDOM(
    '<form id="checkboxes"><input type="checkbox"> checkbox 1<br><input type="checkbox" checked> checkbox 2</form>' +
      '<main><label for="toggle-all">Mark all as complete</label><ul class="todo-list"><li><div class="view"><input class="toggle" type="checkbox"><label>buy milk</label></div></li></ul></main>',
    { url: 'https://a.test/checkboxes', pretendToBeVisual: true },
  )
  const { window } = dom
  window.Element.prototype.getBoundingClientRect = () => ({ width: 20, height: 20, top: 10, left: 10, right: 30, bottom: 30, x: 10, y: 10, toJSON() {} })
  window.document.elementFromPoint = () => null
  Object.defineProperty(window.Element.prototype, 'innerText', { get() { return this.textContent }, configurable: true })
  const run = new Function('document', 'innerWidth', 'innerHeight', 'getComputedStyle', 'location', `return ${EXTRACT_SCRIPT}`)
  const page = parseExtracted(run(window.document, 1024, 768, window.getComputedStyle.bind(window), window.location))
  const names = page.items.map((item) => item.name)
  assert.ok(!names.includes('on'), `不应出现默认 "on" 名字，实际：${JSON.stringify(page.items)}`)
  assert.ok(names.includes('checkbox 1') && names.includes('checkbox 2'), `应抽到紧邻文本名，实际：${JSON.stringify(names)}`)
  assert.ok(names.includes('buy milk'), `应抽到同级 label 名，实际：${JSON.stringify(names)}`)
  const markAll = page.items.find((item) => item.name === 'Mark all as complete')
  assert.ok(!(markAll?.near ?? '').includes('buy milk'), `外层容器的 near 不应混入列表项 buy milk，实际：${markAll?.near}`)
})

test('isAlreadySatisfied：多子句勾选目标按各子句独立判定 checked / unchecked', () => {
  const goal = 'Make checkbox 1 checked and checkbox 2 unchecked'
  const cb1Checked = { id: 'click:0', kind: 'click', role: 'checkbox', name: 'checkbox 1', state: '已勾选', description: '勾选框（checkbox #1）「checkbox 1」 [已勾选]' }
  const cb1Unchecked = { id: 'click:0', kind: 'click', role: 'checkbox', name: 'checkbox 1', state: '未勾选', description: '勾选框（checkbox #1）「checkbox 1」 [未勾选]' }
  const cb2Checked = { id: 'click:1', kind: 'click', role: 'checkbox', name: 'checkbox 2', state: '已勾选', description: '勾选框（checkbox #2）「checkbox 2」 [已勾选]' }
  const cb2Unchecked = { id: 'click:1', kind: 'click', role: 'checkbox', name: 'checkbox 2', state: '未勾选', description: '勾选框（checkbox #2）「checkbox 2」 [未勾选]' }
  assert.equal(isAlreadySatisfied(cb1Checked, goal), true)
  assert.equal(isAlreadySatisfied(cb1Unchecked, goal), false)
  assert.equal(isAlreadySatisfied(cb2Unchecked, goal), true)
  assert.equal(isAlreadySatisfied(cb2Checked, goal), false)
  assert.equal(isTargetToggleCandidate(cb1Unchecked, 'Check checkbox 1 and uncheck checkbox 2'), true)
  assert.equal(isTargetToggleCandidate(cb2Checked, 'Check checkbox 1 and uncheck checkbox 2'), true)

  const radio1 = { id: 'click:2', kind: 'click', role: 'radio', name: 'Checked radio', state: '已勾选', description: '单选框（radio #1）「Checked radio」 [已勾选]' }
  const radio2 = { id: 'click:3', kind: 'click', role: 'radio', name: 'Default radio', state: '未勾选', description: '单选框（radio #2）「Default radio」 [未勾选]' }
  assert.equal(isTargetToggleCandidate(radio1, 'Select the second radio button'), false)
  assert.equal(isTargetToggleCandidate(radio2, 'Select the second radio button'), true)
})

test('candidatesFromExtracted：物理 combobox role 即使不识别 goal 动词也进入 Jev 前 10', () => {
  const fillers = Array.from({ length: 45 }, (_, idx) => ({
    index: idx,
    role: 'a',
    name: `Link ${idx}`,
    covered: false,
  }))
  const items = [
    ...fillers,
    { index: 45, role: 'button', name: 'Remove Purple', covered: false },
    { index: 46, role: 'combobox', name: 'Ocean', covered: false },
  ]
  const candidates = candidatesFromExtracted(items, 'In the first dropdown on the page, choose the colour Purple')
  const combo = candidates.find((c) => c.role === 'combobox')
  assert.ok(combo !== undefined, 'combobox 不应被前 40 个普通点击项截丢')
  assert.ok(candidates.slice(0, 10).includes(combo), '标准 combobox role 应进入 Jev 首轮可见候选')
})

test('inputsApplied：读回为空的原生字段不算生效；目标点名禁用控件时也不许收尾', () => {
  // 写入没有生效（原生 input 读回仍为空）→ 不能因为"调用过 fill"就宣布完成。
  const emptyField = [{ id: 'input:0', description: 'x', kind: 'input', role: 'textbox', name: 'Text input', tag: 'input' }]
  assert.equal(inputsApplied(emptyField, { text: 'x' }, new Map([['input:0', 'x']])), false)
  // 真的读回了值才算生效。
  const filledField = [{ ...emptyField[0], state: '已有内容: x' }]
  assert.equal(inputsApplied(filledField, { text: 'x' }, new Map([['input:0', 'x']])), true)
  // 目标要往禁用控件里输入，而它仍然是禁用的 → 不声称完成。
  const disabled = [{ id: 'input:1', description: 'x', kind: 'input', role: 'textbox', name: 'Text input', tag: 'input', state: '已有内容: x' },
    { id: 'input:2', description: 'x', kind: 'input', role: 'textbox', name: 'Disabled input', tag: 'input', state: '已禁用' }]
  assert.equal(inputsApplied(disabled, { text: 'x' }, new Map([['input:1', 'x']]), 'Type into the disabled input field'), false)
  assert.equal(inputsApplied(disabled, { text: 'x' }, new Map([['input:1', 'x']]), 'Fill in the text input'), true)
})

test('范围限定目标只暴露主内容链接；筛选收尾要求路由与可见条目状态一致', () => {
  const goal = 'Open the comments page of the top story'
  const header = { id: 'click:0', description: 'header comments', kind: 'click', role: 'a', name: 'comments', inMain: false }
  const tableHeader = { ...header, id: 'click:2', inMain: true }
  const story = { id: 'click:1', description: 'story comments', kind: 'click', role: 'a', name: '42 comments', near: 'Top story title 42 comments', inMain: true, groupId: 'row:1' }
  const laterStory = { ...story, id: 'click:4', name: '53 comments', groupId: 'row:2', near: 'Second story title 53 comments' }
  assert.equal(requiresPrimaryContentTarget(goal), true)
  assert.deepEqual(scopeCandidatesOf(goal, [header, story, laterStory]), [story])
  assert.deepEqual(scopeCandidatesOf(goal, [tableHeader, story]), [story])
  assert.deepEqual(scopeCandidatesOf('Open the comments page', [header, story]), [header, story])

  const filterGoal = 'Show only the completed todos'
  const visibleCompleted = [{ id: 'click:0', description: 'todo', kind: 'click', role: 'checkbox', name: 'buy milk', state: '已勾选', inMain: true }]
  assert.equal(filterStateMatchesGoal(filterGoal, visibleCompleted, 'https://todo.test/#/completed'), true)
  assert.equal(filterStateMatchesGoal(filterGoal, [{ ...visibleCompleted[0], state: '未勾选' }], 'https://todo.test/#/completed'), false)
  assert.equal(filterStateMatchesGoal(filterGoal, visibleCompleted, 'https://todo.test/#/active'), false)
  assert.equal(filterStateMatchesGoal('Open the completed guide', visibleCompleted, 'https://todo.test/#/completed'), undefined)
})

test('禁用目标：没有解锁控件时可判阻塞，有解锁入口时继续决策', () => {
  const target = { id: 'input:0', description: 'disabled input', kind: 'input', role: 'textbox', name: 'My disabled input', state: '已禁用' }
  assert.equal(disabledTargetWithoutUnlock('Type into the disabled input field', [target]), target)
  assert.equal(disabledTargetWithoutUnlock('Type into the disabled input field', [target, {
    id: 'click:1', description: 'enable', kind: 'click', role: 'button', name: 'Enable input',
  }]), undefined)
  assert.equal(disabledTargetWithoutUnlock('Type into the text input field', [target]), undefined)
})

test('urlChangeMatchesGoal：导航证据要求完整词，导航条里的近似链接不算命中', () => {
  const start = 'https://news.ycombinator.com/'
  // 真机 hn-comments：点到页头的 /newcomments 时，不能把 "comments" 当成目标页。
  assert.equal(urlChangeMatchesGoal('Open the comments page of the top story', start, `${start}newcomments`), undefined)
  // 真正的目标页仍然命中。
  assert.equal(urlChangeMatchesGoal('Open the comments page', start, `${start}comments`), 'comments')
  // 连字符/点/问号都是词边界，正常的真实命中不受影响。
  assert.equal(urlChangeMatchesGoal('Go to checkout', 'https://shop.test/inventory.html', 'https://shop.test/checkout-step-one.html'), 'checkout')
  assert.equal(urlChangeMatchesGoal('Open the cart', 'https://shop.test/', 'https://shop.test/cart.html'), 'cart')
})

test('urlChangeMatchesGoal：两跳纯导航目标只认末跳目的地词（不在第一跳提前收尾）', () => {
  const goal = 'Open the cart and go to checkout'
  assert.equal(urlChangeMatchesGoal(goal, 'https://www.saucedemo.com/inventory.html', 'https://www.saucedemo.com/cart.html'), undefined)
  assert.equal(urlChangeMatchesGoal(goal, 'https://www.saucedemo.com/inventory.html', 'https://www.saucedemo.com/checkout-step-one.html'), 'checkout')
})

test('抽取：通用 ARIA 状态（expanded/selected/pressed/disabled）、主内容区 inMain 标记与孪生父壳去重', async () => {
  const { JSDOM } = await import('jsdom')
  const { EXTRACT_SCRIPT } = await import('../lib/extract.js')
  const dom = new JSDOM(
    '<nav><a href="/home">Home</a></nav>' +
      '<main>' +
      '  <button aria-expanded="false">Menu</button>' +
      '  <button role="tab" aria-selected="true">Issues</button>' +
      '  <button aria-pressed="true">Star</button>' +
      '  <input type="text" placeholder=" LockedField " disabled>' +
      '  <div role="button" onclick="noop()"><button>Checkout</button></div>' +
      '</main>',
    { url: 'https://a.test/app', pretendToBeVisual: true },
  )
  const { window } = dom
  window.Element.prototype.getBoundingClientRect = () => ({ width: 80, height: 24, top: 10, left: 10, right: 90, bottom: 34, x: 10, y: 10, toJSON() {} })
  window.document.elementFromPoint = () => null
  Object.defineProperty(window.Element.prototype, 'innerText', { get() { return this.textContent }, configurable: true })
  const run = new Function('document', 'innerWidth', 'innerHeight', 'getComputedStyle', 'location', `return ${EXTRACT_SCRIPT}`)
  const page = parseExtracted(run(window.document, 1024, 768, window.getComputedStyle.bind(window), window.location))

  const home = page.items.find((item) => item.name === 'Home')
  const menu = page.items.find((item) => item.name === 'Menu')
  const issues = page.items.find((item) => item.name === 'Issues')
  const star = page.items.find((item) => item.name === 'Star')
  const locked = page.items.find((item) => item.name === 'LockedField')
  const checkouts = page.items.filter((item) => item.name === 'Checkout')

  assert.equal(home?.inMain, false, 'nav 内链接应标记 inMain=false')
  assert.equal(menu?.inMain, true, 'main 内按钮应标记 inMain=true')
  assert.equal(menu?.state, '已收起')
  assert.equal(issues?.state, '已选中')
  assert.equal(star?.state, '已按下')
  assert.equal(locked?.state, '已禁用')
  assert.equal(checkouts.length, 1, `外层 div[role=button] 与内层 <button> 同名孪生节点应去重为 1 个，实际：${JSON.stringify(checkouts)}`)
})

test('rankByGoal：纯词面软排序、结构分数、同名多样性封顶与主内容区优先', () => {
  // 1) 序号在候选描述中显式呈现；goal 的 second 由 Jev 理解，不由插件规则抢先决定。
  const radios = candidatesFromExtracted(
    [
      { index: 0, role: 'radio', name: 'Checked radio', covered: false, state: '已勾选' },
      { index: 1, role: 'radio', name: 'Default radio', covered: false, state: '未勾选' },
    ],
    'Select the second radio button',
  )
  const secondRadio = radios.find((candidate) => candidate.name === 'Default radio')
  assert.match(secondRadio?.description ?? '', /radio #2/, '第 2 个 radio 要带稳定序号供判断层选择')

  // 2) 列表页 15 个未命中目标的同名 View Details 按钮最多保留 2 个在第一梯队，把名额让给底部的唯一业务按钮且主内容区优先于导航栏
  const listItems = [
    { index: 0, role: 'a', name: 'Global Nav', covered: false, inMain: false },
    ...Array.from({ length: 15 }, (_, i) => ({ index: i + 1, role: 'button', name: 'View Details', covered: false, inMain: true })),
    { index: 16, role: 'button', name: 'Publish Post', covered: false, inMain: true },
  ]
  const ranked = candidatesFromExtracted(listItems, '点击底部按钮')
  const top4Names = ranked.slice(0, 4).map((c) => c.name)
  assert.deepEqual(
    top4Names,
    ['View Details', 'View Details', 'Publish Post', 'Global Nav'],
    `未命中的同名 View Details 只保留前 2 个在第一梯队，底部 Publish Post 应跃升至第 3 位（高于 View Details #3..#15 与导航栏）：${JSON.stringify(top4Names)}`,
  )
  assert.equal(ranked[0]?.inMain, true, '字面无重合时主内容区控件应排在页头导航链接之前')
})

test('inputMatchesOf 与 addToCartTarget：复合标签词边界匹配（postal_code ↔ Zip/Postal Code）及 buy/purchase 加购识别', () => {
  const checkoutFields = [
    { id: 'input:0', kind: 'input', role: 'textbox', name: 'First Name', description: '输入框「First Name」' },
    { id: 'input:1', kind: 'input', role: 'textbox', name: 'Last Name', description: '输入框「Last Name」' },
    { id: 'input:2', kind: 'input', role: 'textbox', name: 'Zip/Postal Code', description: '输入框「Zip/Postal Code」' },
  ]
  const matched = inputMatchesOf(checkoutFields, { first_name: 'Ada', last_name: 'Lovelace', postal_code: '10001' })
  assert.equal(matched.get('input:0')?.value, 'Ada')
  assert.equal(matched.get('input:1')?.value, 'Lovelace')
  assert.equal(matched.get('input:2')?.value, '10001', 'postal_code 应通过词边界匹配 Zip/Postal Code')

  const shopCandidates = [
    { id: 'click:1', kind: 'click', role: 'button', name: 'Add to cart', near: 'Sauce Labs Backpack $29.99', description: '点击「Add to cart」' },
    { id: 'click:2', kind: 'click', role: 'button', name: 'Add to cart', near: 'Sauce Labs Bike Light $9.99', description: '点击「Add to cart」' },
  ]
  assert.equal(
    addToCartTarget('Log in, buy the Sauce Labs Backpack and complete the checkout', shopCandidates)?.id,
    'click:1',
    'buy 目标在尚未加购时应直接定位目标商品的 Add to cart 按钮',
  )
  const afterAdded = [
    { id: 'click:1', kind: 'click', role: 'button', name: 'Remove', near: 'Sauce Labs Backpack $29.99', description: '点击「Remove」' },
    { id: 'click:2', kind: 'click', role: 'button', name: 'Add to cart', near: 'Sauce Labs Bike Light $9.99', description: '点击「Add to cart」' },
  ]
  assert.equal(
    addToCartTarget('Log in, buy the Sauce Labs Backpack and complete the checkout', afterAdded),
    undefined,
    '商品已加购（出现 Remove）后 buy 目标不再触发加购覆盖',
  )
})
