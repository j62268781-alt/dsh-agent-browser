// 导航证据与 benchmark 来源的任务态隔离（OPTIMIZATION-PLAN §0.7 0A/0B）。
//
// 目标：让「跑错了页面」「上一次任务的 storage 污染了下一次」「open 之后页面又跳走」
// 这三种情况在结果 JSON 里**可验证**，而不是靠人猜。
//
// 设计约束：
//   - **纯诊断**：本模块不参与 score.mjs 的 correct / false-done 判定，只返回证据对象；
//   - **依赖注入**：open / readUrl / evaluate / reload / waitForReady / sleep 全由调用方给，
//     单测用假浏览器直接驱动，不需要真 Chrome；
//   - **有界**：就绪等待与 URL 稳定性轮询都有上限，不用固定长 sleep；
//   - **安全**：storage 清理只允许 benchmark 任务的 http(s) origin，且当前页必须**已经**在该
//     origin 上；file:// 等来源一律拒绝（Chrome 的 file:// storage 可能与其他本地页面共享）。
import { createHash } from 'node:crypto'

/** 默认参数（run.mjs 可覆盖；单测直接用小值）。 */
export const NAV_DEFAULTS = {
  openRetries: 2,
  retryBackoffMs: 800,
  readyTimeoutMs: 3000,
  readyFallbackMs: 250,
  stablePolls: 3,
  pollMs: 120,
  domTextCap: 2000,
  storageKeyCap: 50,
}

// 页面内探针表达式（导出是为了让单测的假浏览器能识别语义，而不是靠子串猜）。
export const STORAGE_READ_EXPRESSION =
  '() => { const read = (store) => { try { const keys = []; for (let index = 0; index < store.length; index += 1) keys.push(store.key(index)); return keys } catch (error) { return { error: String((error && error.message) || error) } } }; return { local: read(localStorage), session: read(sessionStorage) } }'
export const STORAGE_CLEAR_EXPRESSION =
  '() => { const result = { local: false, session: false }; try { localStorage.clear(); result.local = true } catch (error) { result.local_error = String((error && error.message) || error) } try { sessionStorage.clear(); result.session = true } catch (error) { result.session_error = String((error && error.message) || error) } return result }'
export const DOM_STATE_EXPRESSION = `() => { const text = document.body ? String(document.body.innerText || '') : ''; const html = document.documentElement ? String(document.documentElement.outerHTML || '') : ''; return { url: String(location.href), title: String(document.title || ''), text: text.slice(0, ${NAV_DEFAULTS.domTextCap}), html_length: html.length } }`

const sleepReal = (ms) => new Promise((done) => setTimeout(done, ms))

const delay = (deps, ms) => (typeof deps.sleep === 'function' ? deps.sleep(ms) : sleepReal(ms))

function errorText(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 300)
}

/** URL 解析失败不抛错：诊断场景里"读到的不是合法 URL"本身就是证据。 */
export function parseUrl(value) {
  const raw = String(value ?? '')
  try {
    const url = new URL(raw)
    return {
      ok: true,
      href: url.href,
      scheme: url.protocol,
      origin: url.origin,
      host: url.host,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    }
  } catch {
    return { ok: false, href: raw, scheme: '', origin: '', host: '', pathname: '', search: '', hash: '' }
  }
}

/** benchmark 来源：只有 http(s) 任务页允许做 storage 清理；file:// 返回空串（拒绝）。 */
export function benchmarkOriginOf(value) {
  const parsed = parseUrl(value)
  return parsed.ok && (parsed.scheme === 'http:' || parsed.scheme === 'https:') ? parsed.origin : ''
}

/** 稳定短摘要（DOM/storage 指纹用；不需要密码学强度）。 */
export function hashText(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 16)
}

async function readUrlSafe(deps) {
  try {
    return String(await deps.readUrl()).trim()
  } catch {
    return ''
  }
}

function clip(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * 打开 URL 并采集导航证据。**不改变**原来的"只核对 host"判定（登录墙/重定向是任务场景本身），
 * 但把 open 时、就绪后、轮询后的 URL 全记下来，并用有界轮询发现迟到导航/标签切换。
 *
 * @param {string} url 目标 URL
 * @param {{ open: (url: string) => Promise<unknown>, readUrl: () => Promise<string>, waitForReady?: (options: { timeoutMs: number }) => Promise<boolean>, sleep?: (ms: number) => Promise<unknown> }} deps
 * @param {Partial<typeof NAV_DEFAULTS>} [options]
 */
export async function openWithEvidence(url, deps, options = {}) {
  const config = { ...NAV_DEFAULTS, ...options }
  const evidence = {
    requested_url: String(url ?? ''),
    ok: false,
    diagnosis: 'not_opened',
    url_before_open: await readUrlSafe(deps),
    url_after_open: '',
    url_after_ready: '',
    url_settled: '',
    url_polls: [],
    url_changed_during_ready: false,
    url_changed_after_ready: false,
    stable: false,
    ready: false,
    ready_method: 'none',
    host_matched: false,
    path_matched: false,
    query_matched: false,
    hash_matched: false,
    same_host_other_path: false,
    attempts: [],
  }
  const want = parseUrl(url)
  const attempts = Math.max(1, Number(config.openRetries) || 1)

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await delay(deps, config.retryBackoffMs)
    // open 抛错（网络不可达）保持原样向上抛：runner 靠错误文案区分 network 档。
    try {
      await deps.open(url)
    } catch (error) {
      evidence.attempts.push({ attempt: attempt + 1, error: errorText(error) })
      evidence.diagnosis = 'open_error'
      throw error
    }

    const afterOpen = await readUrlSafe(deps)
    evidence.url_after_open = afterOpen
    const got = parseUrl(afterOpen)
    const hostMatched = want.ok && got.ok && got.host === want.host
    evidence.attempts.push({ attempt: attempt + 1, url_after_open: afterOpen, host_matched: hostMatched })
    if (!hostMatched) continue

    // 只核对 host：/secure → /login 这类重定向是任务场景本身，不能当失败。
    // path/query/hash 只写进诊断字段（host 相同但 path 错误 = 可能跑错了页面）。
    evidence.host_matched = true
    evidence.path_matched = got.pathname === want.pathname
    evidence.query_matched = got.search === want.search
    evidence.hash_matched = got.hash === want.hash
    evidence.same_host_other_path = !evidence.path_matched

    // 就绪等待后**再次**读 URL：慢页面可能先返回旧地址，ready 期间才真正跳走。
    if (typeof deps.waitForReady === 'function') {
      try {
        evidence.ready = (await deps.waitForReady({ timeoutMs: config.readyTimeoutMs })) === true
      } catch {
        evidence.ready = false
      }
      evidence.ready_method = 'waitForReady'
    } else {
      await delay(deps, config.readyFallbackMs)
      evidence.ready = false
      evidence.ready_method = 'fixed_fallback'
    }

    evidence.url_after_ready = await readUrlSafe(deps)
    if (evidence.url_after_open !== '' && evidence.url_after_ready !== '') {
      evidence.url_changed_during_ready = evidence.url_after_ready !== evidence.url_after_open
    }

    const settled = await pollUrlStability(evidence.url_after_ready, deps, config)
    evidence.url_polls = settled.polls
    evidence.url_settled = settled.url
    evidence.stable = settled.stable
    evidence.url_changed_after_ready = settled.changed
    evidence.ok = true
    evidence.diagnosis = diagnoseOpen(want, evidence)
    return evidence
  }

  evidence.diagnosis = 'host_mismatch'
  return evidence
}

/** 有界 URL 稳定性轮询：连续两次读到同一地址就算稳定；最多 stablePolls 次。 */
async function pollUrlStability(seed, deps, config) {
  const polls = []
  const stablePolls = Math.max(0, Number(config.stablePolls) || 0)
  let last = seed
  let changed = false
  if (stablePolls === 0) return { polls, url: last, stable: true, changed }
  let stable = false
  for (let index = 0; index < stablePolls; index += 1) {
    await delay(deps, config.pollMs)
    const current = await readUrlSafe(deps)
    polls.push({ wait_ms: config.pollMs, url: current })
    if (current !== last) {
      changed = true
      last = current
      continue
    }
    if (current !== '') {
      stable = true
      break
    }
  }
  return { polls, url: last, stable, changed }
}

function diagnoseOpen(want, evidence) {
  if (!want.ok) return 'invalid_request_url'
  if (!evidence.host_matched) return 'host_mismatch'
  if (!evidence.stable) return 'url_unstable'
  if (evidence.url_changed_during_ready || evidence.url_changed_after_ready) return 'late_navigation'
  if (evidence.same_host_other_path) return 'same_host_other_path'
  return 'ok'
}

function normalizeKeys(value, cap) {
  if (!Array.isArray(value)) {
    return { keys: [], error: typeof value?.error === 'string' ? value.error : undefined }
  }
  return { keys: value.slice(0, cap).map((key) => String(key)) }
}

function storageSnapshot(value, cap) {
  const local = normalizeKeys(value?.local, cap)
  const session = normalizeKeys(value?.session, cap)
  return {
    local: local.keys,
    session: session.keys,
    local_count: local.keys.length,
    session_count: session.keys.length,
    ...(local.error === undefined ? {} : { local_error: local.error }),
    ...(session.error === undefined ? {} : { session_error: session.error }),
  }
}

function domSnapshot(value, cap) {
  const record = value !== null && typeof value === 'object' ? value : {}
  const text = clip(record.text ?? '', cap)
  const title = clip(record.title ?? '', 300)
  const url = clip(record.url ?? '', 2000)
  return {
    url,
    title,
    text_head: text,
    html_length: Number.isFinite(record.html_length) ? record.html_length : 0,
    digest: hashText(`${url}\u0001${title}\u0001${text}`),
  }
}

/**
 * 0A：任务起始时清理**该 benchmark 来源**的 localStorage/sessionStorage 并 reload。
 *
 * 安全门（任一条不过 → 不执行任何页面写操作，只记 skipped 原因）：
 *   1. 目标 URL 必须是 http(s)：file:// 的 storage 在 Chrome 里可能与其他本地页面共享；
 *   2. 目标 origin 必须在调用方给的 benchmark allowlist 里（任务集里出现的来源）；
 *   3. 当前页（open 之后）必须已经在该 origin 上：否则说明跑错了页面，不能清。
 *
 * @param {string} targetUrl 本条任务的目标 URL（来自 tasks.mjs，不是模型给的）
 * @param {{ readUrl: () => Promise<string>, evaluate: (expression: string) => Promise<unknown>, reload: () => Promise<unknown>, waitForReady?: (options: { timeoutMs: number }) => Promise<boolean>, sleep?: (ms: number) => Promise<unknown> }} deps
 * @param {{ allowedOrigins?: Set<string> | string[], currentUrl?: string, readyTimeoutMs?: number, pollMs?: number, domTextCap?: number, storageKeyCap?: number }} [options]
 */
export async function isolateStorage(targetUrl, deps, options = {}) {
  const config = { ...NAV_DEFAULTS, ...options }
  const allowed = options.allowedOrigins instanceof Set ? options.allowedOrigins : new Set(options.allowedOrigins ?? [])
  const target = parseUrl(targetUrl)
  const currentUrl = options.currentUrl === undefined ? await readUrlSafe(deps) : String(options.currentUrl ?? '')
  const current = parseUrl(currentUrl)
  const evidence = {
    target_url: String(targetUrl ?? ''),
    target_origin: target.origin,
    current_url_before: currentUrl,
    current_origin_before: current.origin,
    ran: false,
    skipped: undefined,
    storage_before: undefined,
    storage_after: undefined,
    storage_cleared: false,
    storage_clear_result: undefined,
    reloaded: false,
    ready_after_reload: false,
    url_after_reload: '',
    initial_dom: undefined,
    error: undefined,
  }

  if (!target.ok) {
    evidence.skipped = 'invalid_target_url'
    return evidence
  }
  if (target.scheme !== 'http:' && target.scheme !== 'https:') {
    // 不碰 file://：Chrome 的 file origin 可能与其他本地页面共享 storage。
    evidence.skipped = 'non_http_origin'
    return evidence
  }
  if (!allowed.has(target.origin)) {
    evidence.skipped = 'origin_not_allowed'
    return evidence
  }
  if (!current.ok || current.origin !== target.origin) {
    evidence.skipped = 'origin_mismatch'
    return evidence
  }

  evidence.ran = true
  try {
    const beforeRaw = await deps.evaluate(STORAGE_READ_EXPRESSION)
    evidence.storage_before = storageSnapshot(beforeRaw, config.storageKeyCap)
    const clearResult = await deps.evaluate(STORAGE_CLEAR_EXPRESSION)
    evidence.storage_clear_result = clearResult !== null && typeof clearResult === 'object'
      ? { local: clearResult.local === true, session: clearResult.session === true, ...(typeof clearResult.local_error === 'string' ? { local_error: clearResult.local_error } : {}), ...(typeof clearResult.session_error === 'string' ? { session_error: clearResult.session_error } : {}) }
      : { local: false, session: false }
    const afterRaw = await deps.evaluate(STORAGE_READ_EXPRESSION)
    evidence.storage_after = storageSnapshot(afterRaw, config.storageKeyCap)
    evidence.storage_cleared = evidence.storage_after.local_count === 0 &&
      evidence.storage_after.session_count === 0 &&
      (evidence.storage_before.local_count > 0 || evidence.storage_before.session_count > 0 || evidence.storage_clear_result.local === true)

    // reload：让页面基于空 storage 重新渲染（TodoMVC 这类 SPA 从 localStorage 恢复列表）。
    await deps.reload()
    evidence.reloaded = true
    if (typeof deps.waitForReady === 'function') {
      try {
        evidence.ready_after_reload = (await deps.waitForReady({ timeoutMs: config.readyTimeoutMs })) === true
      } catch {
        evidence.ready_after_reload = false
      }
    }
    evidence.url_after_reload = await readUrlSafe(deps)
    evidence.initial_dom = domSnapshot(await deps.evaluate(DOM_STATE_EXPRESSION), config.domTextCap)
  } catch (error) {
    evidence.error = errorText(error)
  }
  return evidence
}

/** 从 runTask 的 result.steps 里只留诊断字段（origin/action/executed/reason/digest）。 */
export function stepDiagnostics(steps) {
  if (!Array.isArray(steps)) return []
  return steps.map((item, index) => {
    const step = item !== null && typeof item === 'object' ? item : {}
    return {
      step: Number.isInteger(step.step) ? step.step : index + 1,
      origin: clip(step.origin ?? '', 300),
      action: clip(step.action ?? '', 160),
      executed: step.executed === true,
      reason: clip(step.reason ?? '', 200),
      digest: clip(step.digest ?? '', 200),
    }
  })
}

/**
 * 给 repeat>1 的记录标注"同一 task 多次启动时初始 DOM 是否一致"。
 * 只标注至少跑过两次的任务（单次无法比较）。
 */
export function annotateInitialStateStability(records) {
  const groups = new Map()
  for (const record of records) {
    const digest = record?.nav?.storage?.initial_dom?.digest
    if (typeof digest !== 'string' || digest === '') continue
    const bucket = groups.get(record.id) ?? []
    bucket.push({ record, digest })
    groups.set(record.id, bucket)
  }
  const compared = []
  const unstable = []
  for (const [id, bucket] of groups) {
    if (bucket.length < 2) continue
    compared.push(id)
    const digests = new Set(bucket.map((item) => item.digest))
    const stable = digests.size === 1
    for (const item of bucket) item.record.nav.storage.initial_dom_stable = stable
    if (!stable) unstable.push(`${id}(${digests.size})`)
  }
  return { compared: compared.length, stable: compared.length - unstable.length, unstable }
}

/** 汇总导航/隔离诊断，给 runner 打一行可读结论（不影响评分）。 */
export function summarizeNav(records) {
  const counts = {
    tasks: 0,
    hostMismatch: 0,
    urlUnstable: 0,
    lateNavigation: 0,
    sameHostOtherPath: 0,
    readyTimeout: 0,
    storageRan: 0,
    storageCleared: 0,
    storageSkipped: 0,
    storageErrors: 0,
  }
  const problems = []
  for (const record of records) {
    const nav = record?.nav
    if (nav === undefined || nav === null) continue
    counts.tasks += 1
    if (nav.diagnosis === 'host_mismatch' || nav.diagnosis === 'open_error') counts.hostMismatch += 1
    if (nav.diagnosis === 'url_unstable') counts.urlUnstable += 1
    if (nav.diagnosis === 'late_navigation') counts.lateNavigation += 1
    if (nav.diagnosis === 'same_host_other_path') counts.sameHostOtherPath += 1
    if (nav.ready_method === 'waitForReady' && nav.ready === false) counts.readyTimeout += 1
    if (['host_mismatch', 'url_unstable', 'late_navigation'].includes(nav.diagnosis)) {
      problems.push(`${record.id}:${nav.diagnosis}`)
    }
    const storage = nav.storage
    if (storage === undefined || storage === null) continue
    if (storage.ran === true) counts.storageRan += 1
    if (storage.storage_cleared === true) counts.storageCleared += 1
    if (typeof storage.skipped === 'string') counts.storageSkipped += 1
    if (typeof storage.error === 'string') counts.storageErrors += 1
  }
  return { counts, problems }
}
