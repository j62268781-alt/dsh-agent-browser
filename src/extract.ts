/**
 * **页面内抽取**（P8）：用一次 `eval` 在页面里把"能操作的候选"抽成紧凑结构，
 * 而不是把整棵无障碍树（+ 几百个 refs）发给判断层。
 *
 * 实测（hao123，354 个 refs 的门户页）：
 *   - CLI `snapshot -i --json`：13,985 字符文本 + 354 refs（状态约 4.3k tokens）
 *   - 本抽取：80 个可见元素 → 1,021 字符 ≈ **1.1–1.9k tokens**，耗时 7.8ms
 *
 * 为什么不能用 `@eN`：refs 只存在 Rust daemon 里，页面里没有任何映射
 * （实测 `window` 无句柄、DOM 无 `data-*ref` 属性）。所以脚本给元素打**自己的**属性
 * `data-dsh-idx="i"`，动作时用 `[data-dsh-idx="7"]`——已实测可点击并跳转。
 *
 * 抽取时就把"不可信"的候选过滤掉（判断层看到的东西才可信）：
 *   不可见（display/visibility/opacity）、离屏、被遮挡（`elementFromPoint`）、无名（输入框除外）。
 */

/** 候选属性名（命名空间化，避免与站点冲突；每次抽取前清理）。 */
export const HANDLE_ATTRIBUTE = 'data-dsh-idx'

/**
 * 在页面里跑的抽取脚本：一次 `eval` 同时拿候选 + 正文 + 标题 + URL。
 *
 * 三条硬约束（都是真机踩出来的）：
 * 1. **不能放进 `batch`**：batch 会把命令按空白切分，而 JS 里 `const x`、`for (const …)`
 *    关键字之间必须有空白，脚本会被切碎。所以单走一次 `eval`。
 * 2. **脚本里不能出现反引号**：它本身就是模板拼接的产物。
 * 3. **不能写正则的空白转义**：模板/字符串层会把 `\s` 当未知转义吃掉成 `s`，
 *    结果把所有 s 换成空格（fixture 上 "Find stays" 变成 "Find  tay"）。这里用 split/join。
 */
const SCRIPT_LINES = [
  '(() => {',
  "  document.querySelectorAll('[data-dsh-idx]').forEach((el) => el.removeAttribute('data-dsh-idx'))",
  '  const out = []',
  '  let idx = 0',
  '  const selector = \'a,button,input,select,textarea,summary,label[for],[contenteditable=""],[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="tab"],[aria-checked],[aria-selected],[onclick],[tabindex]\'',
  '  const nodes = Array.from(new Set(document.querySelectorAll(selector)))',
  '  for (const el of nodes) {',
  '    const rect = el.getBoundingClientRect()',
  '    if (rect.width < 2 || rect.height < 2) continue',
  '    const style = getComputedStyle(el)',
  "    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue",
  "    let labelText = ''",
  "    if (el.labels && el.labels.length > 0) labelText = String(el.labels[0].innerText || '')",
  "    if (!labelText && el.id) { const byFor = document.querySelector('label[for=\"' + el.id + '\"]'); if (byFor) labelText = String(byFor.innerText || '') }",
  "    if (!labelText) { const wrap = el.closest ? el.closest('label') : null; if (wrap) labelText = String(wrap.innerText || '') }",
  "    const raw = el.getAttribute('aria-label') || el.getAttribute('title') || labelText || el.innerText || el.value || el.placeholder || ''",
  '    let name = String(raw)',
  "    name = name.split(String.fromCharCode(10)).join(' ')",
  "    name = name.split(String.fromCharCode(9)).join(' ')",
  "    name = name.split(String.fromCharCode(13)).join(' ')",
  "    name = name.split(String.fromCharCode(160)).join(' ')",
  "    while (name.indexOf('  ') >= 0) name = name.split('  ').join(' ')",
  '    name = name.trim().slice(0, 60)',
  "    const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)",
  "    if (name === '' && !isField) continue",
  '    const cx = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2))',
  '    const cy = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2))',
  '    const top = document.elementFromPoint(cx, cy)',
  // **离屏 ≠ 被遮挡**：中心点在视口外时 elementFromPoint 只能拿到边缘元素，
  // 会把首屏之外的链接全标成 covered（bench fixture-dense：251 个元素被滤到只剩 37 个候选）。
  // 离屏元素要保留（CLI 点击会自动滚进视图），只有**视口内**才做遮挡判定。
  '    const inView = rect.top + rect.height / 2 >= 0 && rect.top + rect.height / 2 <= innerHeight && rect.left + rect.width / 2 >= 0 && rect.left + rect.width / 2 <= innerWidth',
  '    const covered = inView && top && top !== el && !el.contains(top) && !top.contains(el) ? 1 : 0',
  "    el.setAttribute('data-dsh-idx', String(idx))",
  "    const tag = el.tagName.toLowerCase()",
  "    const type = String(el.getAttribute('type') || '').toLowerCase()",
  "    let role = el.getAttribute('role') || tag",
  "    if (tag === 'input') role = type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'search' ? 'searchbox' : type === 'submit' || type === 'button' ? 'button' : 'textbox'",
  "    else if (tag === 'select') role = 'combobox'",
  "    else if (tag === 'textarea') role = 'textbox'",
  "    let extra = ''",
  "    if (role === 'checkbox' || role === 'radio' || role === 'switch' || el.hasAttribute('aria-checked')) {",
  "      const on = el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : Boolean(el.checked)",
  "      extra = on ? '已勾选' : '未勾选'",
  "    } else if (tag === 'select') {",
  "      extra = '当前值: ' + String(el.value || '')",
  "    } else if (tag === 'input' || tag === 'textarea') {",
  "      const v = String(el.value || '')",
  // 密码框的值**不能出页面**：它会变成判断层输入（jk-login fixture 暴露：密码原文进了 state）。
  // 只汇报"已填写/未填写"，值本身永远是 ●●●。
  "      if (v) extra = type === 'password' ? '已有内容: ●●●' : '已有内容: ' + v.slice(0, 30)",
  "    } else if (tag === 'a' && el.href) {",
  "      try { const u = new URL(el.href); extra = '链接: ' + u.host + u.pathname.slice(0, 40) } catch (e) { extra = '' }",
  "    }",
  "    let options = null",
  "    if (tag === 'select') { try { options = [...el.options].filter(function (o) { return o.value !== '' && !o.disabled }).slice(0, 30).map(function (o) { return [String(o.text || o.value).trim().slice(0, 60), String(o.value).slice(0, 60)] }) } catch (err) { options = null } }",
  // 元素**所在行/容器的文本**：判断层靠它区分"导航条的 comments"和"这条 story 的 42 comments"。
  "    let near = ''",
  "    try { var parentText = el.parentElement ? String(el.parentElement.innerText || '') : ''; near = parentText.split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(9)).join(' ').trim().slice(0, 80) } catch (err) { near = '' }",
  "    out.push([idx, role, name, covered, extra, options, near])",
  '    idx += 1',
  '    if (out.length >= 300) break',
  '  }',
  "  const body = document.body ? document.body.innerText : ''",
  '  return JSON.stringify({',
  '    items: out,',
  "    text: String(body || '').slice(0, 4000),",
  "    title: document.title || '',",
  '    url: location.href,',
  '    truncated: out.length >= 300,',
  '  })',
  '})()',
]

export const EXTRACT_SCRIPT = SCRIPT_LINES.join('\n')

/** `parseExtracted` 的返回（与 `cli.ts` 的 `ExtractedPage` 同形）。 */
export interface ExtractedPage {
  readonly items: readonly ExtractedItem[]
  readonly text: string
  readonly title: string
  readonly url: string
  /** 元素数达到抽取上限（300）：页面比这更大，目标可能没被抽到。 */
  readonly truncated?: boolean
}

/** 抽取到的单个候选。 */
export interface ExtractedItem {
  readonly index: number
  readonly role: string
  readonly name: string
  /** 被其它元素挡住（点击会落到遮挡物上）；默认不进候选池。 */
  readonly covered: boolean
  /** 当前状态摘要：已勾选/未勾选、当前值、已有内容、链接目标（给判断层的"现状"）。 */
  readonly state?: string
  /** 原生 select 的选项（label, value），最多 30 个。 */
  readonly options?: readonly (readonly [string, string])[]
  /** 元素所在行/容器的文本（区分"导航条同名链接"和"当前条目里的链接"）。 */
  readonly near?: string
  /** 原始标签名（小写）：`a`/`button` 可以直接调用 `el.click()`，其余走真实鼠标事件。 */
  readonly tag?: string
}

/**
 * 去掉 `--content-boundaries` 的包裹（`--- AGENT_BROWSER_PAGE_CONTENT nonce=… ---` / `--- END_… ---`）。
 *
 * `eval` 的输出也会被这个全局参数包住——不剥掉就 JSON.parse 失败（真机踩到）。
 */
export function stripBoundaries(text: string): string {
  // 行内到最后一个 `---` 为止用 `[^\n]*`，**不能用 `[^-]*`**：
  // 边界行里带 `origin=file:///…/dsh-agent-browser/…` 时 URL 含连字符，
  // `[^-]*` 会在 "dsh-" 处停住，整行去不掉（真机：本地 fixture 的断言因此解析失败）。
  return text
    .replace(/^\s*---\s*(?:END_)?AGENT_BROWSER_(?:PAGE_)?CONTENT[^\n]*---\s*$/gim, '')
    .trim()
}

/** 解析抽取脚本的返回值（`eval` 返回字符串 → 再解一层；兼容直接返回数组的旧形状）。 */
export function parseExtracted(raw: string): ExtractedPage {
  let value: unknown
  try {
    value = JSON.parse(stripBoundaries(raw))
  } catch {
    throw new Error(`抽取脚本的返回值不是 JSON：${stripBoundaries(raw).slice(0, 200)}`)
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return { items: [], text: '', title: '', url: '' }
    }
  }
  if (Array.isArray(value)) return { items: parseItems(value), text: '', title: '', url: '' }
  const record = (value ?? {}) as { items?: unknown; text?: unknown; title?: unknown; url?: unknown; truncated?: unknown }
  return {
    items: Array.isArray(record.items) ? parseItems(record.items) : [],
    text: String(record.text ?? ''),
    title: String(record.title ?? ''),
    url: String(record.url ?? ''),
    truncated: record.truncated === true,
  }
}

function parseItems(value: readonly unknown[]): ExtractedItem[] {
  const items: ExtractedItem[] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 3) continue
    const [index, role, name, covered, extra, options, near, tag] = entry as [unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown?]
    items.push({
      index: Number(index),
      role: String(role ?? ''),
      name: String(name ?? ''),
      covered: Number(covered) === 1,
      state: String(extra ?? ''),
      ...(Array.isArray(options) ? { options: options.map((option) => [String((option as unknown[])[0] ?? ''), String((option as unknown[])[1] ?? '')] as const) } : {}),
      ...(typeof near === 'string' && near !== '' ? { near } : {}),
      ...(typeof tag === 'string' && tag !== '' ? { tag } : {}),
    })
  }
  return items
}

/** 动作句柄（CSS 选择器）。 */
export function handleOf(index: number): string {
  return `[${HANDLE_ATTRIBUTE}="${index}"]`
}
