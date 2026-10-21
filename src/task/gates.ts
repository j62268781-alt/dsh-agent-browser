/**
 * `src/task/gates.ts`：确定性门控、字段状态核对、URL/提交完成证据与次优候选选择。
 */

import {
  DISABLE_VERBS,
  ENABLE_VERBS,
  FOLLOW_UP_VERBS,
  NAVIGATION_GOALS,
  SUBMIT_CONTROL_VERBS,
  TEXT_ENTRY_ROLES,
  type TaskCandidate,
} from './types.js'
import { fieldName, goalMentions, goalTokensOf } from './utils.js'

/** 从抽取的 `state` 文本里读出"当前状态"。 */
export function stateOf(candidate: TaskCandidate): { checked?: boolean; value?: string; redacted?: boolean } {
  const state = candidate.state ?? ''
  if (state.includes('已勾选')) return { checked: true }
  if (state.includes('未勾选')) return { checked: false }
  if (state.includes('●●●')) return { redacted: true }
  const value = /当前值: (.*)$/.exec(state)?.[1] ?? /已有内容: (.*)$/.exec(state)?.[1]
  return value === undefined ? {} : { value: value.trim() }
}

/** 调用方给的字段值 → 候选（按名字匹配：完全相等 → 包含）。 */
export function matchInputValue(candidate: TaskCandidate, inputs?: Readonly<Record<string, string>>): string | undefined {
  if (inputs === undefined) return undefined
  const name = fieldName(candidate.name ?? '')
  if (name === '') return undefined
  for (const [key, value] of Object.entries(inputs)) {
    const normalized = fieldName(key)
    if (normalized === '') continue
    if (normalized === name || name.includes(normalized) || normalized.includes(name)) return value
  }
  return undefined
}

/**
 * 状态守卫：这个候选是不是已经满足目标、不需要再操作。
 *
 * 支持多子句目标（如 "Make checkbox 1 checked and checkbox 2 unchecked"）：
 * 优先取点名了当前候选名字的那个子句来判定开启/关闭。
 */
export function isAlreadySatisfied(
  candidate: TaskCandidate,
  goal: string,
  inputs?: Readonly<Record<string, string>>,
): boolean {
  const state = stateOf(candidate)
  if (state.checked !== undefined) {
    const clauses = goal.split(/[,，;；]|\band\b/i).map((clause) => clause.trim()).filter(Boolean)
    const candidateKey = fieldName(candidate.name ?? '')
    const matchedClause =
      candidateKey !== '' && clauses.length > 1
        ? clauses.find((clause) => fieldName(clause).includes(candidateKey)) ??
          clauses.find((clause) => goalMentions(candidate.name ?? '', clause))
        : undefined
    // 多子句时若某个框名字没对上任何子句，不做全局判断，避免把"别的框要勾选"套到当前框上。
    if (clauses.length > 1 && matchedClause === undefined && ENABLE_VERBS.test(goal) && DISABLE_VERBS.test(goal)) {
      return false
    }
    const scope = matchedClause ?? goal
    if (ENABLE_VERBS.test(scope) && !DISABLE_VERBS.test(scope)) return state.checked
    if (DISABLE_VERBS.test(scope) && !ENABLE_VERBS.test(scope)) return !state.checked
    return false
  }
  if (state.redacted === true) return matchInputValue(candidate, inputs) !== undefined
  if (state.value !== undefined) {
    const wanted = matchInputValue(candidate, inputs)
    if (wanted !== undefined) return wanted.trim() === state.value.trim()
  }
  return false
}

/** 调用方给的 key 是不是就是这个字段的名字（归一后完全相等）。 */
export function specificallyNamed(
  candidate: TaskCandidate,
  inputs?: Readonly<Record<string, string>>,
): boolean {
  if (inputs === undefined) return false
  const name = fieldName(candidate.name ?? '')
  if (name === '') return false
  return Object.keys(inputs).some((key) => fieldName(key) === name)
}

/** 这个候选是不是"文本输入字段"（不是下拉/勾选）。 */
export function isTextEntry(candidate: TaskCandidate): boolean {
  return TEXT_ENTRY_ROLES.has((candidate.role ?? '').toLowerCase())
}

/** 通用值 key 在空文本字段里挑哪个：只按目标词面相关性确定性排序，不猜。 */
export function bestEmptyInputForGoal(
  candidates: readonly TaskCandidate[],
  goal: string,
  filled?: ReadonlyMap<string, string>,
): TaskCandidate | undefined {
  const empty = candidates.filter((candidate) => {
    if (candidate.kind !== 'input') return false
    if (!TEXT_ENTRY_ROLES.has((candidate.role ?? '').toLowerCase())) return false
    if (filled?.has(candidate.id) === true) return false
    const state = stateOf(candidate)
    return state.value === undefined && state.redacted !== true
  })
  if (empty.length === 0) return undefined
  if (goalTokensOf(goal).length === 0) return undefined
  const ranked = empty
    .map((candidate, index) => ({ candidate, index, matched: goalMentions(candidate.name ?? '', goal) }))
    .sort((left, right) => Number(right.matched) - Number(left.matched) || left.index - right.index)
  return ranked[0]?.matched === true ? ranked[0]?.candidate : undefined
}

/**
 * 调用方给了值、但页面状态还没生效的字段。
 *
 * `consumedByEnter`：已经通过按 Enter 提交消费掉的输入框（如 TodoMVC 新建条目后输入框变回空串），
 * 变空是正常消费，不再当作"被站点清空需重填"。
 */
export function pendingFieldOf(
  candidates: readonly TaskCandidate[],
  inputs?: Readonly<Record<string, string>>,
  goal?: string,
  filled?: ReadonlyMap<string, string>,
  exhausted?: ReadonlySet<string>,
  consumedByEnter?: ReadonlySet<string>,
  consumedValues?: ReadonlySet<string>,
): TaskCandidate | undefined {
  if (inputs === undefined) return undefined
  for (const candidate of candidates) {
    if (candidate.kind !== 'input' && candidate.role !== 'checkbox' && candidate.role !== 'radio' && candidate.role !== 'switch') continue
    const wanted = matchInputValue(candidate, inputs)
    if (wanted === undefined) continue
    const state = stateOf(candidate)
    if (state.redacted === true) continue
    if (state.checked !== undefined) {
      const wantChecked = /^(1|true|yes|on|y|是)$/i.test(wanted.trim())
      if (state.checked !== wantChecked) return candidate
      continue
    }
    if (state.value !== undefined && state.value.trim() !== wanted.trim()) {
      if (!specificallyNamed(candidate, inputs)) continue
      return candidate
    }
    if (state.value === undefined) {
      if (exhausted?.has(candidate.id) === true) continue
      if (consumedByEnter?.has(candidate.id) === true) continue
      if (specificallyNamed(candidate, inputs)) return candidate
      if (filled?.has(candidate.id) === true) return candidate
      if (goal !== undefined && goalMentions(candidate.name ?? '', goal)) return candidate
    }
  }
  // 页面上只有唯一一个文本输入框（如 TodoMVC 的新建框）、当前为空，且调用方给的值还有未通过 Enter 消费的项（如 first/second 里的 second）
  if (consumedValues !== undefined && consumedValues.size > 0) {
    const hasUnconsumed = Object.values(inputs).some((val) => !consumedValues.has(val))
    const textInputs = candidates.filter((candidate) => candidate.kind === 'input' && isTextEntry(candidate))
    if (hasUnconsumed && textInputs.length === 1) {
      const only = textInputs[0]
      if (
        exhausted?.has(only.id) !== true &&
        consumedByEnter?.has(only.id) !== true &&
        stateOf(only).value === undefined
      ) {
        return only
      }
    }
  }
  return undefined
}

/**
 * 多跳纯导航目标（如 "Open the cart and go to checkout"）：
 * 每个子句都是导航动作时，返回最后一个子句（即最终目的地 "go to checkout"）。
 */
export function finalNavigationClauseOf(goal: string): string | undefined {
  const clauses = goal.split(/[,，;；]|\band\b|\bthen\b/i).map((clause) => clause.trim()).filter(Boolean)
  if (clauses.length < 2) return undefined
  const allNav = clauses.every((clause) => NAVIGATION_GOALS.test(clause))
  return allNav ? clauses[clauses.length - 1] : undefined
}

/**
 * 导航类目标的确定性证据：目标里的特征词出现在"当前地址相对起始地址新增的那一段"里。
 */
export function urlChangeMatchesGoal(goal: string, startUrl: string, currentUrl: string): string | undefined {
  if (startUrl === '' || currentUrl === '' || startUrl === currentUrl) return undefined
  if (!NAVIGATION_GOALS.test(goal)) return undefined
  let delta = ''
  try {
    const start = new URL(startUrl)
    const current = new URL(currentUrl)
    const currentTail = `${current.pathname}${current.search}${current.hash}`.toLowerCase()
    if (start.origin === current.origin) {
      const startTail = `${start.pathname}${start.search}${start.hash}`.toLowerCase()
      if (currentTail === startTail) return undefined
      let shared = 0
      while (shared < startTail.length && shared < currentTail.length && startTail[shared] === currentTail[shared]) shared += 1
      delta = currentTail.slice(shared)
    } else {
      delta = currentTail
    }
  } catch {
    return undefined
  }
  if (delta === '') return undefined
  // 若是多跳纯导航目标（"Open the cart and go to checkout"），只认最终目的地子句里的词（"checkout"），
  // 避免在第一跳（/cart.html）就提前宣布完成。
  const targetScope = finalNavigationClauseOf(goal) ?? goal
  const stopWords = new Set(['open', 'goto', 'navigate', 'visit', 'follow', 'jump', 'page', 'link', 'site', 'from'])
  const tokens = goalTokensOf(targetScope).filter(
    (token) => /[a-z0-9]/.test(token) && token.length >= 4 && !stopWords.has(token),
  )
  return tokens.find((token) => delta.includes(token))
}

/** 控件名里的提交类动词（没有就是 undefined）。 */
export function submitControlOf(name: string): string | undefined {
  return SUBMIT_CONTROL_VERBS.exec(name.toLowerCase())?.[0]
}

/** 明显的浏览器错误页（导航失败）——正文"变了"但目标没达成。 */
export function looksLikeErrorPage(text: string, title = ''): boolean {
  const sample = `${title}\n${text}`.slice(0, 4000)
  return /(ERR_[A-Z_]{3,}|net::ERR_|This site can.t be reached|网页无法正常运作|无法访问此网站|该网页无法正常运作|DNS_PROBE)/i.test(sample)
}

/** 这一类目标不允许用"提交类控件已点击 + 页面变了"收尾。 */
export function namedSubmitGoal(goal: string): boolean {
  if (/(log ?in|sign ?in|sign ?up|登录|注册)/i.test(goal)) return false
  if (/(until|at least|exactly|至少|恰好|直到|正好)/i.test(goal)) return false
  return true
}

/** 调用方给的值是否全部已经在页面上生效（纯确定性，不看判断层）。 */
export function inputsApplied(
  candidates: readonly TaskCandidate[],
  inputs?: Readonly<Record<string, string>>,
  filled?: ReadonlyMap<string, string>,
  goal = '',
  verified?: ReadonlySet<string>,
): boolean {
  if (inputs === undefined) return false
  const entries = Object.entries(inputs)
  if (entries.length === 0) return false
  for (const [key, value] of entries) {
    if (verified?.has(key) === true) continue
    const single = { [key]: value }
    const matched = candidates.filter((candidate) => matchInputValue(candidate, single) !== undefined)
    if (matched.length === 0) return false
    const applied = matched.some(
      (candidate) => filled?.get(candidate.id) === value || isAlreadySatisfied(candidate, goal, single),
    )
    if (!applied) return false
  }
  return true
}

/** 页面上只有一个输入框、调用方又只给了一个值时的兜底绑定。 */
export function soleValueFor(
  candidates: readonly TaskCandidate[],
  inputs?: Readonly<Record<string, string>>,
): string | undefined {
  const entries = Object.entries(inputs ?? {})
  if (entries.length !== 1) return undefined
  const fields = candidates.filter((candidate) => candidate.kind === 'input')
  return fields.length === 1 ? entries[0][1] : undefined
}

/** "填一下、然后提交"这类两动作单目标（Type into X, then submit）。 */
export function fillThenSubmitGoal(goal: string): boolean {
  const dataEntry = /\b(fill|type|enter)\b/i.test(goal)
  const submit = /\b(submit|send|save|continue|next|search|log ?in)\b/i.test(goal)
  const extras = /\b(check|uncheck|select|choose|click|open|go to|add|remove|delete|buy|checkout)\b/i.test(goal)
  return dataEntry && submit && !extras
}

/** 目标是不是一个子目标：多子目标不能在第一步做完就按单步收尾。 */
export function singleStepGoal(goal: string): boolean {
  const multiStep = /(,\s*(and|then)\b|\bthen\b|\band then\b|[，、].*[，、]|然后|接着|随后)/i
  if (multiStep.test(goal)) return false
  const clauses = goal.split(/[,，;；]|\band\b/i).map((clause) => clause.trim()).filter((clause) => clause !== '')
  const actions = clauses.filter((clause) => {
    const words = clause.split(/\s+/).filter((word) => word !== '')
    return words.length >= 2 && /^(?:please\s+)?(?:log ?in|sign ?in|buy|purchase|add|open|go to|navigate|complete|checkout|fill|type|enter|submit|search|click|select|choose|pay|order|remove|delete)\b/i.test(clause)
  })
  return actions.length < 2
}

/** 下拉选择是否就是目标要的那个选项：选中的 label 出现在目标文字里。 */
export function selectionMatchesGoal(goal: string, candidate: TaskCandidate, given: string): string | undefined {
  const options = candidate.options
  if (options === undefined || options.length === 0) return undefined
  const option = options.find((item) => item.value === given || item.label === given)
  const label = (option?.label ?? given).trim()
  if (label === '') return undefined
  const normalize = (value: string): string => value.toLowerCase().replace(/[\s_]+/g, ' ').trim()
  return normalize(goal).includes(normalize(label)) ? label : undefined
}

/**
 * 从 choice 的完整概率分布里取次优候选。
 * `minProbability`：循环内调用时传入 `ALTERNATE_MIN_PROBABILITY`（0.25），
 * 防止在首选无效时去点 p=0.06 的无关链接把页面导航走。
 */
export function pickAlternate(
  probabilities: Readonly<Record<string, number>> | undefined,
  excluded: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  minProbability = 0,
): string | undefined {
  if (probabilities === undefined) return undefined
  const ranked = Object.entries(probabilities)
    .filter(
      ([id, probability]) =>
        allowed.has(id) &&
        !excluded.has(id) &&
        Number.isFinite(probability) &&
        probability > 0 &&
        probability >= minProbability,
    )
    .sort((left, right) => right[1] - left[1])
  return ranked[0]?.[0]
}

export { FOLLOW_UP_VERBS }
