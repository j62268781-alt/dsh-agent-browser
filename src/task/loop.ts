/**
 * `src/task/loop.ts`：有界决策主循环（`runTask`）与有序子目标编排（`runSubgoals`）。
 *
 * 核心原则：
 * 1. **确定性门控优先**：URL 命中、弹层关闭、加购变成 Remove、下拉项命中、勾选态全部达成、填值生效，直接收尾为 `needs_verification`。
 * 2. **Jev 只做候选排序**：不猜文字，不越过安全门。
 * 3. **Jev 搞不定就干净、早停交回上游 LLM**：
 *    - 首选动作无效且次优候选概率 < `ALTERNATE_MIN_PROBABILITY`（0.25）→ 不乱点破坏现场，立即交回；
 *    - 所有交回状态（`ambiguous` / `no_progress` / `blocked` / `page_error` / `budget` / `input_required`）
 *      统一附带现场 `candidates`（含 `ref`）与 `pageText`，让上游 LLM 无需再调一次 `browser_snapshot` 即可直接用 `browser_act` 接管。
 */

import type { JudgmentAnswer } from 'dsh-judgment/contract'
import { CliError, type ObservedPage, type Snapshot } from '../cli.js'
import { dialogBlocker, execute, fillFromInputs, waitForPageChange } from './actions.js'
import {
  addToCartTarget,
  candidatesFromExtracted,
  candidatesOf,
  withActionCandidates,
} from './candidates.js'
import {
  bestEmptyInputForGoal,
  fillThenSubmitGoal,
  finalNavigationClauseOf,
  FOLLOW_UP_VERBS,
  inputsApplied,
  inputMatchesOf,
  isAlreadySatisfied,
  isTextEntry,
  looksLikeErrorPage,
  namedSubmitGoal,
  pendingFieldOf,
  pickAlternate,
  selectionMatchesGoal,
  singleStepGoal,
  soleValueFor,
  specificallyNamed,
  stateOf,
  submitControlOf,
  urlChangeMatchesGoal,
} from './gates.js'
import {
  askJudge,
  confirmGoal,
  isInvalidResponse,
  nextJudgeOptionCap,
  pickSelectOption,
  questionsOf,
  validationOf,
} from './judge.js'
import {
  ALTERNATE_MIN_PROBABILITY,
  AMBIGUOUS_CONFIDENCE,
  AMBIGUOUS_GAP,
  CONFIRM_TEXT_CAP,
  CONTROL_CANDIDATES,
  DISABLE_VERBS,
  ENABLE_VERBS,
  EXPECTED_API_VERSION,
  IRREVERSIBLE_THRESHOLD,
  JUDGE_OPTION_CAP,
  JudgeUnavailableError,
  LIKELY_CONFIRM_FLOOR,
  LIKELY_DONE_FLOOR,
  LOADING_TEXT_MARK,
  LOGIN_THRESHOLD,
  MAX_REFILLS,
  MAX_RESAMPLES,
  MIN_PAGE_TEXT,
  NAVIGATION_GOALS,
  NEXT_HINTS,
  PAGE_ERROR_THRESHOLD,
  SEARCH_GOALS,
  SECRET_KEY,
  SNAPSHOT_STATE_CAP,
  WAIT_BUDGET,
  type LastChange,
  type TaskCandidate,
  type TaskDeps,
  type TaskResult,
  type TaskStatus,
  type TaskStep,
  type TaskSubgoal,
} from './types.js'
import {
  clipHeadTail,
  diffCandidates,
  expandedGoalTokensOf,
  goalMentions,
  goalTokensOf,
  interactionSignature,
  keysWantedByGoal,
  message,
  now,
  sleep,
  stableHash,
  stateChanged,
  wantsDrag,
  wantsHover,
} from './utils.js'

/** 需要附带现场 `candidates`（含 `ref`）与 `pageText` 交回上游 LLM 接管的状态。 */
const HANDOFF_STATUSES = new Set<TaskStatus>([
  'ambiguous',
  'no_progress',
  'blocked',
  'page_error',
  'budget',
  'input_required',
  'needs_confirmation',
  'needs_login',
])

export async function runTask(goal: string, deps: TaskDeps): Promise<TaskResult> {
  const steps: TaskStep[] = []
  const trace: string[] = []
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0 }
  const timings = { snapshotMs: 0, readMs: 0, titleMs: 0, askMs: 0, actMs: 0, startedAt: now() }

  if (goal.trim() === '') throw new JudgeUnavailableError('browser_run 需要 goal')
  if (deps.judge === undefined) {
    throw new JudgeUnavailableError(
      '决策已开启，但 ctx.judgment 不在：请在「插件」里安装 dsh-judgment 并重启 DSH；' +
      '或在「设置 → 浏览器」里关掉决策，用原子工具让主模型逐步驱动。',
    )
  }
  if (deps.judge.apiVersion !== EXPECTED_API_VERSION) {
    throw new JudgeUnavailableError(
      `ctx.judgment 的契约版本是 ${deps.judge.apiVersion}，本插件按 ${EXPECTED_API_VERSION} 编译：` +
      '版本不兼容时降级是显式行为，不假装还能判断（请升级插件或 dsh-judgment）',
    )
  }
  const judge = deps.judge

  let last: Snapshot | undefined
  let lastPageText = ''
  let lastCandidates: readonly TaskCandidate[] = []
  let initialOrigin: string | undefined

  if (typeof deps.browser.waitForReady === 'function') {
    await deps.browser.waitForReady({ signal: deps.signal, timeoutMs: 2500 }).catch(() => false)
  }

  let delivered:
    | { id: string; snapshot: Snapshot; textSample?: string; selector?: string; navigational?: boolean }
    | undefined
  const stalled = new Map<string, number>()
  let attempted = new Set<string>()
  let staleStreak = 0
  let actionFailures = 0
  let waits = 0
  let previousObservation: { candidates: readonly TaskCandidate[]; text: string; origin: string } | undefined
  const filledFields = new Map<string, string>()
  const verifiedFills = new Set<string>()
  const refillCounts = new Map<string, number>()
  const refillExhausted = new Set<string>()
  /** 已经通过按 Enter 提交消费掉的字段 id（当调用方给的所有值都用完后，该字段不再重填）。 */
  const consumedByEnter = new Set<string>()
  /** 已经通过按 Enter 提交消费掉的具体值（当单个输入框需要依次填入 first/second 多个值时按值区分）。 */
  const consumedValues = new Set<string>()
  let fillMismatches = 0
  let lastActionWasText = false
  let lastFilledFieldId: string | undefined
  let lastSubmitAction: { id: string; name: string } | undefined
  let lastAddToCart: { id: string; name: string } | undefined
  let lastDismissAction: { id: string; name: string } | undefined
  let lastSelectedOption: { id: string; name: string } | undefined
  let lastEnterAddedValue: string | undefined
  let lastFilterLinkClick: { id: string; name: string } | undefined
  let lastSortHeaderClick: { id: string; name: string } | undefined
  let lastKeyPressAction: string | undefined
  let awaitedLoading: { text: string } | undefined
  let lastJsClick: { id: string; ref: string } | undefined
  const jsClickRetried = new Set<string>()
  const useless = new Set<string>()
  let reroutes = 0
  let filledSecret = false

  for (let step = 1; step <= deps.maxSteps; step += 1) {
    if (deps.signal.aborted) return finish('budget', 'cancelled', last)

    // 0) 卡住的 JS 对话框（alert/confirm/prompt）
    const blocking = await dialogBlocker(deps.browser, deps.signal)
    if (blocking !== undefined) {
      const accept = /(accept|confirm|ok|yes|确定|确认|同意|接受)/i.test(goal)
      await deps.browser.run(['dialog', accept ? 'accept' : 'dismiss'], { signal: deps.signal }).catch(() => {})
      trace.push('第 ' + step + ' 步：页面有 JS 对话框（"' + blocking + '"）→ 已' + (accept ? '接受' : '关闭'))
      continue
    }

    // 1) 观察当前页面（优先页面内抽取，必要时退回整树）
    const observeOnce = async (depth?: number): Promise<ObservedPage> => {
      const started = now()
      try {
        if (typeof deps.browser.observe === 'function') {
          return await deps.browser.observe(
            { interactiveOnly: true, ...(depth === undefined ? {} : { depth }) },
            { signal: deps.signal },
          )
        }
        const snapshot = await deps.browser.snapshot(
          { interactiveOnly: true, ...(depth === undefined ? {} : { depth }) },
          { signal: deps.signal },
        )
        if (snapshot === undefined) throw new CliError('bad-output', '快照替身没有返回')
        const text = await deps.browser.read(undefined, { signal: deps.signal })
        const title = await deps.browser.get('title', undefined, undefined, { signal: deps.signal }).catch(() => '')
        return { ...snapshot, text, title: String(title) }
      } finally {
        timings.snapshotMs += now() - started
      }
    }
    const observe = async (): Promise<ObservedPage> => {
      let lastError: unknown
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          return await observeOnce()
        } catch (error) {
          lastError = error
          if (attempt < 3) await sleep(40 * attempt)
        }
      }
      trace.push(`第 ${step} 步：观察连续失败（${message(lastError)}）→ 降深度（depth=8）再试一次`)
      return observeOnce(8)
    }
    const observePage = async (): Promise<{
      snapshot: Snapshot
      candidates: TaskCandidate[]
      text: string
      prose: string
      title: string
      mode: 'extract' | 'tree'
      truncated?: boolean
    }> => {
      const useTree = async (): Promise<{
        snapshot: Snapshot
        candidates: TaskCandidate[]
        text: string
        prose: string
        title: string
        mode: 'extract' | 'tree'
      }> => {
        const observed = await observe()
        const trimmed = observed.text.replace(/\s+/g, ' ').trim()
        const visible = trimmed === '' ? observed.snapshot : observed.text
        const snapshot: Snapshot = { ...observed, textDigest: stableHash(visible.replace(/\s+/g, ' ').trim()) }
        return {
          snapshot,
          candidates: withActionCandidates(candidatesOf(snapshot, goal), goal, step, trace),
          text: visible,
          prose: trimmed === '' ? observed.snapshot : observed.text,
          title: observed.title,
          mode: 'tree',
        }
      }
      if (typeof deps.browser.extract !== 'function') return useTree()
      try {
        const started = now()
        const page = await deps.browser.extract({
          signal: deps.signal,
          includeMedia: wantsHover(goal) || wantsDrag(goal) || /(image|picture|photo|图|头像|avatar)/i.test(goal),
        })
        timings.snapshotMs += now() - started
        const controls = lastActionWasText
          ? CONTROL_CANDIDATES
          : CONTROL_CANDIDATES.filter((candidate) => candidate.id !== 'control:press_enter')
        const candidates = withActionCandidates([...candidatesFromExtracted(page.items, goal), ...controls], goal, step, trace)
        const pageCandidates = candidates.filter((candidate) => candidate.kind !== 'control')
        const mediaGoal = wantsHover(goal) || wantsDrag(goal)
        if (!mediaGoal && pageCandidates.length > 0) {
          const roleNouns: Record<string, string[]> = {
            checkbox: ['checkbox', 'switch'],
            radio: ['radio'],
            dropdown: ['combobox', 'option'],
            combobox: ['combobox'],
            slider: ['slider'],
            input: ['textbox', 'searchbox', 'combobox', 'input', 'textarea'],
            field: ['textbox', 'searchbox', 'combobox', 'input', 'textarea'],
            textbox: ['textbox', 'searchbox', 'input', 'textarea'],
            textarea: ['textbox', 'textarea'],
          }
          const wantedRoles = Object.entries(roleNouns)
            .filter(([noun]) => new RegExp(`\\b${noun}s?\\b`, 'i').test(goal))
            .flatMap(([, roles]) => roles)
          const roleMissing =
            wantedRoles.length > 0 &&
            !pageCandidates.some((candidate) => wantedRoles.includes((candidate.role ?? '').toLowerCase()))
          if (roleMissing) {
            trace.push(
              `第 ${step} 步：抽取结果缺少目标要求的控件角色（${[...new Set(wantedRoles)].join('/')}，可能位于 Shadow DOM 或 iframe 内）→ 退回整树观察`,
            )
            return useTree()
          }
        }
        const extractable = candidates.filter((candidate) => candidate.kind !== 'control')
        if (extractable.length === 0) {
          trace.push(`第 ${step} 步：页面内抽取没有可用元素（${page.items.length} 个元素）→ 退回整树观察`)
          return useTree()
        }
        const compact = candidates
          .map((candidate) =>
            `${candidate.role ?? ''} ${candidate.name ?? ''}${candidate.state === undefined || candidate.state === '' ? '' : `（${candidate.state}）`}`.trim(),
          )
          .join('\n')
        const refs: Record<string, { name: string; role: string; clickable?: boolean }> = {}
        for (const item of page.items) refs[String(item.index)] = { name: item.name, role: item.role, clickable: true }
        const trimmed = page.text.replace(/\s+/g, ' ').trim()
        // 带状态摘要（已勾选/未勾选/当前值/已有内容）的控件行一并附在正文尾部：
        // 避免正文 ≥40 字时 page_text 里完全看不到 checkbox 勾选状态（真机 ti-checkboxes）。
        const statefulLines = pageCandidates
          .filter((candidate) => (candidate.state ?? '') !== '' && !((candidate.state ?? '').startsWith('链接:')))
          .slice(0, 12)
          .map((candidate) => `${candidate.role ?? ''} ${candidate.name ?? ''}（${candidate.state}）`.trim())
          .join('\n')
        const baseText = trimmed === '' ? compact : trimmed.length >= MIN_PAGE_TEXT ? page.text : `${trimmed}\n${compact}`
        const combinedText = statefulLines !== '' && !baseText.includes(statefulLines) ? `${baseText}\n${statefulLines}` : baseText
        const snapshot: Snapshot = {
          origin: page.url,
          snapshot: compact,
          refs,
          removedRefs: [],
          digest: stableHash(compact),
          textDigest: stableHash(combinedText.replace(/\s+/g, ' ').trim()),
        }
        const covered = page.items.filter((item) => item.covered).length
        trace.push(
          `第 ${step} 步：页面内抽取 ${page.items.length} 个元素（跳过被遮挡 ${covered} 个）→ ${candidates.length} 个候选` +
          (page.truncated === true ? '（已达 300 上限，页面更大：目标可能没被抽到）' : ''),
        )
        return {
          snapshot,
          candidates,
          text: combinedText,
          prose: trimmed,
          title: page.title,
          mode: 'extract',
          truncated: page.truncated === true,
        }
      } catch (error) {
        trace.push(`第 ${step} 步：页面内抽取失败（${message(error)}）→ 退回整树观察`)
        return useTree()
      }
    }

    let observedPage = await observePage()
    initialOrigin ??= observedPage.snapshot.origin
    if (delivered !== undefined) {
      await sleep(40)
      const settledAgain = await observePage()
      if (stateChanged(observedPage.snapshot, settledAgain.snapshot)) {
        observedPage = settledAgain
      } else if (delivered.navigational === true) {
        const shifted = typeof deps.browser.waitForPageShift === 'function'
          ? await deps.browser
              .waitForPageShift(
                {
                  url: observedPage.snapshot.origin,
                  textSample: delivered.textSample ?? '',
                },
                { signal: deps.signal, timeoutMs: 4000 },
              )
              .catch(() => false)
          : false
        if (shifted) {
          if (delivered !== undefined) trace.push(`第 ${step} 步：点击后页面在跳转 → 事件驱动等待到变化再观察`)
          observedPage = await observePage()
        }
      }
    }
    const snapshot: Snapshot = observedPage.snapshot
    const pageText = observedPage.text
    const pageTitle = observedPage.title
    const extractionTruncated = observedPage.truncated === true
    last = snapshot
    lastPageText = pageText
    lastCandidates = observedPage.candidates

    // 登录/表单已翻页的确定性判定
    const textFieldStillOpen = observedPage.candidates.some(
      (candidate) =>
        candidate.kind === 'input' &&
        ['textbox', 'searchbox', 'textarea', 'input'].includes((candidate.role ?? '').toLowerCase()),
    )
    const loginOnly =
      /(log ?in|sign ?in|登录|登陆)/i.test(goal) &&
      !/(buy|purchase|checkout|order|add|cart|submit|fill|type|search|open|go to|complete|pay|delete|remove)/i.test(goal)
    if (filledSecret && loginOnly && singleStepGoal(goal) && !textFieldStillOpen) {
      trace.push(`第 ${step} 步：密钥字段已填、页面已无输入框（地址 ${snapshot.origin}）→ 表单已提交，交回宿主校验`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:form_submitted', executed: false, reason: 'form_submitted' })
      return finish('needs_verification', '密钥字段已填且表单已翻页', snapshot)
    }

    const lastExecuted = steps.length > 0 && steps[steps.length - 1].executed === true
    const lastChange: LastChange | undefined =
      previousObservation !== undefined && lastExecuted
        ? diffCandidates(
            previousObservation.candidates,
            observedPage.candidates,
            previousObservation.text,
            pageText,
            previousObservation.origin,
            snapshot.origin,
          )
        : undefined
    previousObservation = { candidates: observedPage.candidates, text: pageText, origin: snapshot.origin }

    // 加载中就先等（含 ti-dynamic-controls 的 "Wait for it..."）
    if (
      waits < WAIT_BUDGET &&
      LOADING_TEXT_MARK.test(observedPage.prose) &&
      steps.some((item) => item.executed)
    ) {
      trace.push(`第 ${step} 步：页面在加载 → 先等它变化（不重复点击）`)
      awaitedLoading = { text: observedPage.prose }
      await waitForPageChange(deps.browser, deps.signal)
      waits += 1
      continue
    }
    if (awaitedLoading !== undefined) {
      const changedAfterLoading = observedPage.prose !== awaitedLoading.text
      const errorAfterLoading = /(error|failed|错误|失败|invalid|异常)/i.test(observedPage.prose)
      // 只有在目标不需要后续填值（如 dynamic-loading）时才直接按加载完成收尾；
      // 若目标还要填值（如 ti-dynamic-controls "Enable the text field, then type into it"），继续往下走填值。
      const stillNeedsInput = deps.inputs !== undefined && Object.keys(deps.inputs).length > 0 && !steps.some((item) => item.reason === 'filled_from_inputs')
      if (changedAfterLoading && !errorAfterLoading && !stillNeedsInput) {
        trace.push(`第 ${step} 步：加载结束且正文出现新内容（${observedPage.prose.replace(/\s+/g, ' ').trim().slice(0, 80)}）→ 停，交回宿主校验`)
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:loading_finished', executed: false, reason: 'loading_finished' })
        return finish('needs_verification', '加载完成且页面出现了新内容', snapshot)
      }
      if (errorAfterLoading) trace.push(`第 ${step} 步：加载结束但出现了错误/失败提示 → 不按完成收尾`)
      awaitedLoading = undefined
    }

    const filledThisRun = steps.some((item) => item.reason === 'filled_from_inputs')
    const dataEntryGoal = /\b(fill|type|enter|choose|select|set)\b|输入|填写|选择/i.test(goal)
    const lastFillStep = filledThisRun ? [...steps].reverse().find((item) => item.reason === 'filled_from_inputs')?.step : undefined
    const executedAfterFill =
      lastFillStep === undefined
        ? false
        : steps.some((item) => item.executed && item.step > lastFillStep && item.reason !== 'filled_from_inputs')
    const evidenceNeedsFill = dataEntryGoal && (!filledThisRun || !executedAfterFill)

    // 导航类目标的确定性证据（支持单步导航以及 "Open the cart and go to checkout" 这类纯多跳导航的末跳）
    const navEligible = singleStepGoal(goal) || finalNavigationClauseOf(goal) !== undefined
    if (navEligible && pageText.length >= MIN_PAGE_TEXT && !looksLikeErrorPage(pageText, pageTitle)) {
      const urlHit = urlChangeMatchesGoal(goal, initialOrigin ?? snapshot.origin, snapshot.origin)
      if (urlHit !== undefined) {
        trace.push(`第 ${step} 步：地址新增段命中目标词「${urlHit}」（${snapshot.origin.slice(0, 240)} · mode=${observedPage.mode} · 正文 ${pageText.length} 字）→ 停，交回宿主校验`)
        if (evidenceNeedsFill) {
          trace.push(`第 ${step} 步：地址命中「${urlHit}」，但目标要求填值且这一步还没填过 → 不按完成收尾`)
        } else {
          steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:url_matched', executed: false, reason: 'url_matched' })
          return finish('needs_verification', `地址已命中目标「${urlHit}」`, snapshot)
        }
      }
    }

    // 点过弹层关闭控件、该控件确实从页面消失 → 弹层已关
    if (lastDismissAction !== undefined && lastChange !== undefined) {
      const stillThere = observedPage.candidates.some(
        (candidate) => (candidate.name ?? '').trim() === (lastDismissAction?.name ?? '').trim(),
      )
      if (!stillThere) {
        trace.push(`第 ${step} 步：点过「${lastDismissAction.name}」后该控件消失 → 弹层已关，交回宿主校验`)
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: lastDismissAction.id, executed: true, reason: 'dismissed_overlay' })
        return finish('needs_verification', `已关闭「${lastDismissAction.name}」`, snapshot)
      }
    }
    lastDismissAction = undefined

    // 自定义下拉框（如 react-select）点过与目标匹配的 option 且页面已变化 → 收尾
    if (lastSelectedOption !== undefined && lastChange !== undefined) {
      trace.push(`第 ${step} 步：已点击下拉选项「${lastSelectedOption.name}」且页面已变化 → 停，交回宿主校验`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: lastSelectedOption.id, executed: true, reason: 'option_selected' })
      return finish('needs_verification', `已选择「${lastSelectedOption.name}」`, snapshot)
    }
    lastSelectedOption = undefined

    // 新建条目目标（如 TodoMVC "Add a new todo item that says 'buy milk'"）：
    // 上一步按 Enter 提交后，新出现的控件里已经包含刚填入的文字 → 条目已创建，收尾。
    if (
      lastEnterAddedValue !== undefined &&
      singleStepGoal(goal) &&
      /^\s*(?:add|create)\b|^(?:添加|新建)/i.test(goal) &&
      Array.isArray(lastChange?.added) &&
      lastChange.added.some((desc) => desc.toLowerCase().includes(lastEnterAddedValue!.toLowerCase()))
    ) {
      trace.push(`第 ${step} 步：按 Enter 后页面新增了「${lastEnterAddedValue}」对应控件 → 条目已添加，交回宿主校验`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'control:press_enter', executed: false, reason: 'item_added_by_enter' })
      return finish('needs_verification', `已添加「${lastEnterAddedValue}」`, snapshot)
    }
    lastEnterAddedValue = undefined

    // 筛选/标签切换链接（如 TodoMVC "Show only the completed todos" 点击 Completed 跳到 #/completed）：
    // 要求页面上仍有当前视图对应的条目控件（避免前序步骤没勾上、跳到空列表却假完成）。
    if (
      lastFilterLinkClick !== undefined &&
      singleStepGoal(goal) &&
      lastChange?.url_changed === true &&
      snapshot.origin.toLowerCase().includes(lastFilterLinkClick.name.toLowerCase()) &&
      observedPage.candidates.some((candidate) => candidate.role === 'checkbox')
    ) {
      trace.push(`第 ${step} 步：已点击「${lastFilterLinkClick.name}」且地址变为 ${snapshot.origin} → 停，交回宿主校验`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: lastFilterLinkClick.id, executed: false, reason: 'filter_link_applied' })
      return finish('needs_verification', `已切换到「${lastFilterLinkClick.name}」`, snapshot)
    }
    lastFilterLinkClick = undefined

    // 加入购物车 → 出现 Remove/移除
    if (lastAddToCart !== undefined && lastChange !== undefined) {
      const removal = observedPage.candidates.find((candidate) =>
        /^(?:remove|remove from cart)\b|^(?:移除|删除)/i.test((candidate.name ?? '').trim()),
      )
      if (removal !== undefined) {
        trace.push(`第 ${step} 步：点过「${lastAddToCart.name}」后出现「${removal.name}」→ 商品已进购物车，交回宿主校验`)
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: lastAddToCart.id, executed: true, reason: 'cart_item_added' })
        return finish('needs_verification', '购物车已出现 Remove/移除 控件', snapshot)
      }
    }
    lastAddToCart = undefined

    // 目标点名的提交类控件已经点过、且页面确实变了 → 这一步的意图达成
    if (lastSubmitAction !== undefined && lastChange !== undefined) {
      const applied =
        lastChange.url_changed === true ||
        lastChange.text_changed === true ||
        lastChange.added !== undefined ||
        lastChange.removed !== undefined ||
        lastChange.changed !== undefined
      const treeSubmitAllowed = observedPage.mode === 'tree' && filledThisRun && pageText.length >= MIN_PAGE_TEXT
      if (applied && (observedPage.mode === 'extract' || treeSubmitAllowed) && !looksLikeErrorPage(pageText, pageTitle) && evidenceNeedsFill) {
        trace.push(`第 ${step} 步：「${lastSubmitAction.name}」是目标点名的提交控件且页面已变化，但目标要求填值且还没填过 → 不按完成收尾`)
      } else if (applied && (observedPage.mode === 'extract' || treeSubmitAllowed) && !looksLikeErrorPage(pageText, pageTitle)) {
        trace.push(`第 ${step} 步：「${lastSubmitAction.name}」是目标点名的提交控件且页面已变化 → 停，交回宿主校验`)
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: lastSubmitAction.id, executed: false, reason: 'named_submit_applied' })
        return finish('needs_verification', `已执行目标点名的提交控件「${lastSubmitAction.name}」且页面已变化`, snapshot)
      }
    }
    lastSubmitAction = undefined

    // 表头排序（如 ti-sort-table "Sort the first table by Last Name"）：
    // 上一步点击了点名的 columnheader 且表格正文已发生变化 → 收尾，省去多余的 Jev 轮次与 confirm 调用。
    if (lastSortHeaderClick !== undefined && lastChange?.text_changed === true) {
      trace.push(`第 ${step} 步：已点击排序表头「${lastSortHeaderClick.name}」且表格内容已重排 → 停，交回宿主校验`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: lastSortHeaderClick.id, executed: false, reason: 'table_sorted' })
      return finish('needs_verification', `已按「${lastSortHeaderClick.name}」排序`, snapshot)
    }
    lastSortHeaderClick = undefined

    // 显式按键目标（如 key-press "Press the Escape key"）：
    // 上一步执行了目标点名的按键且页面内容已变化 → 收尾。
    if (
      lastKeyPressAction !== undefined &&
      singleStepGoal(goal) &&
      lastChange !== undefined &&
      (lastChange.text_changed === true || lastChange.added !== undefined || lastChange.removed !== undefined)
    ) {
      trace.push(`第 ${step} 步：已执行目标点名的按键 ${lastKeyPressAction} 且页面内容已变化 → 停，交回宿主校验`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: lastKeyPressAction, executed: false, reason: 'key_press_applied' })
      return finish('needs_verification', `已执行按键 ${lastKeyPressAction}`, snapshot)
    }
    lastKeyPressAction = undefined

    // 关键修复：followUpEvidence 必须要求填值后至少执行过一次非填值动作（executedAfterFill），
    // 否则打字触发自动补全下拉（lastChange.added/text_changed）就会在按 Enter 前被误判为"后续动作已生效"（github-issue-search 假完成根因）。
    const followUpNeeded = FOLLOW_UP_VERBS.test(goal) && filledThisRun
    const followUpEvidence =
      executedAfterFill &&
      lastChange !== undefined &&
      (lastChange.url_changed === true || lastChange.added !== undefined || lastChange.removed !== undefined || lastChange.text_changed === true)
    const followUpPending = followUpNeeded && !followUpEvidence

    const lastExecutedStep = [...steps].reverse().find((item) => item.executed)
    const lastDescription =
      lastExecutedStep === undefined
        ? undefined
        : observedPage.candidates.find((candidate) => candidate.id === lastExecutedStep.action)?.description ??
          previousObservation?.candidates.find((candidate) => candidate.id === lastExecutedStep.action)?.description

    const confirmWithContext = (): Promise<{ confirmed: boolean; probability: number }> =>
      confirmGoal(judge, deps, snapshot, goal, usage, trace, {
        ...(lastExecutedStep === undefined ? {} : { lastAction: lastExecutedStep.action }),
        ...(lastDescription === undefined ? {} : { lastActionDescription: lastDescription }),
        ...(lastChange === undefined ? {} : { lastChange }),
        ...(observedPage.mode === 'extract' ? { existingPageText: pageText, existingPageTitle: pageTitle } : {}),
      })

    let candidates = observedPage.candidates
    if (waits >= WAIT_BUDGET) candidates = candidates.filter((candidate) => candidate.id !== 'control:wait')
    const allCandidates = candidates

    // 状态守卫：已处于目标状态的候选不再发给判断层
    const satisfied = candidates.filter((candidate) => isAlreadySatisfied(candidate, goal, deps.inputs))
    if (satisfied.length > 0) {
      const names = satisfied.slice(0, 3).map((candidate) => candidate.name ?? candidate.id).join('、')
      trace.push(`第 ${step} 步：${satisfied.length} 个候选已处于目标状态（${names}${satisfied.length > 3 ? '…' : ''}）→ 跳过`)
      candidates = candidates.filter((candidate) => !satisfied.includes(candidate))
      if (candidates.filter((candidate) => candidate.kind !== 'control').length === 0) {
        trace.push(`第 ${step} 步：可操作元素都已满足目标状态 → 停在待验证（交回宿主复核）`)
        return finish('needs_verification', '目标涉及的元素已处于目标状态', snapshot)
      }
      // 勾选/单选类目标确定性收尾：本轮已执行过动作、无后续动作待办、且目标点名的所有 checkbox/radio 均已处于满足状态（如 ti-checkboxes / todomvc step3 / webform-fine radio）
      const checkGoal =
        (ENABLE_VERBS.test(goal) || DISABLE_VERBS.test(goal) || /\b(select|choose|pick)\b[^.]{0,40}\bradio\b/i.test(goal)) &&
        !FOLLOW_UP_VERBS.test(goal) &&
        deps.inputs === undefined
      if (checkGoal && steps.some((item) => item.executed)) {
        const allToggles = allCandidates.filter(
          (candidate) => candidate.role === 'checkbox' || candidate.role === 'radio' || candidate.role === 'switch',
        )
        const remainingToggles = candidates.filter(
          (candidate) => candidate.role === 'checkbox' || candidate.role === 'radio' || candidate.role === 'switch',
        )
        const matchesToggleTarget = (candidate: TaskCandidate): boolean => {
          const role = (candidate.role ?? '').toLowerCase()
          if (/\bradio\b/i.test(goal) && !/\bcheckbox\b/i.test(goal) && role !== 'radio') return false
          if (/\bcheckbox\b/i.test(goal) && !/\bradio\b/i.test(goal) && role !== 'checkbox') return false
          const desc = candidate.description.toLowerCase()
          if (
            (/\b(first|1st)\b|第一|首个/i.test(goal) && desc.includes(' #') && !desc.includes(' #1')) ||
            (/\b(second|2nd)\b|第二/i.test(goal) && desc.includes(' #') && !desc.includes(' #2')) ||
            (/\b(third|3rd)\b|第三/i.test(goal) && desc.includes(' #') && !desc.includes(' #3'))
          ) {
            return false
          }
          if ((candidate.name ?? '') !== '' && goalMentions(candidate.name ?? '', goal)) return true
          if (desc.includes(' #1') && /\b(first|1st)\b|第一|首个/i.test(goal)) return true
          if (desc.includes(' #2') && /\b(second|2nd)\b|第二/i.test(goal)) return true
          if (desc.includes(' #3') && /\b(third|3rd)\b|第三/i.test(goal)) return true
          return false
        }
        const satisfiedMatchesGoal = satisfied.some(matchesToggleTarget)
        const remainingMatchesGoal = remainingToggles.some(matchesToggleTarget)
        if (allToggles.length > 0 && (remainingToggles.length === 0 || (satisfiedMatchesGoal && !remainingMatchesGoal))) {
          trace.push(`第 ${step} 步：目标涉及的勾选控件已全部处于目标状态 → 停，交回宿主校验`)
          steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:toggles_satisfied', executed: false, reason: 'toggles_satisfied' })
          return finish('needs_verification', '目标涉及的勾选状态已达成', snapshot)
        }
      }
    }

    // 已按同值填过的字段不再进候选（含按 Enter 已提交消费的字段）
    const refilled = candidates.filter((candidate) => {
      const done = filledFields.get(candidate.id)
      if (done === undefined) return false
      if (consumedByEnter.has(candidate.id)) return true
      const state = stateOf(candidate)
      return state.redacted === true || state.value === done || state.checked === /^(1|true|yes|on|y|是)$/i.test(done)
    })
    if (refilled.length > 0) {
      trace.push(`第 ${step} 步：${refilled.length} 个字段已按调用方的值填过（${refilled.map((candidate) => candidate.name ?? candidate.id).join('、')}）→ 跳过`)
      candidates = candidates.filter((candidate) => !refilled.includes(candidate))
    }

    const actionable = candidates.filter((candidate) => candidate.kind !== 'control')
    if (actionable.length === 0) {
      if (looksLikeErrorPage(pageText, pageTitle)) {
        trace.push(`第 ${step} 步：页面是浏览器错误页（导航失败）→ 停，交回宿主`)
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:error_page', executed: false, reason: 'error_page' })
        return finish('page_error', '页面是浏览器错误页（导航失败）', snapshot)
      }
      const confirmed = await confirmWithContext()
      const navigatedToTerminal = lastChange?.url_changed === true && NAVIGATION_GOALS.test(goal)
      if (navigatedToTerminal && confirmed.probability >= 0.8) {
        trace.push(`第 ${step} 步：已跳到没有可操作元素的终态页（跳转证据 + 独立确认 p=${confirmed.probability.toFixed(2)}）→ 停，交回宿主校验`)
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:terminal_page', executed: false, reason: 'terminal_page' })
        return finish('needs_verification', `页面已跳转到终态（无可操作元素，确认 p=${confirmed.probability.toFixed(2)}）`, snapshot)
      }
      trace.push(`第 ${step} 步：页面上没有可操作的元素（独立确认 p=${confirmed.probability.toFixed(2)}，不作为完成依据）→ 停`)
      return finish('no_progress', '页面上没有可操作的元素', snapshot)
    }

    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const lastDeliveredId = delivered?.id
    if (delivered !== undefined && stateChanged(delivered.snapshot, snapshot)) {
      delivered = undefined
      stalled.clear()
      attempted = new Set()
    }

    // 拖拽与悬停的确定性收尾：上一步执行了 drag:* 或 hover:* 且页面内容/结构已变化 → 收尾（不必再花一次 Jev 调用）
    if (
      lastDeliveredId !== undefined &&
      lastDeliveredId.startsWith('drag:') &&
      lastChange !== undefined &&
      (lastChange.text_changed === true || lastChange.added !== undefined || lastChange.removed !== undefined)
    ) {
      trace.push(`第 ${step} 步：拖拽后页面发生变化 → 停，交回宿主校验`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: lastDeliveredId, executed: true, reason: 'drag_applied' })
      return finish('needs_verification', '拖拽后页面发生变化', snapshot)
    }
    if (
      lastDeliveredId !== undefined &&
      lastDeliveredId.startsWith('hover:') &&
      lastChange !== undefined &&
      (lastChange.text_changed === true || lastChange.added !== undefined)
    ) {
      trace.push(`第 ${step} 步：悬停后页面出现新内容 → 停，交回宿主校验`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: lastDeliveredId, executed: true, reason: 'hover_applied' })
      return finish('needs_verification', '悬停后页面发生变化', snapshot)
    }

    const truncated = snapshot.snapshot.length > SNAPSHOT_STATE_CAP
    const batchAskTargetMatch =
      lastChange !== undefined &&
      lastDescription !== undefined &&
      !(lastExecutedStep?.action ?? '').startsWith('control:')
    const state = {
      goal,
      url: snapshot.origin,
      snapshot: truncated ? `${snapshot.snapshot.slice(0, SNAPSHOT_STATE_CAP)}\n…（已截断）` : snapshot.snapshot,
      snapshot_chars: snapshot.snapshot.length,
      snapshot_truncated: truncated,
      ...(extractionTruncated ? { extraction_truncated: true } : {}),
      page_text: clipHeadTail(
        extractionTruncated
          ? `${pageText}\n（候选已达 300 个元素上限：页面上还有更多可操作元素没列出来，目标控件可能不在候选里）`
          : pageText,
        CONFIRM_TEXT_CAP,
      ),
      page_title: String(pageTitle).slice(0, 300),
      ...(lastChange === undefined ? {} : { last_change: lastChange }),
      ...(batchAskTargetMatch && lastExecutedStep !== undefined ? { last_action: lastExecutedStep.action, last_action_description: lastDescription } : {}),
      history: steps.slice(-8).map((item) => ({ action: item.action, executed: item.executed, reason: item.reason })),
      wall_clock_utc: new Date().toISOString(),
    }

    const allInputsAlreadyApplied =
      deps.inputs !== undefined &&
      Object.keys(deps.inputs).length > 0 &&
      inputsApplied(allCandidates, deps.inputs, filledFields, goal, verifiedFills) &&
      Object.values(deps.inputs).every((val) => consumedValues.has(val) || [...filledFields.values()].includes(val) || allCandidates.some((c) => stateOf(c).value === val))

    // 2) 一次批量判断
    const askOnce = async (subset: readonly TaskCandidate[]): Promise<Readonly<Record<string, JudgmentAnswer>>> => {
      const askStarted = now()
      const result = await askJudge(
        judge,
        state,
        questionsOf(goal, subset, allInputsAlreadyApplied ? undefined : deps.inputs, {
          hasLastChange: lastChange !== undefined,
          askTargetMatch: batchAskTargetMatch,
        }),
        deps.purpose,
        trace,
      )
      timings.askMs += now() - askStarted
      usage.calls += 1
      usage.inputTokens += result.usage.inputTokens ?? 0
      usage.outputTokens += result.usage.outputTokens ?? 0
      return result.answers
    }
    let answers: Readonly<Record<string, JudgmentAnswer>>
    let askedCount = Math.min(candidates.length, JUDGE_OPTION_CAP)
    let offered: readonly TaskCandidate[] = candidates

    const typingGoal = /(输入|填写|填|搜索|查询|type|fill|search|enter|query|set)/i.test(goal)
    const singleInput = actionable[0]
    const singleInputNamed =
      singleInput !== undefined &&
      (singleInput.name ?? '') !== '' &&
      goalTokensOf(goal).some((token) => (singleInput.name ?? '').toLowerCase().includes(token))
    const singleInputBypass =
      actionable.length === 1 &&
      singleInput?.kind === 'input' &&
      !(singleInput.state ?? '').includes('已禁用') &&
      (deps.inputs === undefined || Object.keys(deps.inputs).length === 1) &&
      (typingGoal || singleInputNamed)
    if (singleInputBypass) {
      const only = actionable[0]
      trace.push(`第 ${step} 步：页面上只有一个输入框（${only.id}）→ 免判断，交回宿主填内容`)
      answers = { action: { kind: 'choice', optionId: only.id, probabilities: { [only.id]: 1 }, confidence: 1 } } as Readonly<Record<string, JudgmentAnswer>>
    } else {
      try {
        offered = candidates.filter((candidate) => !useless.has(candidate.id))
        if (offered.length < 2) offered = candidates
        if (offered.length !== candidates.length) trace.push(`第 ${step} 步：剔除 ${candidates.length - offered.length} 个已证明无效的候选（换路）`)
        answers = await askOnce(offered.slice(0, JUDGE_OPTION_CAP))
      } catch (error) {
        if (isInvalidResponse(error)) {
          let lastErr = error
          let recovered: Readonly<Record<string, JudgmentAnswer>> | undefined
          for (let attempt = 0; attempt < MAX_RESAMPLES; attempt += 1) {
            const size = nextJudgeOptionCap(lastErr, askedCount)
            const numbers = validationOf(lastErr)
            const facts =
              numbers.optionCount === undefined
                ? ''
                : `（候选 ${numbers.optionCount}${numbers.sum === undefined ? '' : `，Σp ${numbers.sum.toFixed(2)}`}${numbers.tolerance === undefined ? '' : `，容差 ${numbers.tolerance}`}）`
            trace.push(`第 ${step} 步：${askedCount} 个候选时分布不合法${facts} → 缩到 ${size} 个再采一次`)
            try {
              recovered = await askOnce(offered.slice(0, size))
              askedCount = size
              break
            } catch (again) {
              lastErr = again
              askedCount = size
            }
          }
          if (recovered === undefined) {
            trace.push(`判断失败（缩候选后仍没有合法响应）：${message(lastErr)}`)
            return finish('judge_error', message(lastErr), snapshot)
          }
          answers = recovered
        } else {
          trace.push(`判断失败：${message(error)}`)
          return finish('judge_error', message(error), snapshot)
        }
      }
    }

    const goalAnswer = answers.goal_done
    const stuckAnswer = answers.stuck
    const actionAnswer = answers.action
    const goalDoneRaw = goalAnswer?.kind === 'noul' ? goalAnswer.probability : undefined
    const doneChange = answers.done_change?.kind === 'noul' ? answers.done_change.probability : undefined
    const goalDone =
      lastChange === undefined || doneChange === undefined
        ? goalDoneRaw
        : Math.max(goalDoneRaw ?? 0, doneChange)
    const stuck = stuckAnswer?.kind === 'noul' ? stuckAnswer.probability : undefined
    const irreversible = answers.irreversible?.kind === 'noul' ? answers.irreversible.probability : undefined
    const pageError = answers.page_error?.kind === 'noul' ? answers.page_error.probability : undefined
    const loginNeeded = answers.login?.kind === 'noul' ? answers.login.probability : undefined
    const probabilities = actionAnswer?.kind === 'choice' ? actionAnswer.probabilities : undefined
    const confidence = actionAnswer?.kind === 'choice' ? actionAnswer.confidence : undefined

    trace.push(
      `第 ${step} 步：goal_done=${goalDone === undefined ? '—' : goalDone.toFixed(2)}` +
      ` stuck=${stuck === undefined ? '—' : stuck.toFixed(2)}` +
      (doneChange === undefined ? '' : ` done_change=${doneChange.toFixed(2)}`) +
      ` 候选=${candidates.length}` +
      (confidence === undefined ? '' : ` 置信=${confidence.toFixed(2)}`),
    )

    // 3) 停止门（在动作之前判定）
    const chosenForGate = actionAnswer?.kind === 'choice' ? byId.get(actionAnswer.optionId) : undefined
    const selectedValueKeyForGate =
      answers.value?.kind === 'choice' && answers.value.optionId.startsWith('value:')
        ? answers.value.optionId.slice('value:'.length)
        : undefined
    const chosenPending = (() => {
      if (allInputsAlreadyApplied) return undefined
      if (chosenForGate === undefined || chosenForGate.kind !== 'input') return undefined
      if (consumedByEnter.has(chosenForGate.id)) return undefined
      const wanted =
        inputMatchesOf(candidates, deps.inputs).get(chosenForGate.id)?.value ??
        (selectedValueKeyForGate === undefined ? undefined : deps.inputs?.[selectedValueKeyForGate])
      if (wanted === undefined) return undefined
      const stateVal = stateOf(chosenForGate)
      if (stateVal.redacted === true) return undefined
      if (stateVal.value === undefined) return chosenForGate
      if (stateVal.value.trim() === wanted.trim()) return undefined
      if (!specificallyNamed(chosenForGate, deps.inputs)) return undefined
      return chosenForGate
    })()
    const pendingField =
      pendingFieldOf(candidates, deps.inputs, goal, filledFields, refillExhausted, consumedByEnter, consumedValues) ?? chosenPending
    if (goalDone !== undefined && goalDone >= deps.goalThreshold && pendingField !== undefined) {
      trace.push(
        `第 ${step} 步：goal_done=${goalDone.toFixed(2)} 但「${pendingField.name ?? pendingField.role ?? pendingField.id}」` +
        `还没生效（${pendingField.state ?? '状态未知'}）→ 不结束，继续操作`,
      )
    }

    // 填充类目标的确定性收尾
    if (
      pendingField === undefined &&
      !FOLLOW_UP_VERBS.test(goal) &&
      inputsApplied(allCandidates, deps.inputs, filledFields, goal, verifiedFills)
    ) {
      trace.push(`第 ${step} 步：调用方给的值都已生效，且目标没有后续动作 → 停，交回宿主校验`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:inputs_applied', executed: false, reason: 'inputs_applied', ...(goalDone === undefined ? {} : { goalDone }) })
      return finish('needs_verification', '调用方给的值都已生效', snapshot)
    }
    if (followUpPending) {
      trace.push(`第 ${step} 步：目标是「填完还要${goal.match(FOLLOW_UP_VERBS)?.[0] ?? '继续'}」→ 还没有后续动作的证据，不按完成收尾`)
    }

    const effectiveGoalThreshold = singleStepGoal(goal) ? deps.goalThreshold : Math.max(deps.goalThreshold, 0.95)
    if (goalDone !== undefined && goalDone >= effectiveGoalThreshold && pendingField === undefined && !followUpPending) {
      const batchTargetMatchProb = answers.target_match?.kind === 'noul' ? answers.target_match.probability : undefined
      const batchTargetMatched = batchTargetMatchProb === undefined || batchTargetMatchProb >= 0.6
      const highConfidenceBatchConfirm =
        lastChange !== undefined &&
        goalDoneRaw !== undefined &&
        goalDoneRaw >= 0.92 &&
        doneChange !== undefined &&
        doneChange >= 0.90 &&
        batchTargetMatched &&
        pageText.length >= MIN_PAGE_TEXT
      const confirm = highConfidenceBatchConfirm
        ? { confirmed: true, probability: Math.min(goalDoneRaw, doneChange) }
        : await confirmWithContext()
      if (confirm.confirmed) {
        trace.push(
          `第 ${step} 步：goal_done=${goalDone.toFixed(2)} ≥ ${deps.goalThreshold}，` +
          `${highConfidenceBatchConfirm ? '主批次高置信直通确认' : '独立确认'} p=${confirm.probability.toFixed(2)} → 停，交回宿主校验`,
        )
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:goal_done', executed: false, reason: 'goal_reached', ...(goalDone === undefined ? {} : { goalDone }), ...(stuck === undefined ? {} : { stuck }), confirm: confirm.probability })
        return finish('needs_verification', `goal_done=${goalDone.toFixed(2)}，确认 p=${confirm.probability.toFixed(2)}`, snapshot)
      }
      trace.push(`第 ${step} 步：goal_done=${goalDone.toFixed(2)} 但独立确认没通过（p=${confirm.probability.toFixed(2)}）→ 不结束，继续推进`)
    }

    // likely_done（中间带）
    if (
      singleStepGoal(goal) &&
      goalDone !== undefined &&
      goalDone >= LIKELY_DONE_FLOOR &&
      goalDone < deps.goalThreshold &&
      pendingField === undefined &&
      !followUpPending &&
      steps.some((item) => item.executed)
    ) {
      const confirm = await confirmWithContext()
      if (confirm.probability >= LIKELY_CONFIRM_FLOOR) {
        trace.push(`第 ${step} 步：goal_done=${goalDone.toFixed(2)}（中间带）且确认 p=${confirm.probability.toFixed(2)} → likely_done，交回宿主验证`)
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:likely_done', executed: false, reason: 'likely_done', ...(goalDone === undefined ? {} : { goalDone }), confirm: confirm.probability })
        return finish('likely_done', `goal_done=${goalDone.toFixed(2)}，确认 p=${confirm.probability.toFixed(2)}：看起来完成，需验证`, snapshot)
      }
      trace.push(`第 ${step} 步：goal_done=${goalDone.toFixed(2)} 但确认只有 p=${confirm.probability.toFixed(2)} → 继续推进`)
    }

    // 登录墙
    if (
      loginNeeded !== undefined &&
      loginNeeded >= LOGIN_THRESHOLD &&
      deps.inputs === undefined &&
      !filledSecret
    ) {
      trace.push(`第 ${step} 步：页面是登录墙（p=${loginNeeded.toFixed(2)}），调用方没给凭据 → 交回用户`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:needs_login', executed: false, reason: 'needs_login' })
      return finish('needs_login', `需要先登录（p=${loginNeeded.toFixed(2)}）`, snapshot)
    }

    // 页面报错：若本步有明确待填的字段且本轮还没填过（如上一步误触了必填校验提示），先填值，不被遗留错误提前熔断。
    const canFillBeforeError = pendingField !== undefined && !filledThisRun
    if (pageError !== undefined && pageError >= PAGE_ERROR_THRESHOLD && !canFillBeforeError) {
      trace.push(`第 ${step} 步：页面显示错误（p=${pageError.toFixed(2)} ≥ ${PAGE_ERROR_THRESHOLD}）→ 停，交回宿主`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:page_error', executed: false, reason: 'page_error', ...(goalDone === undefined ? {} : { goalDone }), ...(stuck === undefined ? {} : { stuck }) })
      return finish('page_error', `页面显示错误（p=${pageError.toFixed(2)}）`, snapshot)
    }
    if (stuck !== undefined && stuck >= deps.stuckThreshold) {
      trace.push(`第 ${step} 步：stuck=${stuck.toFixed(2)} ≥ ${deps.stuckThreshold} → 停`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:stuck', executed: false, reason: 'stuck', ...(goalDone === undefined ? {} : { goalDone }), ...(stuck === undefined ? {} : { stuck }) })
      return finish('blocked', `stuck=${stuck.toFixed(2)}`, snapshot)
    }

    // 4) 弃答 = 中止
    if (actionAnswer === undefined || actionAnswer.kind !== 'choice') {
      const how = actionAnswer?.kind === 'abstain' ? `abstain(${actionAnswer.reason})` : 'missing'
      trace.push(`第 ${step} 步：判断没有给出动作（${how}）→ 中止，交回宿主`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:no_answer', executed: false, reason: `judge_${how}`, ...(goalDone === undefined ? {} : { goalDone }), ...(stuck === undefined ? {} : { stuck }) })
      return finish('blocked', '判断没有给出动作', snapshot)
    }

    let chosen = byId.get(actionAnswer.optionId)
    if (chosen === undefined) {
      trace.push(`第 ${step} 步：判断选了不存在的候选 "${actionAnswer.optionId}" → 中止（不"修复"）`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: `invalid:${actionAnswer.optionId}`, executed: false, reason: 'invalid_choice', ...(goalDone === undefined ? {} : { goalDone }), ...(stuck === undefined ? {} : { stuck }) })
      return finish('judge_error', `判断选了不存在的候选 "${actionAnswer.optionId}"`, snapshot)
    }

    // 确定性加购
    if (chosen.kind === 'click') {
      const cartTarget = addToCartTarget(goal, candidates)
      if (cartTarget !== undefined && cartTarget.id !== chosen.id) {
        trace.push(`第 ${step} 步：目标明确要加购「${cartTarget.name ?? cartTarget.id}」→ 改选它（判断层选了「${chosen.name ?? chosen.id}」）`)
        chosen = cartTarget
      }
    }

    // 搜索或无提交按钮的新建目标：刚填过输入框后优先按 Enter 提交（真机 wiki-search / todomvc）
    const hasAddOrSubmitButton = candidates.some(
      (candidate) =>
        candidate.kind === 'click' &&
        ( candidate.role === 'button' || candidate.tag === 'button') &&
        /\b(add|create|submit|save)\b|添加|新建|提交|保存/i.test(candidate.name ?? ''),
    )
    const wantsEnterAfterType =
      SEARCH_GOALS.test(goal) || (/\b(add|create)\b|添加|新建/i.test(goal) && !hasAddOrSubmitButton)
    if (wantsEnterAfterType && lastActionWasText && chosen.id !== 'control:press_enter') {
      const enter = candidates.find((candidate) => candidate.id === 'control:press_enter')
      if (enter !== undefined) {
        trace.push(`第 ${step} 步：目标要搜索/新建、刚填过输入框 → 按 Enter 提交搜索（判断层选了「${chosen.name ?? chosen.id}」）`)
        chosen = enter
      }
    }

    // 确定性填值优先（但刚填完文字且当前动作是按 Enter 提交时，不抢占 Enter）
    if (
      deps.inputs !== undefined &&
      Object.keys(deps.inputs).length > 0 &&
      chosen.kind !== 'input' &&
      !(lastActionWasText && chosen.id === 'control:press_enter')
    ) {
      const pending = pendingFieldOf(candidates, deps.inputs, goal, filledFields, refillExhausted, consumedByEnter, consumedValues)
      if (pending !== undefined) {
        const vanished = filledFields.has(pending.id)
        if (vanished) {
          const attempts = (refillCounts.get(pending.id) ?? 0) + 1
          refillCounts.set(pending.id, attempts)
          if (attempts > MAX_REFILLS) refillExhausted.add(pending.id)
          trace.push(`第 ${step} 步：字段「${pending.name ?? pending.id}」的值没留在页面上（读回不一致，第 ${attempts} 次重填）`)
        } else {
          trace.push(`第 ${step} 步：还有没生效的字段「${pending.name ?? pending.id}」→ 先填它`)
        }
        chosen = pending
      }
    }

    // 勾选目标或含勾选子句的多步目标（如 "Mark the 'buy milk' todo as completed" 或 todomvc-coarse）：
    // 当所有待填值都已用完时，若页面上恰好有一个名字命中目标的未满足 checkbox，直接选它；
    // 若该 checkbox 已满足且存在命中末尾子句的提交/清空按钮（如 "Clear completed"），直接选该按钮。
    const allInputsConsumedOrFilled =
      pendingField === undefined &&
      (deps.inputs === undefined ||
        Object.values(deps.inputs).every((val) => consumedValues.has(val) || [...filledFields.values()].includes(val)))
    const hasRadioSelectClause = /\b(select|choose|pick)\b[^.]{0,40}\bradio\b/i.test(goal)
    const matchesGoalOrOrdinalToggle = (candidate: TaskCandidate): boolean => {
      if ((candidate.role !== 'checkbox' && candidate.role !== 'radio' && candidate.role !== 'switch') || (candidate.state ?? '').includes('已禁用')) {
        return false
      }
      const role = (candidate.role ?? '').toLowerCase()
      if (/\bradio\b/i.test(goal) && !/\bcheckbox\b/i.test(goal) && role !== 'radio') return false
      if (/\bcheckbox\b/i.test(goal) && !/\bradio\b/i.test(goal) && role !== 'checkbox') return false
      const desc = candidate.description.toLowerCase()
      if (
        (/\b(first|1st)\b|第一|首个/i.test(goal) && desc.includes(' #') && !desc.includes(' #1')) ||
        (/\b(second|2nd)\b|第二/i.test(goal) && desc.includes(' #') && !desc.includes(' #2')) ||
        (/\b(third|3rd)\b|第三/i.test(goal) && desc.includes(' #') && !desc.includes(' #3'))
      ) {
        return false
      }
      if ((candidate.name ?? '') !== '' && goalMentions(candidate.name ?? '', goal)) return true
      if (role !== '' && new RegExp(`\\b${role}\\b`, 'i').test(goal)) {
        if (desc.includes(' #1') && /\b(first|1st)\b|第一|首个/i.test(goal)) return true
        if (desc.includes(' #2') && /\b(second|2nd)\b|第二/i.test(goal)) return true
        if (desc.includes(' #3') && /\b(third|3rd)\b|第三/i.test(goal)) return true
      }
      return false
    }
    if (
      chosen.kind !== 'input' &&
      !lastActionWasText &&
      allInputsConsumedOrFilled &&
      (ENABLE_VERBS.test(goal) || DISABLE_VERBS.test(goal) || hasRadioSelectClause) &&
      !/\ball\b|全部|所有/i.test(goal)
    ) {
      const matchingToggles = candidates.filter(matchesGoalOrOrdinalToggle)
      if (matchingToggles.length === 1) {
        if (chosen.id !== matchingToggles[0].id) {
          trace.push(`第 ${step} 步：目标明确要勾选「${matchingToggles[0].name}」→ 改选它（判断层选了「${chosen.name ?? chosen.id}」）`)
          chosen = matchingToggles[0]
        }
      } else if (matchingToggles.length === 0 && satisfied.some(matchesGoalOrOrdinalToggle)) {
        const finalClause = goal.split(/[,，;；]|\bthen\b/i).map((c) => c.trim()).filter(Boolean).pop() ?? ''
        const finalBtn = candidates.find(
          (candidate) =>
            candidate.kind === 'click' &&
            submitControlOf(candidate.name ?? '') !== undefined &&
            goalMentions(candidate.name ?? '', finalClause),
        )
        if (finalBtn !== undefined && chosen.id !== finalBtn.id) {
          trace.push(`第 ${step} 步：勾选子目标已满足，执行末尾子句控件「${finalBtn.name}」（判断层选了「${chosen.name ?? chosen.id}」）`)
          chosen = finalBtn
        }
      }
    }

    // 5) 输入/下拉候选处理
    if (chosen.kind === 'input') {
      if (
        deps.inputs !== undefined &&
        Object.keys(deps.inputs).length === 1 &&
        isTextEntry(chosen) &&
        !specificallyNamed(chosen, deps.inputs) &&
        !goalMentions(chosen.name ?? '', goal)
      ) {
        const better = bestEmptyInputForGoal(allCandidates, goal, filledFields)
        if (better !== undefined && better.id !== chosen.id) {
          trace.push(`第 ${step} 步：值是通用 key，字段按目标改选「${better.name ?? better.id}」（判断层选了「${chosen.name ?? chosen.id}」）`)
          chosen = better
        }
      }
      let given = inputMatchesOf(candidates, deps.inputs).get(chosen.id)?.value ?? soleValueFor(candidates, deps.inputs)
      if (given === undefined) {
        const valueAnswer = answers.value
        if (valueAnswer?.kind === 'choice' && valueAnswer.optionId.startsWith('value:')) {
          const key = valueAnswer.optionId.slice('value:'.length)
          const pickedVal = deps.inputs?.[key]
          if (pickedVal !== undefined && !consumedValues.has(pickedVal)) {
            given = pickedVal
            trace.push(`第 ${step} 步：判断层选了调用方的值「${key}」→ 填进 ${chosen.name ?? chosen.id}`)
          }
        }
      }
      if (given === undefined && deps.inputs !== undefined) {
        const remainingEntries = Object.entries(deps.inputs).filter(([, val]) => !consumedValues.has(val))
        if (remainingEntries.length === 1) {
          given = remainingEntries[0][1]
        }
      }
      if (given === undefined) {
        given = await pickSelectOption(judge, deps, goal, chosen, snapshot, step, usage, trace)
      }
      // 自定义 ARIA combobox（如 react-select：无原生 options、调用方也没给文本值，目标是下拉选择）：
      // 转成点击该控件以展开 [role="option"] 菜单，而不是返回 input_required。
      if (
        given === undefined &&
        (chosen.role ?? '').toLowerCase() === 'combobox' &&
        chosen.options === undefined &&
        /\b(dropdown|combobox|choose|select|pick)\b|下拉|选择/i.test(goal) &&
        !SEARCH_GOALS.test(goal)
      ) {
        chosen = { ...chosen, kind: 'click', description: `点击「${chosen.name ?? chosen.id}」（展开下拉框）` }
      } else if (given !== undefined) {
        const beforeFill = stateOf(chosen)
        if (
          isTextEntry(chosen) &&
          beforeFill.value !== undefined &&
          beforeFill.value.trim() !== given.trim() &&
          !specificallyNamed(chosen, deps.inputs)
        ) {
          trace.push(`第 ${step} 步：「${chosen.name ?? chosen.id}」已有别的值（${beforeFill.value}）→ 覆盖为调用方给的新值（没有更合适的空字段）`)
        }
        const started = now()
        try {
          await fillFromInputs(deps.browser, chosen, given, deps.signal)
          timings.actMs += now() - started
          actionFailures = 0
          if (observedPage.mode === 'tree') {
            const readback = await deps.browser.get('value', chosen.ref, undefined, { signal: deps.signal }).catch(() => undefined)
            const matched = readback !== undefined && readback.trim() === given.trim()
            if (matched) {
              for (const [key, value] of Object.entries(deps.inputs ?? {})) if (value === given) verifiedFills.add(key)
              fillMismatches = 0
              trace.push(`第 ${step} 步：读回值确认「${chosen.name || chosen.id}」已生效`)
            } else if (readback !== undefined) {
              fillMismatches += 1
              trace.push(`第 ${step} 步：读回值与调用方给的不一致（第 ${fillMismatches} 次）→ 不当作已生效`)
              if (fillMismatches >= 2) {
                steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: chosen.id, executed: true, reason: 'fill_not_applied' })
                return finish('no_progress', '填进去的值没有留在页面上（读回不一致）', snapshot)
              }
            }
          }
          if (fillMismatches === 0) filledFields.set(chosen.id, given)
          if (
            SECRET_KEY.test(chosen.name ?? '') ||
            SECRET_KEY.test(chosen.state ?? '') ||
            (chosen.state ?? '').includes('●●●')
          ) {
            filledSecret = true
          }
          const isNativeSelect =
            chosen.options !== undefined ||
            chosen.role === 'select' ||
            chosen.tag === 'select' ||
            (chosen.role === 'combobox' && (chosen.state ?? '').startsWith('当前值:'))
          lastActionWasText = !isNativeSelect
          lastFilledFieldId = chosen.id
          trace.push(`第 ${step} 步：按调用方的值填 ${chosen.role ?? 'field'}「${chosen.name ?? chosen.id}」= ${given} ✓`)
          const selectedLabel = singleStepGoal(goal) ? selectionMatchesGoal(goal, chosen, given) : undefined
          if (selectedLabel !== undefined) {
            trace.push(`第 ${step} 步：选中的「${selectedLabel}」就是目标要求的选择 → 停，交回宿主校验`)
            steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: chosen.id, executed: true, reason: 'selection_matched', ...(goalDone === undefined ? {} : { goalDone }), ...(stuck === undefined ? {} : { stuck }) })
            return finish('needs_verification', `已选择「${selectedLabel}」`, snapshot)
          }
          // 多字段表单单步批量填充：当调用方给了多个键值（如 username+password、first_name+last_name+postal_code、5字段 webform），
          // 把当前页上名字确定性匹配、尚未填写的其余字段在同一步内顺手填完，省去 N-1 步重新抽取与 N-1 次 Jev 调用。
          let lastBatchCandidate = chosen
          if (observedPage.mode === 'extract' && fillMismatches === 0 && deps.inputs !== undefined && Object.keys(deps.inputs).length > 1) {
            const batchInputMatches = inputMatchesOf(candidates, deps.inputs)
            for (const other of candidates) {
              if (other.id === chosen.id || filledFields.has(other.id)) continue
              if ((other.state ?? '').includes('已禁用')) continue
              if (other.kind !== 'input' && other.role !== 'checkbox' && other.role !== 'radio' && other.role !== 'switch') continue
              const otherVal = batchInputMatches.get(other.id)?.value
              if (otherVal === undefined || consumedValues.has(otherVal) || [...filledFields.values()].includes(otherVal)) continue
              if (isAlreadySatisfied(other, goal, deps.inputs)) continue
              try {
                const batchStart = now()
                await fillFromInputs(deps.browser, other, otherVal, deps.signal)
                timings.actMs += now() - batchStart
                filledFields.set(other.id, otherVal)
                if (
                  SECRET_KEY.test(other.name ?? '') ||
                  SECRET_KEY.test(other.state ?? '') ||
                  (other.state ?? '').includes('●●●')
                ) {
                  filledSecret = true
                }
                const otherIsNativeSelect =
                  other.options !== undefined ||
                  other.role === 'select' ||
                  other.tag === 'select' ||
                  (other.role === 'combobox' && (other.state ?? '').startsWith('当前值:'))
                lastActionWasText = !otherIsNativeSelect && other.role !== 'checkbox' && other.role !== 'radio' && other.role !== 'switch'
                lastFilledFieldId = other.id
                lastBatchCandidate = other
                trace.push(`第 ${step} 步：同页批量填 ${other.role ?? 'field'}「${other.name ?? other.id}」= ${otherVal} ✓`)
              } catch {
                // 单个顺手批填失败不中断主流程，留给后续步骤常规处理
              }
            }
          }
          steps.push({
            step,
            origin: snapshot.origin,
            digest: snapshot.digest,
            action: chosen.id,
            executed: true,
            reason: 'filled_from_inputs',
            ...(goalDone === undefined ? {} : { goalDone }),
            ...(stuck === undefined ? {} : { stuck }),
            ...(confidence === undefined ? {} : { confidence }),
          })
          delivered = {
            id: lastBatchCandidate.id,
            snapshot,
            textSample: pageText.replace(/\s+/g, ' ').trim().slice(0, 80),
            ...(lastBatchCandidate.ref === undefined ? {} : { selector: lastBatchCandidate.ref }),
          }
          continue
        } catch (error) {
          actionFailures += 1
          attempted.add(chosen.id)
          trace.push(`第 ${step} 步：按调用方的值填「${chosen.name ?? chosen.id}」失败：${message(error)}`)
          if (actionFailures >= 2) return finish('action_error', message(error), snapshot)
          continue
        }
      } else {
        const info = chosen.ref === undefined ? undefined : snapshot.refs[chosen.ref.replace(/^@/, '')]
        const role = chosen.role ?? info?.role ?? 'field'
        const name = chosen.name ?? info?.name ?? chosen.ref ?? ''
        trace.push(`第 ${step} 步：需要 ${role}「${name}」的值 → 交回宿主（input_required）`)
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: chosen.id, executed: false, reason: 'input_required', ...(goalDone === undefined ? {} : { goalDone }), ...(stuck === undefined ? {} : { stuck }) })
        return finish('input_required', `需要 ${role}「${name}」的值`, snapshot)
      }
    }

    // 6) 「交付了但页面没变」又被选中 → 仅在次优候选概率 ≥ ALTERNATE_MIN_PROBABILITY (0.25) 时换次优；
    //    否则直接停下交回上游 LLM，绝不拿 p=0.06 的候选去乱点跳走（todomvc-fine / ti-hover 教训）。
    let alternateOf: string | undefined
    if (delivered !== undefined && delivered.id === chosen.id && chosen.id !== 'control:wait' && !stateChanged(delivered.snapshot, snapshot)) {
      if (lastJsClick?.id === chosen.id && !jsClickRetried.has(chosen.id) && chosen.ref !== undefined) {
        jsClickRetried.add(chosen.id)
        lastJsClick = undefined
        await deps.browser.act('scrollintoview', chosen.ref, {}, { signal: deps.signal }).catch(() => {})
        await deps.browser.act('click', chosen.ref, {}, { signal: deps.signal })
        trace.push(`第 ${step} 步：${chosen.name ?? chosen.id} 的 el.click() 没效果 → 回退成滚动+真实点击`)
        continue
      }
      if (delivered.navigational === true) {
        const shiftedLate = typeof deps.browser.waitForPageShift === 'function'
          ? await deps.browser
              .waitForPageShift(
                {
                  url: snapshot.origin,
                  textSample: delivered.textSample ?? '',
                },
                { signal: deps.signal, timeoutMs: 1500 },
              )
              .catch(() => false)
          : false
        if (shiftedLate) {
          trace.push(`第 ${step} 步：${chosen.name ?? chosen.id} 的跳转是延迟的 → 等到了页面变化，继续观察`)
          delivered = undefined
          continue
        }
      }
      const count = (stalled.get(chosen.id) ?? 0) + 1
      stalled.set(chosen.id, count)
      useless.add(chosen.id)
      trace.push(`第 ${step} 步：${chosen.id} 执行过但页面语义状态没变（第 ${count} 次）→ 本轮不再提供它`)
      if (count >= 2) {
        const remaining = candidates.filter(
          (candidate) => candidate.kind !== 'input' && candidate.id !== 'control:wait' && !useless.has(candidate.id),
        )
        const bestRemainingProb =
          probabilities === undefined
            ? 0
            : Math.max(0, ...remaining.map((candidate) => probabilities[candidate.id] ?? 0))
        if (remaining.length > 0 && reroutes < 2 && bestRemainingProb >= ALTERNATE_MIN_PROBABILITY) {
          reroutes += 1
          trace.push(`第 ${step} 步：还有 ${remaining.length} 个候选可试（最高 p=${bestRemainingProb.toFixed(2)}）→ 换路，继续（第 ${reroutes} 次）`)
          continue
        }
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: chosen.id, executed: false, reason: 'stalled_action', stateChanged: false, ...(goalDone === undefined ? {} : { goalDone }), ...(stuck === undefined ? {} : { stuck }) })
        const confirmed = await confirmWithContext()
        if (confirmed.confirmed) {
          trace.push(`停滞了，但结束前独立确认通过（p=${confirmed.probability.toFixed(2)}）→ 交回宿主校验`)
          return finish('needs_verification', `停滞前确认 p=${confirmed.probability.toFixed(2)}`, snapshot)
        }
        return finish('no_progress', `动作 ${chosen.id} 重复且页面没有变化`, snapshot)
      }
      const executable = new Set(candidates.filter((candidate) => candidate.kind !== 'input').map((candidate) => candidate.id))
      const alternateId = pickAlternate(probabilities, new Set([chosen.id, ...attempted]), executable, ALTERNATE_MIN_PROBABILITY)
      const alternate = alternateId === undefined ? undefined : byId.get(alternateId)
      if (alternate === undefined) {
        trace.push(`第 ${step} 步：分布里没有可替代的候选（需 p ≥ ${ALTERNATE_MIN_PROBABILITY}）→ 停（no_progress 交回上游 LLM）`)
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: chosen.id, executed: false, reason: 'stalled_action', stateChanged: false, ...(goalDone === undefined ? {} : { goalDone }), ...(stuck === undefined ? {} : { stuck }) })
        const confirmed = await confirmWithContext()
        if (confirmed.confirmed) {
          trace.push(`没有可替代的候选，但结束前独立确认通过（p=${confirmed.probability.toFixed(2)}）→ 交回宿主校验`)
          return finish('needs_verification', `无替代候选，结束前确认 p=${confirmed.probability.toFixed(2)}`, snapshot)
        }
        return finish('no_progress', `动作 ${chosen.id} 没有效果，且没有可信的替代候选`, snapshot)
      }
      trace.push(`第 ${step} 步：改用次优候选 ${alternate.id}（分布里 p=${(probabilities?.[alternate.id] ?? 0).toFixed(2)}）`)
      alternateOf = chosen.id
      chosen = alternate
    }
    attempted.add(chosen.id)

    // ambiguous 门
    if (chosen.kind === 'click' && confidence !== undefined && confidence < AMBIGUOUS_CONFIDENCE && probabilities !== undefined) {
      const ranked = Object.entries(probabilities).sort((left, right) => right[1] - left[1])
      const gap = (ranked[0]?.[1] ?? 0) - (ranked[1]?.[1] ?? 0)
      if (gap < AMBIGUOUS_GAP) {
        const top = ranked.slice(0, 3).map(([id]) => {
          const candidate = byId.get(id)
          return {
            id,
            description: candidate?.description ?? id,
            ...(candidate?.ref === undefined ? {} : { ref: candidate.ref }),
          }
        })
        trace.push(`第 ${step} 步：判断层分不清（置信 ${confidence.toFixed(2)}，前两名差 ${gap.toFixed(2)}）→ ambiguous，交回候选`)
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: 'stop:ambiguous', executed: false, reason: 'ambiguous', ...(goalDone === undefined ? {} : { goalDone }), ...(confidence === undefined ? {} : { confidence }) })
        return { ...finish('ambiguous', `置信 ${confidence.toFixed(2)}、前两名差 ${gap.toFixed(2)}：请从候选里挑`, snapshot), candidates: top }
      }
    }

    // 不可逆门
    if (
      deps.allowIrreversible !== true &&
      irreversible !== undefined &&
      irreversible >= IRREVERSIBLE_THRESHOLD &&
      chosen.kind === 'click'
    ) {
      trace.push(`第 ${step} 步：${chosen.description} 看起来不可逆（p=${irreversible.toFixed(2)} ≥ ${IRREVERSIBLE_THRESHOLD}）→ 等调用方确认`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: chosen.id, executed: false, reason: 'needs_confirmation', ...(goalDone === undefined ? {} : { goalDone }), ...(stuck === undefined ? {} : { stuck }) })
      return finish('needs_confirmation', `下一步「${chosen.description}」可能不可逆（p=${irreversible.toFixed(2)}）`, snapshot)
    }

    // 7) 执行一个动作
    try {
      const actStarted = now()
      const chosenInputMatch = inputMatchesOf(candidates, deps.inputs).get(chosen.id)
      const executed = await execute(
        deps.browser,
        chosen,
        deps.signal,
        chosenInputMatch === undefined ? undefined : { [chosenInputMatch.key]: chosenInputMatch.value },
      )
      lastJsClick = executed.jsClicked
      // 关键修复：非输入动作执行成功后必须重置 lastActionWasText = false，
      // 否则 wiki-search / todomvc 在第 1 步打完字后会在第 2..10 步永远重复按 Enter。
      if (chosen.id === 'control:press_enter' && lastFilledFieldId !== undefined) {
        const lastVal = filledFields.get(lastFilledFieldId)
        if (lastVal !== undefined) consumedValues.add(lastVal)
        const unconsumedCount = Object.values(deps.inputs ?? {}).filter((val) => !consumedValues.has(val)).length
        // 只有调用方给的值全部消费完时，才将该输入框记入 consumedByEnter；
        // 若还有未消费的值（如 todomvc-coarse 的 second: 'walk the dog'），留着输入框继续填下一个值。
        if (unconsumedCount === 0) {
          consumedByEnter.add(lastFilledFieldId)
        } else {
          filledFields.delete(lastFilledFieldId)
        }
        lastEnterAddedValue = lastVal
      } else {
        lastEnterAddedValue = undefined
      }
      lastActionWasText = false
      const finalClause = goal.split(/[,，;；]|\bthen\b/i).map((c) => c.trim()).filter(Boolean).pop() ?? goal
      const allInputsUsed =
        deps.inputs === undefined || Object.values(deps.inputs).every((val) => consumedValues.has(val) || [...filledFields.values()].includes(val))
      lastSubmitAction =
        chosen.kind === 'click' &&
        namedSubmitGoal(goal) &&
        submitControlOf(chosen.name ?? '') !== undefined &&
        ((singleStepGoal(goal) || fillThenSubmitGoal(goal)) && goalMentions(chosen.name ?? '', goal) ||
          (allInputsUsed && goalMentions(chosen.name ?? '', finalClause)))
          ? { id: chosen.id, name: chosen.name ?? '' }
          : undefined
      lastFilterLinkClick =
        chosen.kind === 'click' &&
        (chosen.role === 'a' || chosen.role === 'link' || chosen.role === 'tab') &&
        (chosen.name ?? '') !== '' &&
        goalMentions(chosen.name ?? '', goal)
          ? { id: chosen.id, name: chosen.name ?? '' }
          : undefined
      lastAddToCart =
        chosen.kind === 'click' &&
        singleStepGoal(goal) &&
        /add\b[^.]{0,60}\bcart\b|加入购物车|添加到购物车/i.test(goal) &&
        /add.*cart|加入购物车|添加到购物车/i.test(chosen.name ?? '')
          ? { id: chosen.id, name: chosen.name ?? '' }
          : undefined
      lastDismissAction =
        chosen.kind === 'click' &&
        /\b(close|dismiss|hide)\b|关闭|关掉|收起/i.test(goal) &&
        /close|dismiss|关闭|关掉|got it|i understand/i.test(chosen.name ?? '')
          ? { id: chosen.id, name: chosen.name ?? '' }
          : undefined
      lastSelectedOption =
        chosen.kind === 'click' &&
        singleStepGoal(goal) &&
        (chosen.role ?? '').toLowerCase() === 'option' &&
        (chosen.name ?? '') !== '' &&
        goalMentions(chosen.name ?? '', goal)
          ? { id: chosen.id, name: chosen.name ?? '' }
          : undefined
      lastSortHeaderClick =
        chosen.kind === 'click' &&
        singleStepGoal(goal) &&
        (chosen.role ?? '').toLowerCase() === 'columnheader' &&
        (chosen.name ?? '') !== '' &&
        goalMentions(chosen.name ?? '', goal)
          ? { id: chosen.id, name: chosen.name ?? '' }
          : undefined
      lastKeyPressAction =
        chosen.id !== 'control:press_enter' &&
        chosen.id.startsWith('control:press_') &&
        keysWantedByGoal(goal).length > 0
          ? chosen.id
          : undefined
      timings.actMs += now() - actStarted
      actionFailures = 0
      staleStreak = 0
      if (chosen.id === 'control:wait') waits += 1
      delivered = {
        id: chosen.id,
        snapshot,
        textSample: pageText.replace(/\s+/g, ' ').trim().slice(0, 80),
        ...(chosen.ref === undefined ? {} : { selector: chosen.ref }),
        navigational:
          (chosen.kind === 'click' &&
            ['link', 'a', 'button', 'tab', 'menuitem'].includes((chosen.role ?? '').toLowerCase())) ||
          chosen.id === 'control:press_enter' ||
          chosen.id === 'control:back',
      }
      trace.push(`第 ${step} 步：${chosen.description} ✓`)
      steps.push({
        step,
        origin: snapshot.origin,
        digest: snapshot.digest,
        action: chosen.id,
        executed: true,
        reason: 'executed',
        ...(goalDone === undefined ? {} : { goalDone }),
        ...(stuck === undefined ? {} : { stuck }),
        ...(confidence === undefined ? {} : { confidence }),
        ...(alternateOf === undefined ? {} : { alternateOf }),
      })
    } catch (error) {
      attempted.add(chosen.id)
      const detail = message(error)
      const stale = /Unknown ref|未知的 ref|stale|no longer exists|不存在/i.test(detail)
      if (stale) {
        staleStreak += 1
        trace.push(`第 ${step} 步：${chosen.id} 的 ref 已失效（stale_state，连续 ${staleStreak} 次）→ 重新观察`)
        steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: chosen.id, executed: false, reason: `stale_state: ${detail}`, ...(goalDone === undefined ? {} : { goalDone }), ...(stuck === undefined ? {} : { stuck }) })
        delivered = undefined
        if (staleStreak >= 3) {
          const confirmed = await confirmWithContext()
          if (confirmed.confirmed) {
            trace.push(`ref 一直失效，但结束前独立确认通过（p=${confirmed.probability.toFixed(2)}）→ 交回宿主校验`)
            return finish('needs_verification', `连续 ${staleStreak} 次 ref 失效；确认 p=${confirmed.probability.toFixed(2)}`, snapshot)
          }
          return finish('no_progress', `连续 ${staleStreak} 次 ref 失效：页面一直在重建，判断跟不上`, snapshot)
        }
        continue
      }
      actionFailures += 1
      trace.push(`第 ${step} 步：${chosen.description} ✗ ${detail}（连续失败 ${actionFailures} 次）`)
      steps.push({ step, origin: snapshot.origin, digest: snapshot.digest, action: chosen.id, executed: false, reason: `action_error: ${detail}`, ...(goalDone === undefined ? {} : { goalDone }), ...(stuck === undefined ? {} : { stuck }) })
      if (actionFailures >= 2) return finish('action_error', detail, snapshot)
      continue
    }
  }

  const confirmedAtEnd = await confirmGoal(
    judge,
    deps,
    last ?? (await deps.browser.snapshot({ interactiveOnly: true }, { signal: deps.signal })),
    goal,
    usage,
    trace,
  )
  if (confirmedAtEnd.confirmed) {
    trace.push(`结束前独立确认通过（p=${confirmedAtEnd.probability.toFixed(2)}）：模型没主动宣布，但页面已呈现目标结果 → 交回宿主校验`)
    return finish('needs_verification', `达到步数上限，结束前确认 p=${confirmedAtEnd.probability.toFixed(2)}`, last)
  }
  return finish('budget', `达到最大步数 ${deps.maxSteps}`, last)

  function finish(status: TaskStatus, reason: string, snapshot: Snapshot | undefined): TaskResult {
    usage.estCostUsd = Math.round((usage.inputTokens * 0.042 / 1_000_000) * 1e9) / 1e9
    const handoffCandidates = HANDOFF_STATUSES.has(status)
      ? lastCandidates
          .filter((candidate) => candidate.kind !== 'control')
          .slice(0, 5)
          .map((candidate) => ({
            id: candidate.id,
            description: candidate.description,
            ...(candidate.ref === undefined ? {} : { ref: candidate.ref }),
          }))
      : undefined
    return {
      status,
      reason,
      steps,
      trace,
      url: snapshot?.origin ?? '',
      usage,
      timings: {
        snapshotMs: Math.round(timings.snapshotMs),
        readMs: Math.round(timings.readMs),
        titleMs: Math.round(timings.titleMs),
        askMs: Math.round(timings.askMs),
        actMs: Math.round(timings.actMs),
        totalMs: Math.round(now() - timings.startedAt),
      },
      ...(handoffCandidates === undefined || handoffCandidates.length === 0 ? {} : { candidates: handoffCandidates }),
      ...(HANDOFF_STATUSES.has(status) && lastPageText !== '' ? { pageText: clipHeadTail(lastPageText, 800) } : {}),
      next: NEXT_HINTS[status],
    }
  }
}

/** 顺序执行调用方明确给出的子目标。 */
export async function runSubgoals(
  goal: string,
  subgoals: readonly TaskSubgoal[],
  deps: TaskDeps,
): Promise<TaskResult> {
  if (goal.trim() === '') throw new JudgeUnavailableError('browser_run 需要 goal')
  if (subgoals.length === 0 || subgoals.some((subgoal) => subgoal.goal.trim() === '')) {
    throw new JudgeUnavailableError('browser_run 的 subgoals 必须是非空目标列表')
  }

  const startedAt = now()
  const steps: TaskStep[] = []
  const trace = [`总目标：${goal}`, `按顺序执行 ${subgoals.length} 个子目标`]
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0 }
  const timings = { snapshotMs: 0, readMs: 0, titleMs: 0, askMs: 0, actMs: 0, totalMs: 0 }
  let lastResult: TaskResult | undefined

  const finish = (status: TaskStatus, reason: string): TaskResult => ({
    status,
    reason,
    steps,
    trace,
    url: lastResult?.url ?? '',
    usage,
    timings: { ...timings, totalMs: Math.round(now() - startedAt) },
    ...(lastResult?.candidates === undefined ? {} : { candidates: lastResult.candidates }),
    ...(lastResult?.pageText === undefined ? {} : { pageText: lastResult.pageText }),
    next: NEXT_HINTS[status],
  })

  for (const [index, subgoal] of subgoals.entries()) {
    const remaining = deps.maxSteps - steps.length
    if (remaining <= 0) {
      trace.push(`子目标 ${index + 1}/${subgoals.length} 未开始：整个序列已达到 ${deps.maxSteps} 步上限`)
      return finish('budget', '有序子目标达到总步数上限')
    }

    trace.push(`子目标 ${index + 1}/${subgoals.length}：${subgoal.goal}`)
    const result = await runTask(subgoal.goal, {
      ...deps,
      maxSteps: remaining,
      inputs: subgoal.inputs,
    })
    lastResult = result
    const offset = steps.length
    steps.push(...result.steps.map((step) => ({ ...step, step: offset + step.step, phase: index + 1 })))
    trace.push(...result.trace.map((line) => `子目标 ${index + 1}/${subgoals.length}：${line}`))
    usage.calls += result.usage.calls
    usage.inputTokens += result.usage.inputTokens
    usage.outputTokens += result.usage.outputTokens
    usage.estCostUsd += result.usage.estCostUsd
    timings.snapshotMs += result.timings.snapshotMs
    timings.readMs += result.timings.readMs
    timings.titleMs += result.timings.titleMs
    timings.askMs += result.timings.askMs
    timings.actMs += result.timings.actMs

    if (result.status !== 'needs_verification') {
      trace.push(`停止在子目标 ${index + 1}/${subgoals.length}：状态 ${result.status}，不自动推进`)
      return finish(result.status, `子目标 ${index + 1}/${subgoals.length} 未通过：${result.reason}`)
    }
  }

  return finish(lastResult?.status ?? 'budget', lastResult?.reason ?? '没有可执行的子目标')
}
