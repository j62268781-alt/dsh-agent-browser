/**
 * 纯逻辑测试：动作映射、候选枚举、问题批次、页面侧的输入校验。
 * 这些都是"决定了就不会再变"的映射关系，值得被钉住。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionArgs, isSupportedVersion, nativeBinaryName, nativeSiblingPath, resolveCommand } from '../lib/cli.js'
import { MAX_CLICK_CANDIDATES, candidatesOf, questionsOf } from '../lib/task.js'
import { parseSkillFile, pluginNote } from '../lib/skill.js'
import { msToSeconds, parseDomains, secondsToMs } from '../client/config.js'

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

test('候选枚举：确定性、跳过无名元素、文本字段单独标注 input', () => {
  const candidates = candidatesOf(snapshot)
  const ids = candidates.map((candidate) => candidate.id)
  assert.deepEqual(ids, [
    'click:e1', 'click:e4',        // 可点角色，按快照顺序
    'input:e2',                    // textbox → input（循环里交回宿主）
    'control:scroll_down', 'control:scroll_up', 'control:back', 'control:wait',
  ])
  assert.ok(!ids.includes('click:e3'), '没有可访问名的链接不进候选')
})

test('候选封顶在协议的 255 之下（给控制项留位置）', () => {
  const refs = {}
  for (let index = 0; index < 400; index += 1) refs[`e${index}`] = { name: `B${index}`, role: 'button' }
  const candidates = candidatesOf({ ...snapshot, refs })
  const clicks = candidates.filter((candidate) => candidate.kind === 'click')
  assert.equal(clicks.length, MAX_CLICK_CANDIDATES)
})

test('问题批次：一个 choice + 两个 noul，且候选键集合就是候选集合', () => {
  const candidates = candidatesOf(snapshot)
  const questions = questionsOf('在 example.com 找到 Alpha', candidates)
  assert.deepEqual(Object.keys(questions).sort(), ['action', 'goal_done', 'stuck'])
  assert.equal(questions.action.kind, 'choice')
  assert.equal(questions.goal_done.kind, 'noul')
  assert.equal(questions.stuck.kind, 'noul')
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

test('超时的秒 ↔ 毫秒换算（界面用秒、配置存毫秒）', () => {
  assert.equal(msToSeconds(30_000), 30)
  assert.equal(msToSeconds(1_000), 1)
  assert.equal(msToSeconds('500'), 1)          // 非整秒向上取整到最近的秒
  assert.equal(msToSeconds(undefined), 0)
  assert.equal(secondsToMs(30), 30_000)
  assert.equal(secondsToMs(1), 1_000)
  assert.equal(secondsToMs('45'), 45_000)
})
