/**
 * `src/task/actions.ts`：浏览器动作执行（填值/点击/悬停/拖拽/按键）、加载等待与可见文本读取。
 */

import { CliError, type AgentBrowser, type Snapshot } from '../cli.js'
import { matchInputValue } from './gates.js'
import { LOADING_TEXT_MARK, MIN_PAGE_TEXT, type TaskCandidate, type TaskDeps } from './types.js'
import { message, sleep, stripContentBoundaries } from './utils.js'

/**
 * 有值时直接执行（不再交回宿主）：
 * - 原生 select（带 `options`、`tag=select` 或状态为 `当前值:`）→ `select`；
 * - `<input role="combobox">`（如 GitHub 搜索框，状态为 `已有内容:` 或空）→ `fill`；
 * - checkbox/radio/switch → `check`/`uncheck`；
 * - 其它 → `fill`。
 */
export async function fillFromInputs(
  browser: AgentBrowser,
  candidate: TaskCandidate,
  value: string,
  signal: AbortSignal,
): Promise<void> {
  const ref = candidate.ref
  if (ref === undefined) throw new CliError('bad-request', `候选 ${candidate.id} 没有动作目标`)
  const role = (candidate.role ?? '').toLowerCase()
  const isNativeSelect =
    role === 'select' ||
    candidate.tag === 'select' ||
    candidate.options !== undefined ||
    (role === 'combobox' && (candidate.state ?? '').startsWith('当前值:'))
  if (isNativeSelect) {
    const matchedOption = candidate.options?.find(
      (opt) => opt.value === value || opt.label.trim().toLowerCase() === value.trim().toLowerCase(),
    )
    const selectVal = matchedOption !== undefined && matchedOption.value !== '' ? matchedOption.value : value
    await browser.act('select', ref, { value: selectVal }, { signal })
    return
  }
  if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    await browser.act(/^(1|true|yes|on|y|是)$/i.test(value.trim()) ? 'check' : 'uncheck', ref, {}, { signal })
    return
  }
  await browser.act('fill', ref, { value }, { signal })
  if (typeof browser.json === 'function' && ref.startsWith('[') && /\bdate\b|日期/i.test(candidate.name ?? '')) {
    await browser
      .json(
        [
          'eval',
          `(() => { const el = document.querySelector(${JSON.stringify(ref)}); if (!el) return; const v = ${JSON.stringify(value)}; el.blur(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); if (el.value !== v) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } })()`,
        ],
        { signal },
      )
      .catch(() => {})
  }
}

/** `control:wait`：等到页面真的变，而不是固定睡 800ms。 */
export async function waitForPageChange(browser: AgentBrowser, signal: AbortSignal): Promise<void> {
  const signature = async (): Promise<string | undefined> => {
    try {
      const page = await browser.extract({ signal })
      return `${JSON.stringify(page.items)}\u0001${page.text.slice(0, 300)}`
    } catch {
      return undefined
    }
  }
  const before = await signature()
  if (before === undefined) {
    await browser.run(['wait', '800'], { signal }).catch(() => {})
    return
  }
  const loading = LOADING_TEXT_MARK.test(before)
  const attempts = loading ? 20 : 4
  for (let index = 0; index < attempts; index += 1) {
    await sleep(300)
    const current = await signature()
    if (current === undefined) continue
    if (loading ? !LOADING_TEXT_MARK.test(current) : current !== before) return
  }
  if (!loading) await browser.run(['wait', '300'], { signal }).catch(() => {})
}

/** 页面是否有阻塞的 JS 对话框：有就返回它的文案。 */
export async function dialogBlocker(browser: AgentBrowser, signal: AbortSignal): Promise<string | undefined> {
  try {
    const status = stripContentBoundaries(await browser.run(['dialog', 'status'], { signal }))
    if (/No dialog/i.test(status)) return undefined
    const match = /dialog is open:\s*"([^"]*)"/i.exec(status)
    return match?.[1] ?? 'unknown'
  } catch {
    return undefined
  }
}

/** 执行单个候选动作。 */
export async function execute(
  browser: AgentBrowser,
  candidate: TaskCandidate,
  signal: AbortSignal,
  inputs?: Readonly<Record<string, string>>,
): Promise<{ jsClicked?: { id: string; ref: string } }> {
  if (candidate.kind === 'click' && candidate.ref !== undefined) {
    const role = (candidate.role ?? '').toLowerCase()
    const given = matchInputValue(candidate, inputs)
    if (given !== undefined && (role === 'checkbox' || role === 'radio' || role === 'switch')) {
      await browser.act(/^(1|true|yes|on|y|是)$/i.test(given.trim()) ? 'check' : 'uncheck', candidate.ref, {}, { signal })
      return {}
    }
    if ((candidate.tag === 'a' || candidate.tag === 'button') && candidate.ref.startsWith('[')) {
      await browser.jsClick(candidate.ref, { signal })
      return { jsClicked: { id: candidate.id, ref: candidate.ref } }
    }
    if (candidate.ref.startsWith('[')) {
      await browser.act('scrollintoview', candidate.ref, {}, { signal }).catch(() => {})
    }
    await browser.act('click', candidate.ref, {}, { signal })
    return {}
  }
  if (candidate.id !== 'control:press_enter' && candidate.id.startsWith('control:press_')) {
    const key = candidate.id.slice('control:press_'.length)
    await browser.act('press', 'body', { value: key }, { signal })
    return {}
  }
  if (candidate.id.startsWith('hover:')) {
    if (candidate.ref !== undefined) await browser.act('hover', candidate.ref, {}, { signal })
    return {}
  }
  if (candidate.id.startsWith('drag:')) {
    if (candidate.ref !== undefined && candidate.targetRef !== undefined) {
      try {
        await browser.jsDrag(candidate.ref, candidate.targetRef, { signal })
        if (process.env.DSH_DEBUG_DRAG === '1') process.stderr.write(`[drag] jsDrag ok ${candidate.ref} -> ${candidate.targetRef}\n`)
      } catch (error) {
        if (process.env.DSH_DEBUG_DRAG === '1') process.stderr.write(`[drag] jsDrag FAILED ${message(error)} → fallback\n`)
        await browser.act('drag', candidate.ref, { value: candidate.targetRef }, { signal })
      }
    }
    return {}
  }
  switch (candidate.id) {
    case 'control:scroll_down':
      await browser.act('scroll', 'body', { direction: 'down' }, { signal })
      return {}
    case 'control:scroll_up':
      await browser.act('scroll', 'body', { direction: 'up' }, { signal })
      return {}
    case 'control:back':
      await browser.run(['back'], { signal })
      return {}
    case 'control:wait':
      await waitForPageChange(browser, signal)
      return {}
    case 'control:press_enter':
      await browser.act('press', 'body', { value: 'Enter' }, { signal })
      return {}
    default:
      throw new Error(`候选 ${candidate.id} 没有对应的执行分支`)
  }
}

/** 页面可见正文：`goal_done` 与独立确认的依据。 */
export async function visibleText(
  deps: TaskDeps,
  snapshot: Snapshot,
  trace: string[],
  step: number | undefined,
): Promise<string> {
  const where = step === undefined ? '确认前' : `第 ${step} 步`
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const text = stripContentBoundaries(await deps.browser.read(undefined, { signal: deps.signal }))
      if (text.length >= MIN_PAGE_TEXT) return text
      if (text.length > 0) {
        const controlText = stripContentBoundaries(snapshot.snapshot)
        trace.push(`${where}：read 只拿到 ${text.length} 个字符（页面可能还在渲染）→ 正文 + 无障碍树一起用于确认`)
        return controlText === '' ? text : `${text}\n${controlText}`
      }
      break
    } catch (error) {
      if (attempt === 2) trace.push(`${where}：读页面正文失败（${message(error)}），退回无障碍树文本`)
      else await sleep(300)
    }
  }
  return stripContentBoundaries(snapshot.snapshot)
}
