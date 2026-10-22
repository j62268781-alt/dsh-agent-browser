/**
 * `src/task/gates.ts`：确定性门控、字段状态核对、URL/提交完成证据与次优候选选择。
 */

import {
  DISABLE_VERBS,
  ENABLE_VERBS,
  FOLLOW_UP_VERBS,
  NAVIGATION_GOALS,
  SECRET_KEY,
  SUBMIT_CONTROL_VERBS,
  TEXT_ENTRY_ROLES,
  type TaskCandidate,
} from './types.js'
import { fieldName, goalMentions, goalTokensOf, stemToken } from './utils.js'

/** 从抽取的 `state` 文本里读出"当前状态"。 */
export function stateOf(candidate: TaskCandidate): { checked?: boolean; value?: string; redacted?: boolean } {
  const state = candidate.state ?? ''
  if (state.includes('已勾选')) return { checked: true }
  if (state.includes('未勾选')) return { checked: false }
  if (state.includes('●●●')) return { redacted: true }
  const value = /当前值: (.*)$/.exec(state)?.[1] ?? /已有内容: (.*)$/.exec(state)?.[1]
  return value === undefined ? {} : { value: value.trim() }
}

/** 候选当前值是否已等于期望值（含原生 `<select>` 的 label ↔ value 映射，如 `Two` ↔ `2`）。 */
export function valueMatchesCandidate(candidate: TaskCandidate, currentValue: string, wanted: string): boolean {
  const cur = currentValue.trim()
  const target = wanted.trim()
  if (cur === target || cur.toLowerCase() === target.toLowerCase()) return true
  if (candidate.options !== undefined) {
    const matchedOpt = candidate.options.find(
      (opt) => opt.value.trim() === cur || opt.label.trim().toLowerCase() === cur.toLowerCase(),
    )
    if (
      matchedOpt !== undefined &&
      (matchedOpt.label.trim().toLowerCase() === target.toLowerCase() || matchedOpt.value.trim() === target)
    ) {
      return true
    }
  }
  return false
}
/** 调用方给的字段值 → 候选。模糊匹配只接受完整词组前缀，且必须唯一。 */
export function matchInputValue(candidate: TaskCandidate, inputs?: Readonly<Record<string, string>>): string | undefined {
  if (inputs === undefined) return undefined
  const name = fieldName(candidate.name ?? '')
  if (name === '') return undefined
  const entries = Object.entries(inputs).map(([key, value]) => ({ key: fieldName(key), value }))
  const exact = entries.filter((entry) => entry.key !== '' && entry.key === name)
  if (exact.length === 1) return exact[0]?.value
  if (exact.length > 1) return undefined
  const paddedName = ` ${name} `
  const fuzzy = entries.filter(
    (entry) =>
      entry.key !== '' &&
      (paddedName.includes(` ${entry.key} `) || ` ${entry.key} `.includes(paddedName)),
  )
  return fuzzy.length === 1 ? fuzzy[0]?.value : undefined
}

/** 在当前页面候选中建立无歧义的 key→字段映射；任何多对一或一对多都不自动绑定。 */
export function inputMatchesOf(
  candidates: readonly TaskCandidate[],
  inputs?: Readonly<Record<string, string>>,
): ReadonlyMap<string, { key: string; value: string }> {
  const result = new Map<string, { key: string; value: string }>()
  if (inputs === undefined) return result
  const fields = candidates.filter((candidate) => candidate.kind === 'input' || ['checkbox', 'radio', 'switch'].includes(candidate.role ?? ''))
  const entries = Object.entries(inputs).map(([key, value]) => ({ key, normalized: fieldName(key), value }))
  const exactKeys = new Set<string>()
  for (const entry of entries) {
    const exact = fields.filter((candidate) => fieldName(candidate.name ?? '') === entry.normalized)
    if (exact.length === 1) {
      const candidate = exact[0]!
      if (!result.has(candidate.id)) {
        result.set(candidate.id, { key: entry.key, value: entry.value })
        exactKeys.add(entry.key)
      }
    }
  }
  const fuzzyByField = new Map<string, Array<{ key: string; value: string }>>()
  for (const entry of entries) {
    if (exactKeys.has(entry.key) || entry.normalized === '') continue
    const paddedEntry = ` ${entry.normalized} `
    const matches = fields.filter((candidate) => {
      if (result.has(candidate.id)) return false
      const name = fieldName(candidate.name ?? '')
      if (name === '') return false
      const paddedName = ` ${name} `
      return paddedName.includes(paddedEntry) || paddedEntry.includes(paddedName)
    })
    if (matches.length === 1) {
      const candidate = matches[0]!
      const list = fuzzyByField.get(candidate.id) ?? []
      list.push({ key: entry.key, value: entry.value })
      fuzzyByField.set(candidate.id, list)
    }
  }
  for (const [id, matches] of fuzzyByField) {
    if (matches.length === 1) result.set(id, matches[0]!)
  }

  // 物理与组拓扑兜底绑定（零页面文字依赖：支持外语/无 label 的登录组与 300-input 页面）：
  // 1) 未绑定的密钥类 key ↔ 页面唯一的物理密码框（groupRole === 'password' 或 inputType === 'password'）；
  // 2) 同组（或紧邻拓扑推导出的）唯一 groupRole === 'username' 文本框 ↔ 剩余唯一的账号/非密钥 key。
  const boundKeys = new Set([...result.values()].map((item) => item.key))
  const unboundEntries = entries.filter((entry) => !boundKeys.has(entry.key))
  if (unboundEntries.length > 0) {
    const secretEntries = unboundEntries.filter((entry) => SECRET_KEY.test(entry.key))
    const physicalPwds = fields.filter(
      (candidate) =>
        !result.has(candidate.id) &&
        (candidate.groupRole === 'password' || candidate.inputType === 'password'),
    )
    if (secretEntries.length === 1 && physicalPwds.length === 1) {
      result.set(physicalPwds[0]!.id, { key: secretEntries[0]!.key, value: secretEntries[0]!.value })
      boundKeys.add(secretEntries[0]!.key)
    }

    const remainingNonSecret = entries.filter((entry) => !boundKeys.has(entry.key) && !SECRET_KEY.test(entry.key))
    const physicalUsers = fields.filter(
      (candidate) => !result.has(candidate.id) && candidate.groupRole === 'username',
    )
    if (remainingNonSecret.length === 1 && physicalUsers.length === 1) {
      result.set(physicalUsers[0]!.id, {
        key: remainingNonSecret[0]!.key,
        value: remainingNonSecret[0]!.value,
      })
    }
  }

  return result
}

/**
 * 判断候选是否是当前目标点名要切换的勾选/单选控件（支持多子句，如 "Check checkbox 1 and uncheck checkbox 2" 或 "Select the second radio button"）。
 */
export function isTargetToggleCandidate(candidate: TaskCandidate, goal: string): boolean {
  if ((candidate.state ?? '').includes('已禁用')) return false
  const role = (candidate.role ?? '').toLowerCase()
  if (role !== 'checkbox' && role !== 'radio' && role !== 'switch') return false
  if (/\bradio\b/i.test(goal) && !/\bcheckbox\b/i.test(goal) && role !== 'radio') return false
  if (/\bcheckbox\b/i.test(goal) && !/\bradio\b/i.test(goal) && role !== 'checkbox') return false
  const desc = candidate.description.toLowerCase()
  const clauses = goal.split(/[,，;；]|\band\b|\bthen\b/i).map((clause) => clause.trim()).filter(Boolean)
  const candidateKey = fieldName(candidate.name ?? '')
  const matchesOrdinalClause = (clause: string): boolean => {
    if (!clause.toLowerCase().includes(role)) return false
    if (desc.includes(' #1') && /\b(first|1st)\b|第一|首个/i.test(clause)) return true
    if (desc.includes(' #2') && /\b(second|2nd)\b|第二/i.test(clause)) return true
    if (desc.includes(' #3') && /\b(third|3rd)\b|第三/i.test(clause)) return true
    return false
  }
  const matchedClause =
    clauses.length > 1
      ? (candidateKey !== '' ? clauses.find((clause) => fieldName(clause).includes(candidateKey)) : undefined) ??
        (candidateKey !== '' ? clauses.find((clause) => goalMentions(candidate.name ?? '', clause)) : undefined) ??
        clauses.find(matchesOrdinalClause)
      : undefined
  const scope = matchedClause ?? goal
  if (
    (/\b(first|1st)\b|第一|首个/i.test(scope) && desc.includes(' #') && !desc.includes(' #1')) ||
    (/\b(second|2nd)\b|第二/i.test(scope) && desc.includes(' #') && !desc.includes(' #2')) ||
    (/\b(third|3rd)\b|第三/i.test(scope) && desc.includes(' #') && !desc.includes(' #3'))
  ) {
    return false
  }
  const namedOrOrdinal =
    ((candidate.name ?? '') !== '' && ( (candidateKey !== '' && fieldName(scope).includes(candidateKey)) || goalMentions(candidate.name ?? '', scope) )) ||
    matchesOrdinalClause(scope)
  if (!namedOrOrdinal) return false
  const radioSelectVerb = role === 'radio' && /\b(select|choose|pick)\b|选择|选/i.test(scope)
  return (
    ((ENABLE_VERBS.test(scope) || radioSelectVerb) && !DISABLE_VERBS.test(scope)) ||
    (DISABLE_VERBS.test(scope) && !ENABLE_VERBS.test(scope))
  )
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
    const role = (candidate.role ?? '').toLowerCase()
    const desc = candidate.description.toLowerCase()
    const clauses = goal.split(/[,，;；]|\band\b|\bthen\b/i).map((clause) => clause.trim()).filter(Boolean)
    const candidateKey = fieldName(candidate.name ?? '')
    const matchesOrdinalClause = (clause: string): boolean => {
      if (role !== '' && !clause.toLowerCase().includes(role)) return false
      if (desc.includes(' #1') && /\b(first|1st)\b|第一|首个/i.test(clause)) return true
      if (desc.includes(' #2') && /\b(second|2nd)\b|第二/i.test(clause)) return true
      if (desc.includes(' #3') && /\b(third|3rd)\b|第三/i.test(clause)) return true
      return false
    }
    const matchedClause =
      clauses.length > 1
        ? (candidateKey !== '' ? clauses.find((clause) => fieldName(clause).includes(candidateKey)) : undefined) ??
          (candidateKey !== '' ? clauses.find((clause) => goalMentions(candidate.name ?? '', clause)) : undefined) ??
          clauses.find(matchesOrdinalClause)
        : undefined
    // 若目标明确指定了第 N 个同角色控件（如 "Select the second radio button"），而当前候选是其它序号（如 radio #1），
    // 则当前候选不是目标要选的那一个，不能算"已满足目标"。
    const checkScope = matchedClause ?? goal
    if (
      (/\b(first|1st)\b|第一|首个/i.test(checkScope) && desc.includes(' #') && !desc.includes(' #1')) ||
      (/\b(second|2nd)\b|第二/i.test(checkScope) && desc.includes(' #') && !desc.includes(' #2')) ||
      (/\b(third|3rd)\b|第三/i.test(checkScope) && desc.includes(' #') && !desc.includes(' #3'))
    ) {
      return false
    }
    // 多子句时若某个框名字没对上任何子句，不做全局判断，避免把"别的框要勾选"套到当前框上。
    if (clauses.length > 1 && matchedClause === undefined && ENABLE_VERBS.test(goal) && DISABLE_VERBS.test(goal)) {
      return false
    }
    const scope = matchedClause ?? goal
    const radioSelectVerb = role === 'radio' && /\b(select|choose|pick)\b|选择|选/i.test(scope)
    if ((ENABLE_VERBS.test(scope) || radioSelectVerb) && !DISABLE_VERBS.test(scope)) return state.checked
    if (DISABLE_VERBS.test(scope) && !ENABLE_VERBS.test(scope)) return !state.checked
    return false
  }
  if (state.redacted === true) {
    return (
      matchInputValue(candidate, inputs) !== undefined ||
      (inputs !== undefined && Object.keys(inputs).some((key) => SECRET_KEY.test(key)))
    )
  }
  if (state.value !== undefined) {
    const wanted = matchInputValue(candidate, inputs)
    if (wanted !== undefined) return valueMatchesCandidate(candidate, state.value, wanted)
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
  const inputMatches = inputMatchesOf(candidates, inputs)
  for (const candidate of candidates) {
    if (candidate.kind !== 'input' && candidate.role !== 'checkbox' && candidate.role !== 'radio' && candidate.role !== 'switch') continue
    if ((candidate.state ?? '').includes('已禁用')) continue
    const wanted = inputMatches.get(candidate.id)?.value
    if (wanted === undefined) continue
    const state = stateOf(candidate)
    if (state.redacted === true) continue
    if (state.checked !== undefined) {
      const wantChecked = /^(1|true|yes|on|y|是)$/i.test(wanted.trim())
      if (state.checked !== wantChecked) return candidate
      continue
    }
    if (state.value !== undefined && !valueMatchesCandidate(candidate, state.value, wanted)) {
      if (!specificallyNamed(candidate, inputs)) continue
      return candidate
    }
    if (state.value === undefined) {
      if (exhausted?.has(candidate.id) === true) continue
      if (consumedByEnter?.has(candidate.id) === true) continue
      if (filled?.has(candidate.id) === true) return candidate
      if (filled !== undefined && [...filled.values()].includes(wanted)) continue
      if (specificallyNamed(candidate, inputs)) return candidate
      if (
        candidate.groupRole === 'username' ||
        candidate.groupRole === 'password' ||
        candidate.inputType === 'password'
      ) {
        return candidate
      }
      if (goal !== undefined && goalMentions(candidate.name ?? '', goal)) return candidate
    }
  }
  // 页面上只有唯一一个可用文本输入框（如 ti-dynamic-controls 解禁后的 input，或 TodoMVC 的新建框）、当前为空，
  // 且调用方给的值还有未生效的项 → 确定性绑定到该唯一输入框。
  const entries = Object.entries(inputs)
  if (entries.length === 1 && goal !== undefined && /\b(type|fill|enter|input)\b|输入|填写/i.test(goal)) {
    const [onlyKey, onlyVal] = entries[0]
    const alreadyFilled =
      consumedValues?.has(onlyVal) === true ||
      [...(filled?.values() ?? [])].includes(onlyVal) ||
      candidates.some((c) => isAlreadySatisfied(c, goal, { [onlyKey]: onlyVal }))
    if (!alreadyFilled) {
      const enabledTextInputs = candidates.filter(
        (candidate) =>
          candidate.kind === 'input' &&
          isTextEntry(candidate) &&
          !(candidate.state ?? '').includes('已禁用'),
      )
      if (enabledTextInputs.length === 1) {
        const only = enabledTextInputs[0]
        if (
          exhausted?.has(only.id) !== true &&
          consumedByEnter?.has(only.id) !== true &&
          stateOf(only).value === undefined
        ) {
          return only
        }
      }
    }
  }
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

const ORDERED_CONTENT_TARGET = /\b(?:top|first|1st|second|2nd|third|3rd|latest|last|best|highest[- ]ranked)\s+(?:story|stories|article|result|item|post|entry|record|row|table)\b/i
const CONTENT_LINK_ROLES = new Set(['a', 'link', 'tab', 'menuitem'])

/** 目标明确限定到列表/文章中的某条目时，不能把全局导航里的同名链接当作目标。 */
export function requiresPrimaryContentTarget(goal: string): boolean {
  return ORDERED_CONTENT_TARGET.test(goal)
}

export function filterModeOfGoal(goal: string): 'completed' | 'active' | undefined {
  return /\bcompleted\b|\bcomplete\b|已完成|完成项/i.test(goal)
    ? 'completed'
    : /\bactive\b|\bpending\b|未完成|进行中/i.test(goal)
      ? 'active'
      : undefined
}

export function isListFilterGoal(goal: string): boolean {
  return filterModeOfGoal(goal) !== undefined && /\b(?:show|display|view|filter)\b|\bonly\b|显示|筛选|只看/i.test(goal)
}

export function filterRouteMatchesGoal(goal: string, currentUrl: string): boolean | undefined {
  const mode = filterModeOfGoal(goal)
  if (!isListFilterGoal(goal) || mode === undefined) return undefined
  let route: string
  try {
    const url = new URL(currentUrl)
    route = `${url.pathname}${url.search}${url.hash}`.toLowerCase()
  } catch {
    return false
  }
  return new RegExp(`(?:^|[/#?&=_-])${mode}(?:$|[/#?&=_-])`).test(route)
}

/** 限定内容条目的目标排除已识别的全局导航链接；筛选目标保留匹配筛选选项。 */
export function scopeCandidatesOf<T extends TaskCandidate>(goal: string, candidates: readonly T[]): T[] {
  if (!requiresPrimaryContentTarget(goal)) return [...candidates]
  const contentLinks = candidates.filter(
    (candidate) =>
      candidate.kind === 'click' &&
      CONTENT_LINK_ROLES.has((candidate.role ?? '').toLowerCase()) &&
      candidate.inMain !== false,
  )
  const hasGroupedContentLink = contentLinks.some((candidate) => candidate.groupId !== undefined)
  const groupedMatches = new Map<string, number>()
  for (const candidate of contentLinks) {
    if (candidate.groupId === undefined || !goalMentions(candidate.name ?? '', goal)) continue
    const index = Number(/:(\d+)$/.exec(candidate.id)?.[1] ?? Number.MAX_SAFE_INTEGER)
    groupedMatches.set(candidate.groupId, Math.min(groupedMatches.get(candidate.groupId) ?? Number.MAX_SAFE_INTEGER, index))
  }
  const orderedGroups = [...groupedMatches].sort((left, right) => left[1] - right[1])
  const ordinal = /\b(?:second|2nd)\b|第二/i.test(goal) ? 2 : /\b(?:third|3rd)\b|第三/i.test(goal) ? 3 : 1
  const targetGroup = orderedGroups[ordinal - 1]?.[0]

  return candidates.filter((candidate) => {
    if (candidate.kind === 'control') return true
    if (targetGroup !== undefined) {
      return candidate.kind === 'click' &&
        CONTENT_LINK_ROLES.has((candidate.role ?? '').toLowerCase()) &&
        candidate.groupId === targetGroup &&
        goalMentions(candidate.name ?? '', goal)
    }
    if (candidate.kind !== 'click' || !CONTENT_LINK_ROLES.has((candidate.role ?? '').toLowerCase())) return true
    if (candidate.inMain === false) return false
    // Some table-based pages wrap the page header in the same <table> as content.
    // A row-grouped content link is stronger scope evidence than an ungrouped global/header link.
    if (hasGroupedContentLink && candidate.inMain === true && candidate.groupId === undefined) return false
    return true
  })
}

/** 可识别列表筛选目标时，要求路由与当前可见 checkbox 状态一致。 */
export function filterStateMatchesGoal(
  goal: string,
  candidates: readonly TaskCandidate[],
  currentUrl: string,
): boolean | undefined {
  const mode = filterModeOfGoal(goal)
  const routeMatches = filterRouteMatchesGoal(goal, currentUrl)
  if (!isListFilterGoal(goal) || mode === undefined || routeMatches === undefined) return undefined
  if (!routeMatches) return false

  const visibleToggles = candidates.filter(
    (candidate) => candidate.kind === 'click' && (candidate.role ?? '').toLowerCase() === 'checkbox' && candidate.inMain !== false,
  )
  if (visibleToggles.length === 0) return false
  const expectedChecked = mode === 'completed'
  return visibleToggles.every((candidate) => (candidate.state ?? '').includes(expectedChecked ? '已勾选' : '未勾选'))
}

/** 目标点名的禁用输入框仍不可用，且页面没有启用入口时可直接交回宿主。 */
export function disabledTargetWithoutUnlock(
  goal: string,
  candidates: readonly TaskCandidate[],
): TaskCandidate | undefined {
  if (!/\bdisabled\b|禁用/i.test(goal)) return undefined
  const disabledTargets = candidates.filter(
    (candidate) =>
      candidate.kind === 'input' &&
      (candidate.state ?? '').includes('已禁用') &&
      goalMentions(candidate.name ?? '', goal),
  )
  if (disabledTargets.length !== 1) return undefined
  const canUnlock = candidates.some(
    (candidate) =>
      candidate.kind === 'click' &&
      /\b(enable|unlock|activate)\b|启用|解锁|激活/i.test(candidate.name ?? ''),
  )
  return canUnlock ? undefined : disabledTargets[0]
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
  return tokens.find((token) => hasUrlWordBoundary(delta, token))
}

/**
 * 目标词是否以**完整词**出现在地址增量里。
 *
 * 真机 hn-comments：目标 "...comments page of the top story"，点到了页头的 `newcomments` 链接，
 * 旧实现用 `delta.includes('comments')` 直接把 `/newcomments` 当成目标页 → 假完成。
 * 现在按非字母数字切成词再比对，并允许词干相等（`shakespeares` ↔ `shakespeare`）；
 * `/checkout-step-one.html`、`/cart.html`、`/item?id=1` 这类真实命中照旧成立。
 */
function hasUrlWordBoundary(delta: string, token: string): boolean {
  const words = delta.split(/[^a-z0-9]+/).filter((word) => word !== '')
  return words.some((word) => word === token || stemToken(word).includes(token))
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

/** 页面内联表单校验报错（如 "Error: Postal Code is required"），提示提交被拦截。 */
export function looksLikeInlineValidationError(text: string): boolean {
  const sample = text.slice(0, 2000)
  return /\b(?:error:\s*\S+[^\n]{0,80}\b(?:is required|cannot be empty|invalid)|\S+\s+is required\b)/i.test(sample)
}

/** 这一类目标不允许用"提交类控件已点击 + 页面变了"收尾。 */
export function namedSubmitGoal(goal: string): boolean {
  if (/(log ?in|sign ?in|sign ?up|登录|注册)/i.test(goal)) return false
  if (/(until|at least|exactly|至少|恰好|直到|正好)/i.test(goal)) return false
  return true
}

/** 原生表单控件：抽取一定能读回它的值（读回空 = 写入没生效，不能算已生效）。 */
function isReadableField(candidate: TaskCandidate): boolean {
  const tag = (candidate.tag ?? '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  // 整树路径的候选没有 tag：无法读回，不做"未生效"判定。
  return false
}

/** 这个字段当前是否**读回**了期望值（正向证据，不看"调用过什么动作"）。 */
function readsBackValue(candidate: TaskCandidate, value: string): boolean {
  const st = stateOf(candidate)
  if (st.redacted === true) return true
  if (st.checked !== undefined) return st.checked === /^(1|true|yes|on|y|是)$/i.test(value)
  if (st.value === undefined) return false
  return valueMatchesCandidate(candidate, st.value, value)
}

/** 本轮刚填过的字段：读回空串说明这次写入**没生效**（禁用/只读/被站点清空），不能当已完成。 */
function filledAndHolds(
  candidate: TaskCandidate,
  value: string,
  filled?: ReadonlyMap<string, string>,
): boolean {
  if (filled?.get(candidate.id) !== value) return false
  const st = stateOf(candidate)
  if (st.redacted === true || st.checked !== undefined) return true
  if (st.value === undefined) return !isReadableField(candidate)
  // 读到的是旧值 = 站点还没回写（异步更新）→ 信任本轮填值记账。
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
  // 目标点名要往**禁用**控件里输入，而那个控件现在仍然禁用：值不可能写进去，
  // 不能因为"别的字段填上了"就宣布完成（真机 neg-disabled 假完成归因）。
  if (/\bdisabled\b|禁用/i.test(goal) && candidates.some((candidate) => (candidate.state ?? '').includes('已禁用'))) {
    return false
  }
  const inputMatches = inputMatchesOf(candidates, inputs)
  for (const [key, value] of entries) {
    if (verified?.has(key) === true) continue
    // 若本轮已将 value 填入某个候选字段，且该字段当前仍保持该值（或为已打码密码框），直接视为已生效
    // （防止 webform-fine 中通用 key `{text: '09/16/2026'}` 在填完 Date picker 后又去检查 Text input 导致覆写）。
    const filledAndPresent = candidates.some((candidate) => filledAndHolds(candidate, value, filled))
    if (filledAndPresent) continue
    const single = { [key]: value }
    const matched = candidates.filter((candidate) => inputMatches.get(candidate.id)?.key === key)
    if (matched.length === 0) {
      // 唯一值 + 页面上已存在填入该值的输入框（如 ti-dynamic-controls 的匿名 textbox）：也算已生效
      const soleApplied = entries.length === 1 && candidates.some(
        (candidate) =>
          candidate.kind === 'input' &&
          (readsBackValue(candidate, value) || filledAndHolds(candidate, value, filled)),
      )
      if (soleApplied) continue
      return false
    }
    const applied = matched.some(
      (candidate) => readsBackValue(candidate, value) || isAlreadySatisfied(candidate, goal, single),
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

/**
 * 目标明确指定了第 N 个下拉框/输入框（如 "In the first dropdown on the page, choose the colour Purple"）：
 * 在尚未展开 `[role="option"]` 菜单时，直接定位 `combobox #N` / `select #N`。
 */
export function ordinalWidgetTargetOf(
  goal: string,
  candidates: readonly TaskCandidate[],
): TaskCandidate | undefined {
  const match = /\b(first|1st|second|2nd|third|3rd)\b[^.,;]{0,30}\b(dropdown|select|combobox)\b|第\s*([一二三123])\s*个\s*(?:下拉框|选择框)/i.exec(goal)
  if (match === null) return undefined
  if (candidates.some((candidate) => (candidate.role ?? '').toLowerCase() === 'option')) return undefined
  const raw = (match[1] ?? match[3] ?? '').toLowerCase()
  const ordinal = raw === 'second' || raw === '2nd' || raw === '2' || raw === '二' ? 2 : raw === 'third' || raw === '3rd' || raw === '3' || raw === '三' ? 3 : 1
  const widgets = candidates.filter((candidate) => {
    const role = (candidate.role ?? '').toLowerCase()
    return candidate.kind === 'input' && (role === 'combobox' || role === 'select')
  })
  if (widgets.length < ordinal) return undefined
  return (
    widgets.find((candidate) => new RegExp(`(?:combobox|select)\\s*#${ordinal}\\b`, 'i').test(candidate.description)) ??
    widgets[ordinal - 1]
  )
}

/**
 * 粗粒度多子句目标（如 "Fill in ..., choose the second radio button, then submit the form"）
 * 动态提取当前尚未完成的活动子句（activeClause），供 `rankByGoal` 聚焦当前阶段候选。
 */
export function activeClauseOf(
  goal: string,
  candidates: readonly TaskCandidate[],
  hasPendingField: boolean,
  hasUnsatisfiedTargetToggle: boolean,
): string {
  const clauses = goal
    .split(/[,，;；]|\band\b|\bthen\b|然后|接着|随后/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '')
  if (clauses.length <= 1) return goal
  if (hasPendingField) {
    const inputClause = clauses.find((clause) => /\b(fill|type|enter|input|write|log ?in|sign ?in)\b|输入|填写|填入|登录/i.test(clause))
    if (inputClause !== undefined) return inputClause
  }
  if (hasUnsatisfiedTargetToggle) {
    const toggleClause = clauses.find(
      (clause) =>
        ENABLE_VERBS.test(clause) ||
        DISABLE_VERBS.test(clause) ||
        /\b(select|choose|pick)\b[^.]{0,40}\bradio\b/i.test(clause),
    )
    if (toggleClause !== undefined) return toggleClause
  }
  const hasVisibleOptionOrPopup = candidates.some((candidate) => (candidate.role ?? '').toLowerCase() === 'option')
  if (!hasVisibleOptionOrPopup && clauses.length === 2 && /\b(open|expand)\b|打开|展开/i.test(clauses[0])) {
    return clauses[0]
  }
  return clauses[clauses.length - 1] ?? goal
}
