/**
 * 纯逻辑测试：动作映射、候选枚举、问题批次、页面侧的输入校验。
 * 这些都是"决定了就不会再变"的映射关系，值得被钉住。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionArgs, isSupportedVersion, nativeBinaryName, nativeSiblingPath, resolveCommand } from '../lib/cli.js'
import { FOLLOW_UP_VERBS, MAX_CLICK_CANDIDATES, SELECT_OPTION_CAP, bestEmptyInputForGoal, candidatesFromExtracted, candidatesOf, diffCandidates, fieldName, goalMentions, inputsApplied, isAlreadySatisfied, matchInputValue, pendingFieldOf, questionsOf, selectOptionQuestion, soleValueFor, specificallyNamed, stateOf, urlChangeMatchesGoal } from '../lib/task.js'
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

test('pendingFieldOf：填过又被清空的字段算 pending（读回校验），但有重填上限', () => {
  // 字段当前是空的（state.value === undefined），但 filled 里记着它被填过 → 值没留住，要重填。
  const empty = [{ id: 'input:0', kind: 'input', role: 'textbox', name: 'Date picker', description: '在…里输入' }]
  const filled = new Map([['input:0', '09/16/2026']])
  assert.equal(pendingFieldOf(empty, { date: '09/16/2026' }, 'submit the form', filled)?.id, 'input:0')
  // 重填到上限（站点每次清空）→ 不再当 pending，交给正常判断，不无限拉锯。
  assert.equal(pendingFieldOf(empty, { date: '09/16/2026' }, 'submit the form', filled, new Set(['input:0'])), undefined)
  // 没填过的空字段 + 通用 key：不当作 pending（否则所有空文本框都会被反复填）。
  assert.equal(pendingFieldOf(empty, { text: 'x' }, 'submit the form', new Map()), undefined)
})
