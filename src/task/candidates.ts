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

/** 候选预算：按 goal 相关性排序后取前 N（点击优先；目标像"要打字/选下拉"时输入优先）。 */
export function headCandidates(
  clicks: readonly TaskCandidate[],
  inputs: readonly TaskCandidate[],
  goal: string,
): TaskCandidate[] {
  const rank = <T extends TaskCandidate>(list: readonly T[]): T[] => rankByGoal(list, goal)
  // 包含 choose/select/pick/dropdown：避免稠密页（如 react-select 67 个点击项）把排在后面的 combobox 全部截断；
  // 但若目标明确点名 radio/checkbox（它们属于 clicks 而非 inputs），仍保持 clicks 优先。
  const explicitToggleOnly =
    /\b(radio|checkbox|switch)\b|单选|复选|勾选/i.test(goal) &&
    !/\b(textbox|textarea|dropdown|combobox|searchbox|password|date)\b|输入框|下拉/i.test(goal)
  const wantsInputFirst =
    !explicitToggleOnly &&
    /输入|填写|填|搜索|查询|检索|选择|下拉|type|fill|search|enter|query|choose|select|pick|dropdown|combobox/i.test(goal)
  return (
    wantsInputFirst
      ? [...rank(inputs).slice(0, 20), ...rank(clicks).slice(0, MAX_CLICK_CANDIDATES)]
      : [...rank(clicks).slice(0, MAX_CLICK_CANDIDATES), ...rank(inputs).slice(0, 20)]
  ).slice(0, MAX_CLICK_CANDIDATES)
}

const WIDGET_ORDINAL_ROLES = new Set(['radio', 'checkbox', 'combobox', 'switch'])

/** 页面内抽取（`extract()`）→ 候选：句柄 + 角色 + 名字 + 同簇/同控件序号，遮挡的默认不进池。 */
export function candidatesFromExtracted(items: readonly ExtractedItem[], goal = ''): TaskCandidate[] {
  const clicks: TaskCandidate[] = []
  const inputs: TaskCandidate[] = []

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

    const state = item.state === undefined || item.state === '' ? '' : `，${item.state}`
    const near = item.near === undefined || item.near === item.name ? '' : `，附近: ${item.near.slice(0, 60)}`
    const label =
      item.name === ''
        ? `（无名称的 ${role}${ordinalTag}${state}${near}）`
        : `「${item.name}」（${role}${ordinalTag}${state}${near}）`
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
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'input' || role === 'textarea' || role === 'select') {
      inputs.push({ ...candidate, id: `input:${item.index}`, description: `在${label}里输入/选择`, kind: 'input' })
    } else {
      clicks.push(candidate)
    }
  }
  return headCandidates(clicks, inputs, goal)
}

/**
 * 按 goal 相关性分层排序（确定性，不做判断）：
 * 1. 分层词面匹配：控件名精确/词边界 > 所在行 `near` 上下文 > 状态/URL；
 * 2. 序号意图匹配：goal 含 first/second/third 时对应 `#1`/`#2`/`#3` 加分；
 * 3. 主内容区优先（`inMain`）与禁用态降权（`已禁用`）；
 * 4. 同名重复项多样性封顶（Diversity Cap）：未命中目标的同名同角色控件最多保留前 2 个在第一梯队，
 *    第 3 个起降入后备梯队，防止列表页 20 个同名按钮挤占 `JUDGE_OPTION_CAP = 10` 的全部名额。
 */
export function rankByGoal<T extends TaskCandidate>(list: readonly T[], goal: string): T[] {
  const tokens = expandedGoalTokensOf(goal)
  const hasRegionSignal = list.some((candidate) => candidate.inMain !== undefined)
  if (tokens.length === 0 && !hasRegionSignal) return [...list]

  const wantsDropdown = /\b(dropdown|combobox)\b|下拉/i.test(goal)
  const wantsRemoval = /\b(remove|delete|clear)\b|移除|删除|清空/i.test(goal)
  const wantsAll = /\ball\b|全部|所有/i.test(goal)
  const wantsDisabled = /\bdisabled\b|禁用/i.test(goal)
  const wantsFirst = /\b(first|1st|top)\b|第一|首个|置顶/i.test(goal)
  const wantsSecond = /\b(second|2nd)\b|第二/i.test(goal)
  const wantsThird = /\b(third|3rd)\b|第三/i.test(goal)

  const baseScore = (candidate: TaskCandidate): number => {
    const name = (candidate.name ?? '').toLowerCase().trim()
    const near = (candidate.near ?? '').toLowerCase()
    const state = (candidate.state ?? '').toLowerCase()
    const role = (candidate.role ?? '').toLowerCase()
    const desc = candidate.description.toLowerCase()

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
      } else if (state.includes(token) || role.includes(token)) {
        total += 1
      }
      // 通用动作按钮（如 Add to cart / Edit / comments）名字本身外，所在行 near 命中具体条目词额外协同加分
      if (name !== '' && !name.includes(token) && near !== '') {
        if (hasTokenBoundary(near, token)) total += 2
        else if (near.includes(token)) total += 1
      }
    }

    if (wantsFirst && desc.includes(' #1')) total += 2
    if (wantsSecond && desc.includes(' #2')) total += 2
    if (wantsThird && desc.includes(' #3')) total += 2

    // 目标明确找 dropdown/combobox 时，它们的语义角色名是 combobox/option（字面不含 "dropdown"），
    // 给对应角色加分才能排进 JUDGE_OPTION_CAP 前 10；已展开的 option 优先于再点一次 combobox。
    if (wantsDropdown) {
      if (role === 'option') total += 3
      else if (role === 'combobox') total += 2
    }
    // 目标不是删除/移除时，「Remove Purple」这类多选标签删除按钮不该因为含目标词而排在真正下拉框前面。
    if (!wantsRemoval && /^(?:remove|delete)\b/i.test(name)) {
      total -= 4
    }
    if (!wantsAll && /\ball\b/i.test(name)) {
      total -= 2
    }
    if (!wantsDisabled && state.includes('已禁用')) {
      total -= 3
    }
    if ((role === 'checkbox' || role === 'radio' || role === 'switch') && total > 0) {
      total += 1
    }
    if (candidate.inMain === true) {
      total += 0.5
    } else if (candidate.inMain === false && total === 0) {
      total -= 0.5
    }
    return total
  }

  const unmatchedClusters = new Map<string, number>()
  return list
    .map((candidate, index) => {
      let score = baseScore(candidate)
      const nameKey = (candidate.name ?? '').trim().toLowerCase()
      if (nameKey !== '' && score <= 0.5) {
        const clusterKey = `${(candidate.role ?? '').toLowerCase()}\u0000${nameKey}`
        const count = (unmatchedClusters.get(clusterKey) ?? 0) + 1
        unmatchedClusters.set(clusterKey, count)
        if (count > 2) score -= 5
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
  if (!/\badd\b[^.]{0,60}\bcart\b|加入购物车|添加到购物车/i.test(goal)) return undefined
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
