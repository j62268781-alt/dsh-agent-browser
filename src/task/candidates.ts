/**
 * `src/task/candidates.ts`：候选枚举、按目标相关性排序、特殊动作面（按键/悬停/拖拽）注入。
 */

import type { Snapshot } from '../cli.js'
import { handleOf, type ExtractedItem } from '../extract.js'
import {
  CLICKABLE_ROLES,
  CONTROL_CANDIDATES,
  MAX_CLICK_CANDIDATES,
  type TaskCandidate,
} from './types.js'
import {
  expandedGoalTokensOf,
  goalTokensOf,
  hasTokenBoundary,
  keysWantedByGoal,
  wantsDrag,
  wantsHover,
} from './utils.js'

/** 候选预算：先按目标词面与结构信号统一排序，再为输入类保留一个首轮代表位。 */
export function headCandidates(
  clicks: readonly TaskCandidate[],
  inputs: readonly TaskCandidate[],
  goal: string,
): TaskCandidate[] {
  const ranked = rankByGoal([...clicks, ...inputs], goal)
  const head = ranked.slice(0, MAX_CLICK_CANDIDATES)
  const bestInput = rankByGoal(inputs, goal)[0]
  if (bestInput !== undefined && !head.slice(0, 10).some((candidate) => candidate.kind === 'input')) {
    const existing = head.findIndex((candidate) => candidate.id === bestInput.id)
    if (existing >= 0) head.splice(existing, 1)
    head.splice(Math.min(9, head.length), 0, bestInput)
  }
  return head.slice(0, MAX_CLICK_CANDIDATES)
}

const WIDGET_ORDINAL_ROLES = new Set(['radio', 'checkbox', 'combobox', 'switch'])
const TEXT_INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'input', 'textarea'])
type GroupRole = 'username' | 'password' | 'submit' | 'search' | 'otp'

/** 从标准输入属性和 form/group 拓扑推导角色，不读取候选名称或附近文案。 */
export function inferGroupRoles(items: readonly ExtractedItem[]): ReadonlyMap<number, GroupRole> {
  const roles = new Map<number, GroupRole>()
  const visible = items.filter((item) => !item.covered)

  for (const item of visible) {
    const ac = (item.autocomplete ?? '').toLowerCase()
    const acField = ac.split(' ').pop() ?? ''
    const inputType = (item.inputType ?? '').toLowerCase()
    const role = item.role.toLowerCase()
    if (acField === 'one-time-code') {
      roles.set(item.index, 'otp')
    } else if (
      inputType === 'password' ||
      acField === 'current-password' ||
      acField === 'new-password'
    ) {
      roles.set(item.index, 'password')
    } else if (acField === 'username') {
      roles.set(item.index, 'username')
    } else if (inputType === 'search' || role === 'searchbox') {
      roles.set(item.index, 'search')
    } else if (inputType === 'submit') {
      roles.set(item.index, 'submit')
    }
  }

  const related = new Map<string, ExtractedItem[]>()
  for (const item of visible) {
    const key = item.formId !== undefined
      ? `form:${item.formId}`
      : item.groupId !== undefined
        ? `group:${item.groupId}`
        : undefined
    if (key === undefined) continue
    const members = related.get(key) ?? []
    members.push(item)
    related.set(key, members)
  }

  for (const members of related.values()) {
    const passwords = members.filter((item) => roles.get(item.index) === 'password')
    if (passwords.length !== 1) continue
    const password = passwords[0]!
    const unassignedBefore = members.filter(
      (item) =>
        item.index < password.index &&
        TEXT_INPUT_ROLES.has(item.role.toLowerCase()) &&
        !roles.has(item.index),
    )
    if (unassignedBefore.length === 1) {
      roles.set(unassignedBefore[0]!.index, 'username')
    }

    const explicitSubmits = members.filter((item) => item.inputType === 'submit')
    if (explicitSubmits.length === 1) {
      roles.set(explicitSubmits[0]!.index, 'submit')
    } else if (explicitSubmits.length === 0) {
      const trailingButtons = members.filter(
        (item) => item.index > password.index && item.role.toLowerCase() === 'button',
      )
      if (trailingButtons.length === 1) roles.set(trailingButtons[0]!.index, 'submit')
    }
  }

  return roles
}

function groupSignaturesOf(
  items: readonly ExtractedItem[],
  roles: ReadonlyMap<number, GroupRole>,
): ReadonlyMap<string, string> {
  const grouped = new Map<string, ExtractedItem[]>()
  for (const item of items) {
    if (item.covered || item.groupId === undefined || item.role.toLowerCase() === 'label') continue
    const members = grouped.get(item.groupId) ?? []
    members.push(item)
    grouped.set(item.groupId, members)
  }
  return new Map(
    [...grouped].map(([groupId, members]) => {
      const signature = members
        .sort((left, right) => left.index - right.index)
        .map((item) => {
          const semantic = roles.get(item.index)
          const physical = semantic ?? item.inputType ?? item.role.toLowerCase()
          return `${item.role.toLowerCase()}:${physical}`
        })
        .join('+')
      return [groupId, signature]
    }),
  )
}

/** 页面内抽取（`extract()`）→ 候选：句柄 + 角色 + 名字 + 同簇/同控件序号，遮挡的默认不进池。 */
export function candidatesFromExtracted(items: readonly ExtractedItem[], goal = ''): TaskCandidate[] {
  const clicks: TaskCandidate[] = []
  const inputs: TaskCandidate[] = []
  const groupRoles = inferGroupRoles(items)
  const groupSignatures = groupSignaturesOf(items, groupRoles)

  const nameClusterTotals = new Map<string, number>()
  const roleTotals = new Map<string, number>()
  for (const item of items) {
    const role = item.role.toLowerCase()
    const nameKey = `${role}\u0000${item.name.trim().toLowerCase()}`
    if (item.name.trim() !== '') {
      nameClusterTotals.set(nameKey, (nameClusterTotals.get(nameKey) ?? 0) + 1)
    }
    if (WIDGET_ORDINAL_ROLES.has(role)) {
      roleTotals.set(role, (roleTotals.get(role) ?? 0) + 1)
    }
  }

  const nameClusterSeen = new Map<string, number>()
  const roleSeen = new Map<string, number>()

  for (const item of items) {
    const role = item.role.toLowerCase()
    const nameTrimmed = item.name.trim()
    const nameKey = `${role}\u0000${nameTrimmed.toLowerCase()}`
    let ordinalTag = ''
    if (nameTrimmed !== '' && (nameClusterTotals.get(nameKey) ?? 0) >= 2) {
      const nextOrd = (nameClusterSeen.get(nameKey) ?? 0) + 1
      nameClusterSeen.set(nameKey, nextOrd)
      ordinalTag = ` #${nextOrd}`
    } else if (WIDGET_ORDINAL_ROLES.has(role) && (roleTotals.get(role) ?? 0) >= 2) {
      const nextOrd = (roleSeen.get(role) ?? 0) + 1
      roleSeen.set(role, nextOrd)
      ordinalTag = ` #${nextOrd}`
    }
    if (item.covered) continue

    const groupRole = groupRoles.get(item.index)
    const roleTag = role
    const state = item.state === undefined || item.state === '' ? '' : `，${item.state}`
    const near = item.near === undefined || item.near === item.name ? '' : `，附近: ${item.near.slice(0, 60)}`
    const groupNote =
      item.groupLabel !== undefined &&
      item.groupLabel !== '' &&
      item.groupLabel !== item.name &&
      !(item.near ?? '').includes(item.groupLabel)
        ? `，组: ${item.groupLabel}`
        : ''
    const label =
      item.name === ''
        ? `（无名称的 ${roleTag}${ordinalTag}${state}${near}${groupNote}）`
        : `「${item.name}」（${roleTag}${ordinalTag}${state}${near}${groupNote}）`
    const candidate: TaskCandidate = {
      id: `click:${item.index}`,
      description: `点击${label}`,
      kind: 'click',
      ref: handleOf(item.index),
      role,
      name: item.name,
      state: item.state,
      ...(item.options === undefined ? {} : { options: item.options.map(([optionLabel, optionValue]) => ({ label: optionLabel, value: optionValue })) }),
      ...(item.near === undefined || item.near === item.name ? {} : { near: item.near }),
      ...(item.tag === undefined ? {} : { tag: item.tag }),
      ...(item.inMain === undefined ? {} : { inMain: item.inMain }),
      ...(item.inputType === undefined ? {} : { inputType: item.inputType }),
      ...(item.autocomplete === undefined ? {} : { autocomplete: item.autocomplete }),
      ...(item.groupId === undefined ? {} : { groupId: item.groupId }),
      ...(item.groupLabel === undefined ? {} : { groupLabel: item.groupLabel }),
      ...(item.formId === undefined ? {} : { formId: item.formId }),
      ...(item.groupId === undefined || groupSignatures.get(item.groupId) === undefined
        ? {}
        : { groupSignature: groupSignatures.get(item.groupId)! }),
      ...(groupRole === undefined ? {} : { groupRole }),
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'input' || role === 'textarea' || role === 'select') {
      inputs.push({ ...candidate, id: `input:${item.index}`, description: `在${label}里输入/选择`, kind: 'input' })
    } else {
      clicks.push(candidate)
    }
  }
  return headCandidates(clicks, inputs, goal)
}

function outlineRoleOf(candidate: TaskCandidate): string {
  const role = (candidate.role ?? candidate.kind).toLowerCase()
  if (candidate.groupRole !== undefined) return `${role}:${candidate.groupRole}`
  if (candidate.inputType !== undefined && candidate.inputType !== '' && candidate.inputType !== 'text') {
    return `${role}:${candidate.inputType}`
  }
  const state = candidate.state ?? ''
  if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    if (state.includes('已勾选')) return `${role}:checked`
    if (state.includes('未勾选')) return `${role}:unchecked`
    if (state.includes('已选中')) return `${role}:selected`
  }
  if (state.includes('已禁用')) return `${role}:disabled`
  return role
}

/** 紧凑结构大纲：仅保留角色/物理类型/重复数量，不复制 action options 的文案。 */
export function groupOutlineOf(candidates: readonly TaskCandidate[]): string {
  const groups = new Map<string, TaskCandidate[]>()
  const standalone: TaskCandidate[] = []
  for (const candidate of candidates) {
    if (candidate.kind === 'control') continue
    const key = candidate.groupId !== undefined
      ? `group:${candidate.groupId}`
      : candidate.formId !== undefined
        ? `form:${candidate.formId}`
        : undefined
    if (key === undefined) {
      standalone.push(candidate)
    } else {
      const members = groups.get(key) ?? []
      members.push(candidate)
      groups.set(key, members)
    }
  }

  const signatureOf = (members: readonly TaskCandidate[]): string => {
    const explicit = members.find((candidate) => candidate.groupSignature !== undefined)?.groupSignature
    return explicit ?? members.map(outlineRoleOf).sort().join('+')
  }
  const repeatedGroups = new Map<string, number>()
  for (const members of groups.values()) {
    const signature = signatureOf(members)
    repeatedGroups.set(signature, (repeatedGroups.get(signature) ?? 0) + 1)
  }

  const lines: string[] = []
  if (groups.size > 0) {
    const rendered = new Set<string>()
    for (const members of groups.values()) {
      const signature = signatureOf(members)
      if (rendered.has(signature)) continue
      rendered.add(signature)
      const count = repeatedGroups.get(signature) ?? 1
      lines.push(`group${count > 1 ? `×${count}` : ''}: ${signature.split('+').join(' + ')}`)
    }
  }
  if (standalone.length > 0) {
    const counts = new Map<string, number>()
    for (const candidate of standalone) {
      const role = outlineRoleOf(candidate)
      counts.set(role, (counts.get(role) ?? 0) + 1)
    }
    lines.push(`standalone: ${[...counts].map(([role, count]) => `${role}${count > 1 ? `×${count}` : ''}`).join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * 按弱词面信号与 DOM 结构排序（不推断自然语言意图）：
 * 1. goal 与候选原文的通用 token 重合仅作为软排序；
 * 2. 标准 role、物理输入槽位与 2–6 控件分组提供语言无关的结构先验；
 * 3. 主内容区、禁用状态和重复组多样性用于抑制噪声，不决定目标语义。
 */
export function rankByGoal<T extends TaskCandidate>(list: readonly T[], goal: string): T[] {
  const tokens = expandedGoalTokensOf(goal)
  const hasStructureSignal = list.some(
    (candidate) =>
      candidate.inMain !== undefined ||
      candidate.groupId !== undefined ||
      candidate.groupRole !== undefined ||
      candidate.groupSignature !== undefined ||
      candidate.inputType !== undefined,
  )
  if (tokens.length === 0 && !hasStructureSignal) return [...list]

  const groupSizes = new Map<string, number>()
  const groupRolesList = new Map<string, string[]>()
  const groupSignatures = new Map<string, string>()
  for (const candidate of list) {
    const gid = candidate.groupId
    if (gid !== undefined && gid !== '') {
      groupSizes.set(gid, (groupSizes.get(gid) ?? 0) + 1)
      const arr = groupRolesList.get(gid) ?? []
      arr.push((candidate.role ?? '').toLowerCase())
      groupRolesList.set(gid, arr)
      if (candidate.groupSignature !== undefined) groupSignatures.set(gid, candidate.groupSignature)
    }
  }

  const lexicalScore = (candidate: TaskCandidate): number => {
    const name = (candidate.name ?? '').toLowerCase().trim()
    const near = (candidate.near ?? '').toLowerCase()
    const state = (candidate.state ?? '').toLowerCase()
    const role = (candidate.role ?? '').toLowerCase()
    const gLabel = (candidate.groupLabel ?? '').toLowerCase()

    let total = 0
    for (const token of tokens) {
      if (name !== '' && name === token) {
        total += 4
      } else if (name !== '' && hasTokenBoundary(name, token)) {
        total += 3
      } else if (name !== '' && name.includes(token)) {
        total += 1.5
      } else if (near !== '' && hasTokenBoundary(near, token)) {
        total += 2
      } else if (near !== '' && near.includes(token)) {
        total += 1
      } else if (gLabel !== '' && gLabel.includes(token)) {
        total += 1.5
      } else if (state.includes(token) || role.includes(token)) {
        total += 1
      }
      if (name !== '' && hasTokenBoundary(name, token) && near !== '') {
        if (hasTokenBoundary(near, token)) total += 2
        else if (near.includes(token)) total += 1
      }
    }
    return total
  }

  const groupHasLexicalHit = new Set<string>()
  for (const candidate of list) {
    if (candidate.groupId !== undefined && lexicalScore(candidate) > 0) {
      groupHasLexicalHit.add(candidate.groupId)
    }
  }

  const baseScore = (candidate: TaskCandidate): number => {
    const state = (candidate.state ?? '').toLowerCase()
    const role = (candidate.role ?? '').toLowerCase()

    let total = lexicalScore(candidate)
    if (role === 'combobox') total += 2
    else if (role === 'option') total += 1
    else if (role === 'checkbox' || role === 'radio' || role === 'switch') total += 0.5
    if (state.includes('已禁用')) total -= 3

    // 物理拓扑槽位加分（零页面文字依赖）
    if (candidate.groupRole === 'username' || candidate.groupRole === 'password') {
      total += 2.5
    } else if (candidate.groupRole === 'submit') {
      total += 1.5
    } else if (candidate.groupRole === 'search') {
      total += 2.0
    }
    // 紧凑的独立小容器分组（2–6 个元素）优先于散落控件
    if (candidate.groupId !== undefined) {
      const gSize = groupSizes.get(candidate.groupId) ?? 0
      if (gSize >= 2 && gSize <= 6) total += 0.35
    }
    if (candidate.inMain === true) {
      total += 0.5
    } else if (candidate.inMain === false && total === 0) {
      total -= 0.5
    }
    return total
  }

  const unmatchedClusters = new Map<string, number>()
  const unnamedClusters = new Map<string, number>()
  const groupOrdinalById = new Map<string, number>()
  const groupSignatureCounts = new Map<string, number>()
  for (const candidate of list) {
    const gid = candidate.groupId
    if (gid === undefined || gid === '' || groupOrdinalById.has(gid)) continue
    const signature = groupSignatures.get(gid) ?? [...(groupRolesList.get(gid) ?? [])].sort().join('+')
    const ordinal = (groupSignatureCounts.get(signature) ?? 0) + 1
    groupSignatureCounts.set(signature, ordinal)
    groupOrdinalById.set(gid, ordinal)
  }

  return list
    .map((candidate, index) => {
      let score = baseScore(candidate)
      const nameKey = (candidate.name ?? '').trim().toLowerCase()
      const roleKey = (candidate.role ?? '').toLowerCase()
      const gid = candidate.groupId

      if (score <= 0.9 && candidate.groupRole === undefined) {
        if (nameKey !== '') {
          const clusterKey = `${roleKey}\u0000${nameKey}`
          const count = (unmatchedClusters.get(clusterKey) ?? 0) + 1
          unmatchedClusters.set(clusterKey, count)
          if (count > 2) score -= 5
        } else {
          // 无名同角色封顶（如 300 个无名 input）：最多保留前 2 个在第一梯队
          const uKey = `${gid ?? ''}\u0000${roleKey}`
          const count = (unnamedClusters.get(uKey) ?? 0) + 1
          unnamedClusters.set(uKey, count)
          if (count > 2) score -= 5
        }
      }

      if (
        gid !== undefined &&
        !groupHasLexicalHit.has(gid) &&
        (groupOrdinalById.get(gid) ?? 0) > 2
      ) {
        score -= 3.5
      }
      return { candidate, index, score }
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((row) => row.candidate)
}

/** 快照 → 候选。文本输入字段单独标注 `input:*`（让循环知道该交回宿主）。 */
export function candidatesOf(snapshot: Snapshot, goal = ''): TaskCandidate[] {
  const clicks: TaskCandidate[] = []
  const inputs: TaskCandidate[] = []
  for (const [ref, info] of Object.entries(snapshot.refs)) {
    const role = info.role.toLowerCase()
    if (!CLICKABLE_ROLES.has(role) && info.clickable !== true) continue
    const name = info.name.trim()
    const label = name === '' ? `（无名称的 ${role}，ref @${ref}）` : `「${name}」（${role}，ref @${ref}）`
    const candidate: TaskCandidate = {
      id: `click:${ref}`,
      description: `点击${label}`,
      kind: 'click',
      ref: `@${ref}`,
      role,
      name,
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      inputs.push({ ...candidate, id: `input:${ref}`, description: `在${label}里输入/选择`, kind: 'input' })
    } else {
      clicks.push(candidate)
    }
  }
  const head = headCandidates(clicks, inputs, goal)
  const controls: TaskCandidate[] = [...CONTROL_CANDIDATES]
  return [...head, ...controls]
}

/**
 * 目标明确"把「某商品」加入购物车"、且页面上恰好一个 add-to-cart 控件的
 * 名字/上下文对得上目标 → 返回它（确定性动作，不猜）。
 */
export function addToCartTarget(goal: string, candidates: readonly TaskCandidate[]): TaskCandidate | undefined {
  if (!/\badd\b[^.]{0,60}\bcart\b|\b(?:buy|purchase)\b|加入购物车|添加到购物车|购买/i.test(goal)) return undefined
  if (
    candidates.some(
      (candidate) => candidate.kind === 'click' && /^(?:remove|remove from cart)\b|^(?:移除|删除)/i.test(candidate.name ?? ''),
    )
  ) {
    return undefined
  }
  const controls = candidates.filter(
    (candidate) => candidate.kind === 'click' && /add\s*(?:it\s*)?(?:to\s*(?:the\s*)?cart)|加入购物车|添加到购物车/i.test(candidate.name ?? ''),
  )
  if (controls.length === 0) return undefined
  const stop = new Set(['add', 'the', 'cart', 'to', 'buy', 'item', 'items', 'this'])
  const tokens = goalTokensOf(goal).filter((token) => !stop.has(token))
  const scored = controls
    .map((candidate) => {
      const haystack = `${candidate.name ?? ''} ${candidate.near ?? ''}`.toLowerCase()
      return { candidate, hits: tokens.filter((token) => haystack.includes(token)).length }
    })
    .sort((left, right) => right.hits - left.hits)
  const best = scored[0]
  if (best === undefined || best.hits === 0) return undefined
  const tied = scored.filter((row) => row.hits === best.hits)
  return tied.length === 1 ? best.candidate : undefined
}

/**
 * 动作面注入：goal 点名要按的键 / 悬停 / 拖拽 → 注入候选。
 *
 * 当目标明确要求 hover 或 drag 时，把注入的 `hover:*` / `drag:*` 排在候选最前，
 * 避免被 `JUDGE_OPTION_CAP = 10` 截掉或排在普通 `click` 后面（真机 ti-hover / drag）。
 */
export function withActionCandidates(
  base: readonly TaskCandidate[],
  goal: string,
  step: number,
  trace: string[],
): TaskCandidate[] {
  const candidates = [...base]
  const extra: TaskCandidate[] = []
  for (const key of keysWantedByGoal(goal)) {
    if (key === 'Enter') continue
    extra.push({ id: `control:press_${key}`, description: `按 ${key} 键`, kind: 'control' })
  }
  if (wantsHover(goal)) {
    for (const candidate of candidates.slice(0, 6)) {
      if (candidate.kind === 'click' && candidate.ref !== undefined) {
        extra.push({
          id: `hover:${candidate.id}`,
          description: `把鼠标移到${candidate.description.replace(/^点击/, '')}`,
          kind: 'control',
          ref: candidate.ref,
          name: candidate.name,
        })
      }
    }
  }
  if (wantsDrag(goal)) {
    const draggables = candidates.filter((candidate) => candidate.kind === 'click' && candidate.ref !== undefined).slice(0, 4)
    for (const source of draggables) {
      for (const target of draggables) {
        if (source.id === target.id) continue
        extra.push({
          id: `drag:${source.id}->${target.id}`,
          description: `把「${source.name ?? source.id}」拖到「${target.name ?? target.id}」上`,
          kind: 'control',
          ref: source.ref,
          targetRef: target.ref,
        })
      }
    }
  }
  if (extra.length > 0) {
    trace.push(`第 ${step} 步：目标要求非点击动作 → 注入 ${extra.length} 个候选（${extra.slice(0, 3).map((item) => item.id).join('、')}…）`)
  }
  if (wantsHover(goal) || wantsDrag(goal)) {
    return [...extra, ...candidates]
  }
  return [...candidates, ...extra]
}
