#!/usr/bin/env node
/**
 * 真 CLI 探针：不靠"我觉得好了"，用可复跑的命令证明四件事。
 *
 *   1. 版本锁生效（`assertSupported`）；
 *   2. `snapshot --json` 的 `data.refs` 能被解析成 `@eN` 引用；
 *   3. 按 ref 点击真的生效；
 *   4. **陈旧 ref 被拒绝**——它是 DESIGN v2 §1.1 的立身证据（撤掉了 v1 的 snapshot_id 门控）。
 *
 * 用法：`pnpm probe`（会 spawn 真浏览器，结束前 `close --all` 清理自己的会话）。
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentBrowser } from '../lib/cli.js'

const HTML = `<!doctype html><html><body>
<h1>probe</h1>
<div id="log">none</div>
<button id="go" onclick="document.getElementById('log').textContent='clicked go'">Go</button>
</body></html>`

const SESSION = 'dsh-agent-browser-probe'
// 传空 = 让插件自己解析（会跳过 PATH 上的 Node 包装层，直接 spawn 原生二进制）。
// 想看包装层的对比，就显式传 'agent-browser'。
const browser = new AgentBrowser({
  command: '',
  globalArgs: ['--session', SESSION, '--content-boundaries'],
  timeoutMs: 30_000,
})

let failed = 0
const check = (title, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? '✓' : '✗'} ${title}${detail === '' ? '' : ` — ${detail}`}`)
}

/** 单次调用耗时（ms）：CLI 层的性能要说得出数字，不能靠"应该很快"。 */
async function timed(label, run) {
  const started = process.hrtime.bigint()
  const value = await run()
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  console.log(`  · ${label.padEnd(22)} ${ms.toFixed(1)}ms`)
  return value
}

try {
  const version = await browser.assertSupported()
  check('版本在支持区间内', true, version)
  console.log(`  · 实际命令              ${browser.commandDetail}`)

  const dir = await mkdtemp(join(tmpdir(), 'dsh-agent-browser-probe-'))
  const page = join(dir, 'probe.html')
  await writeFile(page, HTML, 'utf8')

  await timed('open', () => browser.open(`file://${page}`))
  const snapshot = await timed('snapshot -i', () => browser.snapshot({ interactiveOnly: true }))
  const refs = Object.keys(snapshot.refs)
  check('snapshot 解析出 refs', refs.length > 0, `${refs.length} 个 · digest ${snapshot.digest}`)

  const buttonRef = Object.entries(snapshot.refs).find(([, info]) => info.role === 'button')?.[0]
  check('找到按钮 ref', buttonRef !== undefined, buttonRef === undefined ? '' : `@${buttonRef}`)

  await timed('click @ref', () => browser.act('click', `@${buttonRef}`))
  const text = await timed('get text #log', () => browser.get('text', '#log', undefined))
  check('按 ref 点击生效', text.includes('clicked go'), JSON.stringify(text))

  // 把被点掉的元素删掉，再用同一个 ref：必须是**类型化失败**，不是静默点到别处。
  await browser.run(['eval', "document.getElementById('go').remove(); 'removed'"])
  let stale = ''
  try {
    await browser.act('click', `@${buttonRef}`)
  } catch (error) {
    stale = error instanceof Error ? error.message : String(error)
  }
  check('陈旧 ref 被拒（不会静默点到别的元素）', /Unknown ref|Could not locate/.test(stale), stale)
} catch (error) {
  failed += 1
  console.log(`✗ 探针异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  try {
    await browser.close()
  } catch {
    // 会话已经没了也无所谓。
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
