/**
 * `src/task/utils.ts`：纯工具方法（签名哈希、快照 diff、键名/词元解析、文本截断）。
 */

import type { Snapshot } from '../cli.js'
import { DIFF_ITEM_CAP, type LastChange, type TaskCandidate } from './types.js'

/** 小而不依赖 crypto 的稳定哈希（FNV-1a 32 位）：只用来比较"变没变"。 */
export function stableHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 交互结构指纹：origin + 所有 ref 的 role/name（排序后）。 */
export function interactionSignature(snapshot: Snapshot): string {
  const parts = Object.keys(snapshot.refs)
    .sort()
    .map((ref) => `${ref}\u0000${snapshot.refs[ref].role}\u0000${snapshot.refs[ref].name.replace(/\s+/g, ' ').trim()}`)
  return `${snapshot.origin}\u0001${stableHash(parts.join('\u0002'))}`
}

/** 页面"真的变了"吗：交互结构变了，或者文本实质变化（Jaccard 相似度 < 0.93）。 */
export function stateChanged(before: Snapshot, after: Snapshot): boolean {
  if (interactionSignature(before) !== interactionSignature(after)) return true
  if (before.textDigest !== undefined && after.textDigest !== undefined && before.textDigest !== after.textDigest) return true
  const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/\s+/).filter((word) => word !== ''))
  const left = words(before.snapshot)
  const right = words(after.snapshot)
  if (left.size === 0 && right.size === 0) return false
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  const union = left.size + right.size - shared
  return union === 0 ? false : shared / union < 0.93
}

/** 页面语义状态签名：无障碍角色 + 可访问名 + 压缩后文本哈希，忽略 ref 编号这类易变的标记。 */
export function stateSignature(snapshot: Snapshot): string {
  const entries = Object.values(snapshot.refs)
    .map((info) => `${info.role}\u0000${info.name.trim()}`)
    .sort()
  const text = snapshot.snapshot.replace(/\s+/g, ' ').trim()
  return `${snapshot.origin}\u0001${entries.join('\u0002')}\u0003${text.length}\u0004${stableHash(text)}`
}

function diffKey(candidate: TaskCandidate): string {
  if (candidate.kind === 'input') return `input\u0000${candidate.ref ?? candidate.role ?? ''}`
  return `${candidate.role ?? ''}\u0000${(candidate.name ?? '').replace(/\s+/g, ' ').trim()}`
}

function shorten(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

/** 两份候选快照的语义 diff（纯函数，可单测）。 */
export function diffCandidates(
  before: readonly TaskCandidate[],
  after: readonly TaskCandidate[],
  beforeText: string,
  afterText: string,
  beforeOrigin: string,
  afterOrigin: string,
): LastChange | undefined {
  const beforeMap = new Map(before.map((candidate) => [diffKey(candidate), candidate]))
  const afterMap = new Map(after.map((candidate) => [diffKey(candidate), candidate]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const [key, candidate] of afterMap) {
    const previous = beforeMap.get(key)
    if (previous === undefined) {
      added.push(shorten(candidate.description))
      continue
    }
    const stateBefore = previous.state ?? ''
    const stateAfter = candidate.state ?? ''
    if (stateBefore !== stateAfter) {
      changed.push(`${shorten(candidate.name ?? candidate.id)}：${stateBefore === '' ? '（空）' : shorten(stateBefore)} → ${stateAfter === '' ? '（空）' : shorten(stateAfter)}`)
    }
  }
  for (const [key, candidate] of beforeMap) {
    if (!afterMap.has(key)) removed.push(shorten(candidate.description))
  }
  const urlChanged = beforeOrigin !== afterOrigin
  const textChanged = beforeText.replace(/\s+/g, ' ') !== afterText.replace(/\s+/g, ' ')
  if (added.length === 0 && removed.length === 0 && changed.length === 0 && !urlChanged && !textChanged) return undefined
  return {
    ...(urlChanged ? { url_changed: true } : {}),
    ...(textChanged ? { text_changed: true } : {}),
    ...(added.length === 0 ? {} : { added: added.slice(0, DIFF_ITEM_CAP) }),
    ...(removed.length === 0 ? {} : { removed: removed.slice(0, DIFF_ITEM_CAP) }),
    ...(changed.length === 0 ? {} : { changed: changed.slice(0, DIFF_ITEM_CAP) }),
  }
}

/** 字段名归一：小写 + 下划线/连字符/多余空白都当空格。 */
export function fieldName(value: string): string {
  return value.toLowerCase().replace(/[/()_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** goal 里用于相关性的词（ASCII 词 + 中文 2 字 n-gram）。 */
export function goalTokensOf(goal: string): string[] {
  const cjk = (goal.match(/[\u4e00-\u9fa5]{2,}/g) ?? []).flatMap((run) => {
    const grams: string[] = []
    for (let index = 0; index + 1 < run.length; index += 1) grams.push(run.slice(index, index + 2))
    return grams
  })
  return [...new Set([...(goal.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []), ...cjk])]
}

const STOP_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'only', 'then', 'your', 'their',
  'page', 'button', 'link', 'item', 'items', 'field', 'fields', 'form', 'given', 'values', 'value',
  'click', 'open', '点击', '按钮', '链接', '附近',
])

/** 高频跨语言 UI 意图词同义映射（零成本打通中文目标操作英文站 / 英文目标操作中文站）。 */
const UI_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['搜索', '查询', '检索', '查找', 'search', 'query', 'find'],
  ['登录', '登陆', 'login', 'signin', 'sign'],
  ['注册', 'register', 'signup'],
  ['购物车', '加购', 'cart', 'basket', 'bag'],
  ['结账', '结算', '买单', 'checkout', 'pay'],
  ['评论', '讨论', 'comment', 'comments', 'discuss'],
  ['删除', '移除', 'delete', 'remove'],
  ['清空', '清除', '重置', 'clear', 'reset'],
  ['提交', '确认', '保存', 'submit', 'save', 'confirm', 'continue'],
  ['关闭', '取消', '关掉', 'close', 'dismiss', 'cancel'],
  ['设置', '偏好', 'settings', 'setting', 'preferences'],
  ['编辑', '修改', 'edit', 'modify', 'update'],
  ['添加', '新建', '创建', 'add', 'create', 'new'],
  ['下载', 'download'],
  ['上传', 'upload'],
]

/** 轻量英文词干归一（复数/时态还原），不引入外部依赖。 */
export function stemToken(token: string): string[] {
  if (!/^[a-z]+$/.test(token) || token.length < 4) return [token]
  const stems = new Set<string>([token])
  if (token.endsWith('ies') && token.length >= 5) stems.add(`${token.slice(0, -3)}y`)
  if (token.endsWith('es') && token.length >= 5) {
    stems.add(token.slice(0, -2))
    stems.add(token.slice(0, -1))
  } else if (token.endsWith('s') && !token.endsWith('ss')) {
    stems.add(token.slice(0, -1))
  }
  if (token.endsWith('ing') && token.length >= 6) stems.add(token.slice(0, -3))
  if (token.endsWith('ed') && token.length >= 5) {
    stems.add(token.slice(0, -2))
    stems.add(token.slice(0, -1))
  }
  return [...stems]
}

/**
 * 用于候选相关性排序的扩展目标词（过滤虚词 + 英文词干 + 跨语言 UI 同义词）。
 */
export function expandedGoalTokensOf(goal: string): string[] {
  const base = goalTokensOf(goal).filter((token) => !STOP_TOKENS.has(token))
  const out = new Set<string>()
  for (const token of base) {
    for (const stem of stemToken(token)) out.add(stem)
    for (const group of UI_SYNONYM_GROUPS) {
      if (group.includes(token)) {
        for (const syn of group) out.add(syn)
      }
    }
  }
  return [...out]
}

/** ASCII 词按词边界匹配（`text` 不命中 `Textarea`），中文按子串匹配。 */
export function hasTokenBoundary(haystack: string, token: string): boolean {
  const lower = haystack.toLowerCase()
  if (lower === '' || token === '') return false
  if (/[\u4e00-\u9fa5]/.test(token)) return lower.includes(token)
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(lower)
}

/**
 * goal 是否点名了这个字段名：ASCII 词按词边界匹配（`text` 不命中 `Textarea`），
 * 中文按子串；排除 `the`/`and` 等虚词（避免 "walk the dog" 因 "the" 命中任何含 "the" 的目标）。
 */
export function goalMentions(name: string, goal: string): boolean {
  const lower = name.toLowerCase()
  if (lower === '') return false
  return goalTokensOf(goal)
    .filter((token) => !STOP_TOKENS.has(token))
    .some((token) => hasTokenBoundary(lower, token))
}

/** 目标里点名要按的键（press Escape / 按 Enter / 按 Control+a）。 */
export function keysWantedByGoal(goal: string): string[] {
  const wanted: string[] = []
  const pattern = /(?:press|hit|type)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9+]*(?:\s*\+\s*[A-Za-z0-9]+)?)\s*(?:key|键)?/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(goal)) !== null) {
    const raw = match[1]?.trim()
    if (raw === undefined || raw === '') continue
    const key = normalizeKey(raw)
    if (key !== undefined) wanted.push(key)
  }
  const cjk = /(?:按|按下|敲)\s*([A-Za-z][A-Za-z0-9+]*|回车|确认键|退出键|空格)/g
  while ((match = cjk.exec(goal)) !== null) {
    const key = normalizeKey(match[1] ?? '')
    if (key !== undefined) wanted.push(key)
  }
  return [...new Set(wanted)]
}

/** 白名单：只认真实键盘键名。 */
export function normalizeKey(raw: string): string | undefined {
  const compact = raw.trim().replace(/\s+/g, '')
  if (compact === '') return undefined
  const lower = compact.toLowerCase()
  const aliases: Record<string, string> = {
    '回车': 'Enter', '确认键': 'Enter', '退出键': 'Escape', '空格': 'Space', '空隔': 'Space',
    'escape': 'Escape', 'esc': 'Escape', 'enter': 'Enter', 'return': 'Enter', 'tab': 'Tab',
    'space': 'Space', 'spacebar': 'Space', 'backspace': 'Backspace', 'delete': 'Delete',
    'arrowup': 'ArrowUp', 'arrowdown': 'ArrowDown', 'arrowleft': 'ArrowLeft', 'arrowright': 'ArrowRight',
  }
  if (aliases[lower] !== undefined) return aliases[lower]
  if (compact.includes('+')) {
    const parts = compact.split('+')
    const head = parts[0]?.toLowerCase()
    if (head !== 'control' && head !== 'shift') return undefined
    const rest = parts.slice(1).join('+')
    if (rest === '') return undefined
    return `${head === 'control' ? 'Control' : 'Shift'}+${rest}`
  }
  return undefined
}

/** 目标是不是要"悬停/鼠标移上去"。 */
export function wantsHover(goal: string): boolean {
  return /(hover|悬停|鼠标移|移到|mouse over)/i.test(goal)
}

/** 目标是不是要"拖拽"。 */
export function wantsDrag(goal: string): boolean {
  return /(drag|拖拽|拖动|拖到|drag and drop)/i.test(goal)
}

/** 去掉 `--content-boundaries` 加的包裹。 */
export function stripContentBoundaries(text: string): string {
  return text
    .replace(/^\s*---\s*(?:END_)?AGENT_BROWSER_(?:PAGE_)?CONTENT[^-]*---\s*$/gim, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** 长文本截断：保留开头 + 结尾。 */
export function clipHeadTail(text: string, cap: number): string {
  if (text.length <= cap) return text
  const tail = Math.min(500, Math.floor(cap / 4))
  const head = Math.max(0, cap - tail - 40)
  return `${text.slice(0, head)}\n…（中略 ${text.length - head - tail} 字）…\n${text.slice(-tail)}`
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 毫秒级计时（分项账用）。 */
export const now = (): number => Number(process.hrtime.bigint() / 1000n) / 1000

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
