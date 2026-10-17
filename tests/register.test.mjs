/**
 * 注册面测试：**开关真的改变工具集合**——这是「浏览器功能 / 决策」两个开关的全部语义，
 * 也是"关掉即 prompt 零成本"这句话的唯一证据。
 *
 * 用真 cordis `Context` + 两个替身 Service（tools / skills），不需要 DSH：
 * 形状照 dsh-judgment 的 tests/service.test.mjs。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentBrowserService, { Config } from '../lib/index.js'

/** 工具注册表替身：只记下定义。 */
class FakeTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.registered = []
  }

  register(definition) {
    this.registered.push(definition)
    // 真的支持撤销：热更新测试要靠它验证"工具被撤掉"。
    return () => {
      const index = this.registered.indexOf(definition)
      if (index >= 0) this.registered.splice(index, 1)
    }
  }
}

/** dsh-judgment 提供的 `ctx.judgment` 替身：只证明"依赖在不在"这两条路径。 */
class FakeJudgment extends Service {
  constructor(ctx) {
    super(ctx, 'judgment')
  }
}

/** skill 注册表替身。 */
class FakeSkills extends Service {
  constructor(ctx) {
    super(ctx, 'skills')
    this.skills = []
  }

  register(skill) {
    this.skills.push(skill)
    return () => {
      const index = this.skills.indexOf(skill)
      if (index >= 0) this.skills.splice(index, 1)
    }
  }
}

async function boot(config = {}, { skills = false, judgment = false } = {}) {
  const ctx = new Context()
  await ctx.plugin(FakeTools)
  if (skills) await ctx.plugin(FakeSkills)
  if (judgment) await ctx.plugin(FakeJudgment)
  // 传**原始配置**（不是 `Config(config)`）：cordis 会解析一次并包成 Volatile；
  // 传已解析的值会被二次解析成非法形状（volatile 字段包着 get/write）。
  await ctx.plugin(AgentBrowserService, config)
  return ctx
}

const names = (ctx) => ctx.get('tools').registered.map((definition) => definition.name).sort()

test('默认配置：核心四件 + 截图；没有决策、没有逃生舱', async () => {
  const ctx = await boot()
  assert.deepEqual(names(ctx), ['browser_act', 'browser_read', 'browser_screenshot', 'browser_session', 'browser_snapshot'])
})

test('关闭「浏览器功能」：一个工具都不注册（模型面前零成本）', async () => {
  const ctx = await boot({ enabled: false })
  assert.deepEqual(ctx.get('tools').registered, [])
})

test('关掉工具面也照样注册内置 skill（skill 说的是怎么用 CLI）', async () => {
  const ctx = await boot({ enabled: false }, { skills: true })
  assert.equal(ctx.get('skills').skills.length, 1)
  assert.equal(ctx.get('skills').skills[0].name, 'agent-browser')
})

test('开「决策」且依赖在：多一个 browser_run', async () => {
  const ctx = await boot({ tools: { decision: true } }, { judgment: true })
  assert.ok(names(ctx).includes('browser_run'))
})

test('开「决策」但 dsh-judgment 不在：**不注册** browser_run（注册一个必然报错的工具没有意义）', async () => {
  const ctx = await boot({ tools: { decision: true } })
  assert.ok(!names(ctx).includes('browser_run'))
})

test('逃生舱默认关；打开才注册 browser_raw', async () => {
  assert.ok(!names(await boot()).includes('browser_raw'))
  assert.ok(names(await boot({ tools: { raw: true } })).includes('browser_raw'))
})

test('截图可以单独关掉', async () => {
  assert.ok(!names(await boot({ tools: { screenshot: false } })).includes('browser_screenshot'))
})

test('allowedDomains 与 profile 互斥：配置层面就拒（CLI 会 fail-closed 关掉 profile）', async () => {
  await assert.rejects(
    () => boot({ browser: { allowedDomains: ['a.com'], profile: 'Default' } }),
    /互斥/,
  )
})

test('会话名与浏览器参数真的进了全局参数（不是只写在配置里）', async () => {
  const ctx = await boot({
    session: { name: 'work-a' },
    browser: { headed: true, maxOutput: 4000, idleTimeout: '30m', allowedDomains: ['a.com', '*.b.com'] },
  })
  const info = ctx.get('browser').sessionInfo()
  assert.equal(info.session, 'work-a')
  assert.deepEqual(info.globalArgs, [
    '--session', 'work-a', '--headed', '--allowed-domains', 'a.com,*.b.com', '--max-output', '4000', '--idle-timeout', '30m', '--content-boundaries',
  ])
})

test('留空会话名 → 用插件自己的固定名（不落到 CLI 的全机共享默认会话）', async () => {
  const info = (await boot()).get('browser').sessionInfo()
  assert.equal(info.session, 'dsh-agent-browser')
  assert.ok(info.globalArgs.includes('dsh-agent-browser'))
})

test('内置 skill 的内容是原文 + 插件补充，且 references 目录绝对可用', async () => {
  const ctx = await boot({ tools: { decision: true } }, { skills: true })
  const skill = ctx.get('skills').skills[0]
  assert.match(skill.content, /agent-browser skills get core/)   // 原文在
  assert.match(skill.content, /DSH 插件补充/)                     // 补充也在
  assert.match(skill.content, /browser_run\(goal\)/)              // 决策开着要说
  assert.equal(skill.resourceBase.kind, 'directory')
  assert.ok(skill.resourceBase.path.endsWith('/skills/agent-browser'))
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
})

test('ctx.skills 不在：跳过并继续（可选服务，绝不拖垮插件）', async () => {
  const ctx = await boot({}, { skills: false })
  assert.ok(names(ctx).includes('browser_snapshot'))
})

/* ─────────────────────────── 安装自检 ─────────────────────────── */

test('自检：**就两项**（cli / chrome），且不含路径这类噪音', async () => {
  const ctx = await boot()
  const result = await ctx.get('browser').probe()
  assert.deepEqual(result.checks.map((entry) => entry.id), ['cli', 'chrome'])
  assert.equal(typeof result.ok, 'boolean')
  assert.equal(result.title, result.ok ? '浏览器环境就绪' : '浏览器环境不完整')
  for (const check of result.checks) {
    assert.equal(typeof check.label, 'string')
    assert.ok(!check.message.includes('/'), `消息里不该出现路径：${check.message}`)
  }
})

test('自检：可执行文件跑不起来 → cli 项红，并给出修法', async () => {
  const ctx = await boot({ browser: { executablePath: '/nonexistent/agent-browser' } })
  const result = await ctx.get('browser').probe()
  assert.equal(result.ok, false)
  assert.equal(result.title, '浏览器环境不完整')
  const cli = result.checks.find((entry) => entry.id === 'cli')
  assert.equal(cli?.status, 'fail')
  assert.equal(typeof cli?.fix, 'string')
})

test('自检：装好时两项都过（本机没有 Chrome 才跳过）', async (t) => {
  const ctx = await boot()
  const result = await ctx.get('browser').probe()
  const cli = result.checks.find((entry) => entry.id === 'cli')
  if (cli?.status !== 'pass') {
    t.skip(`本机没有可用的 agent-browser：${cli?.message ?? ''}`)
    return
  }
  assert.match(String(cli.message), /^已安装 \d+\.\d+\.\d+$/)
  const chrome = result.checks.find((entry) => entry.id === 'chrome')
  if (chrome?.status !== 'pass') {
    t.skip(`本机没找到 Chrome：${chrome?.message ?? ''}`)
    return
  }
  assert.equal(result.ok, true)
})

test('帮忙装：只装 CLI，Chrome 明确拒绝（装 Chrome 要管理员密码，不能挂后台等）', async () => {
  const ctx = await boot()
  const result = await ctx.get('browser').installCli('chrome')
  assert.equal(result.ok, false)
  assert.match(result.message, /Chrome/)
})

/**
 * **volatile 热更新**：设置页写的就是 volatile 字段，不会重建 entry。
 * 所以「改配置 → 工具集合 / 全局参数跟着变」必须靠服务自己监听
 * `loader/volatile-update` 重做注册——这几条钉住的就是这条链路。
 *
 * 宿主用的是 `updateVolatile(ref, next)`（原地改引用里的值）；服务只读 `.get()`，
 * 所以测试里直接把 `service.config[key]` 换成新解析出来的引用，等价且不用引第三方包。
 */
async function patchVolatile(ctx, patch) {
  const next = Config(patch)
  const service = ctx.get('browser')
  for (const key of Object.keys(patch)) service.config[key] = next[key]
  ctx.emit('loader/volatile-update')
  return service
}

test('volatile 热更新：关掉「浏览器功能」→ 工具真的撤掉；再打开又回来', async () => {
  const ctx = await boot()
  assert.equal(names(ctx).length, 5)
  await patchVolatile(ctx, { enabled: false })
  assert.deepEqual(names(ctx), [], '关掉之后模型面前应该一个工具都没有')
  await patchVolatile(ctx, { enabled: true })
  assert.equal(names(ctx).length, 5, '重新打开应该把工具加回来')
})

test('volatile 热更新：改「有头模式」→ 全局参数立刻换一份（不需要重启）', async () => {
  const ctx = await boot()
  const service = ctx.get('browser')
  assert.ok(!service.sessionInfo().globalArgs.includes('--headed'))
  await patchVolatile(ctx, { browser: { headed: true } })
  assert.ok(service.sessionInfo().globalArgs.includes('--headed'))
})

test('volatile 热更新：把 allowedDomains 与 profile 同时打开 → 拒绝应用，保留上一个可用配置', async () => {
  const ctx = await boot()
  const service = ctx.get('browser')
  const before = [...service.sessionInfo().globalArgs]
  await patchVolatile(ctx, { browser: { allowedDomains: ['a.com'], profile: 'work' } })
  assert.deepEqual([...service.sessionInfo().globalArgs], before)
})
