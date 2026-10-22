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
  '  const parentTextCache = new WeakMap()',
  '  const selector = \'a,button,input,select,textarea,summary,label[for],[contenteditable=""],[contenteditable="true"],[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="listbox"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="tab"],[aria-checked],[aria-selected],[onclick],[tabindex]\'',
  '  let nodes = Array.from(new Set(document.querySelectorAll(selector)))',
  // **可排序表头**：jQuery tablesorter 这类插件把点击事件**委托**在 <th> 上
  // （没有 onclick 属性、没有 role/tabindex），只按标签/属性抓会整列漏掉。
  // 真机 ti-sort-table：18 个候选全是 edit/delete 链接，判断层根本看不到"排序"这个动作
  // → ambiguous / budget；而表头点一下确实能把 Last Name 排出来（Bach 到首位）。
  // 只收"看起来可排序"的表头（class 带 sort/header、role=columnheader、cursor:pointer），
  // 否则稠密表格页会凭空多出几十个噪声候选。
  '  const headers = Array.from(document.querySelectorAll(\'th,[role="columnheader"]\'))',
  '  for (const header of headers) {',
  '    if (nodes.indexOf(header) >= 0) continue',
  '    let sortable = false',
  "    try { sortable = /sort|header/i.test(String(header.className || '')) } catch (err) { sortable = false }",
  "    if (!sortable && header.getAttribute('role') === 'columnheader') sortable = true",
  "    if (!sortable) { try { sortable = getComputedStyle(header).cursor === 'pointer' } catch (err) { sortable = false } }",
  '    if (sortable) nodes.push(header)',
  '  }',
  // **可见弹层里的"光标即落点"控件**：现代页面把关闭/确认挂在 div/p/span 上，
  // 既没有 role 也没有 onclick/tabindex（真机 ti-entry-ad：关闭键就是 `<p>Close</p>`
  // + CSS `cursor: pointer`，抽取只看到弹层背后那条被遮挡的链接 → 判断层无候选可选）。
  // 只在**弹层内部**收这类元素（不做全页扫描）：全页扫 cursor:pointer 会让稠密页凭空多出
  // 几十个噪声候选；弹层里的可点叶子本来就是"当前唯一该操作的东西"。
  '  const layers = Array.from(document.querySelectorAll(\'[role="dialog"],dialog,[aria-modal="true"],[id*="modal"],[class*="modal"],[class*="Modal"]\'))',
  '  const pointerLeaves = []',
  '  for (const layer of layers) {',
  '    if (pointerLeaves.length >= 20) break',
  "    let layerStyle = null",
  "    try { layerStyle = getComputedStyle(layer) } catch (err) { layerStyle = null }",
  "    if (layerStyle !== null && (layerStyle.display === 'none' || layerStyle.visibility === 'hidden')) continue",
  '    const rect = layer.getBoundingClientRect()',
  '    if (rect.width < 40 || rect.height < 20) continue',
  "    const inside = Array.from(layer.querySelectorAll('a,button,p,div,span,li'))",
  '    for (const el of inside) {',
  '      if (pointerLeaves.length >= 20) break',
  '      if (nodes.indexOf(el) >= 0 || pointerLeaves.indexOf(el) >= 0) continue',
  '      let cursorPointer = false',
  "      try { cursorPointer = getComputedStyle(el).cursor === 'pointer' } catch (err) { cursorPointer = false }",
  '      if (!cursorPointer) continue',
  "      if (el.querySelector('a,button,input,select,textarea,[role],[onclick],[tabindex]') !== null) continue",
  "      const text = String(el.innerText || '').trim()",
  '      if (text === \'\' || text.length > 40) continue',
  '      pointerLeaves.push(el)',
  '    }',
  '  }',
  '  for (const leaf of pointerLeaves) nodes.push(leaf)',
  // **超上限时先保主内容区**：抽取只保留前 300 个元素，而门户/后台页面的页头导航动辄几十上百个链接。
  // 按 DOM 顺序截断会让导航把主内容区的目标控件挤出候选（目标"看不见"，判断层只能盲选）。
  // 只在**确实超上限**时把导航/页脚/页头元素排到后面，普通页面顺序完全不变。
  '  if (nodes.length > 300) {',
  '    const parentCounts = new Map()',
  '    for (const node of nodes) {',
  '      const p = node.parentElement',
  '      if (p) parentCounts.set(p, (parentCounts.get(p) || 0) + 1)',
  '    }',
  '    const highValue = []',
  '    const primary = []',
  '    const bulk = []',
  '    const secondary = []',
  '    for (const node of nodes) {',
  '      let isNav = false',
  "      try { isNav = Boolean(node.closest && node.closest('nav,header,footer,[role=\"navigation\"],[role=\"banner\"],[role=\"contentinfo\"]')) } catch (err) { isNav = false }",
  '      if (isNav) { secondary.push(node); continue }',
  "      const nType = String(node.getAttribute && node.getAttribute('type') || '').toLowerCase()",
  "      const nAc = String(node.getAttribute && node.getAttribute('autocomplete') || '').toLowerCase()",
  '      const pCount = node.parentElement ? (parentCounts.get(node.parentElement) || 0) : 0',
  "      if (nType === 'password' || nType === 'search' || nType === 'email' || (nAc !== '' && nAc !== 'off' && nAc !== 'on') || (pCount >= 2 && pCount <= 5)) {",
  '        highValue.push(node)',
  '      } else if (pCount > 15) {',
  '        bulk.push(node)',
  '      } else {',
  '        primary.push(node)',
  '      }',
  '    }',
  '    nodes = highValue.concat(primary, bulk, secondary)',
  '  }',
  '  const keptEls = []',
  '  const formIds = new Map()',
  '  let nextFormId = 1',
  '  for (const el of nodes) {',
  '    const rect = el.getBoundingClientRect()',
  '    if (rect.width < 2 || rect.height < 2) continue',
  '    const style = getComputedStyle(el)',
  "    const tag = el.tagName.toLowerCase()",
  "    const type = String(el.getAttribute('type') || '').toLowerCase()",
  "    const acRaw = String(el.getAttribute('autocomplete') || '').toLowerCase().trim()",
  "    const autocomplete = acRaw !== '' && acRaw !== 'off' && acRaw !== 'on' ? acRaw.slice(0, 60) : ''",
  "    const autocompleteField = autocomplete.split(' ').pop() || ''",
  "    const sensitiveField = type === 'password' || autocompleteField === 'one-time-code' || autocompleteField.indexOf('cc-') === 0",
  // 自定义样式的 checkbox/radio（如 TodoMVC 的 40×40 `input.toggle`）常设 opacity:0 盖在图标上接收点击，
  // 只要尺寸 ≥10×10 就保留，不能当成不可见丢掉。
  "    const overlayToggle = (type === 'checkbox' || type === 'radio') && rect.width >= 10 && rect.height >= 10",
  "    if (style.visibility === 'hidden' || style.display === 'none' || (style.opacity === '0' && !overlayToggle)) continue",
  "    let labelText = ''",
  "    if (el.labels && el.labels.length > 0) labelText = String(el.labels[0].innerText || '')",
  "    if (!labelText && el.id) { const byFor = document.querySelector('label[for=\"' + el.id + '\"]'); if (byFor) labelText = String(byFor.innerText || '') }",
  "    if (!labelText) { const wrap = el.closest ? el.closest('label') : null; if (wrap) labelText = String(wrap.innerText || '') }",
  "    if (!labelText && (type === 'checkbox' || type === 'radio') && el.nextElementSibling && ['LABEL', 'SPAN'].includes(el.nextElementSibling.tagName)) {",
  "      labelText = String(el.nextElementSibling.innerText || el.nextElementSibling.textContent || '')",
  '    }',
  // 浏览器 DOM 标准里不带 value 属性的 checkbox/radio 默认 el.value === 'on'，
  // 直接拿它当名字会让页面上所有无 label 勾选框都叫「on」（真机 ti-checkboxes / todomvc）。
  // 同级/关联 labelText 优先于泛化的 aria-label（如 TodoMVC 所有框都叫 aria-label="Toggle Todo"，而同级 label 才是 "buy milk"）。
  "    const valName = sensitiveField ? '' : (type === 'checkbox' || type === 'radio') && el.value === 'on' ? '' : el.value",
  "    const raw = labelText || el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.getAttribute('alt') || valName || el.placeholder || ''",
  '    let name = String(raw)',
  "    name = name.split(String.fromCharCode(10)).join(' ')",
  "    name = name.split(String.fromCharCode(9)).join(' ')",
  "    name = name.split(String.fromCharCode(13)).join(' ')",
  "    name = name.split(String.fromCharCode(160)).join(' ')",
  "    while (name.indexOf('  ') >= 0) name = name.split('  ').join(' ')",
  '    name = name.trim().slice(0, 60)',
  "    const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)",
  // **无名勾选框的紧邻文本兜底**：ti-checkboxes 是 `<input type=checkbox> checkbox 1<br>`（相邻文本节点），
  // TodoMVC 是 `<input class=toggle type=checkbox><label>buy milk</label>`（同级 label）。
  "    if (name === '' && (type === 'checkbox' || type === 'radio')) {",
  '      let sib = el.nextSibling',
  "      while (sib && sib.nodeType === 3 && String(sib.textContent || '').trim() === '') sib = sib.nextSibling",
  '      if (sib && sib.nodeType === 3) {',
  "        name = String(sib.textContent || '').split(String.fromCharCode(10))[0].trim().slice(0, 40)",
  "      } else if (el.nextElementSibling && ['LABEL', 'SPAN'].includes(el.nextElementSibling.tagName)) {",
  "        name = String(el.nextElementSibling.innerText || el.nextElementSibling.textContent || '').split(String.fromCharCode(10)).join(' ').trim().slice(0, 40)",
  '      }',
  '    }',
  // **无名字段的上下文兜底**：自定义控件（react-select、combobox）的输入框没有 label，
  // name 会是空串，判断层只能看到"10 个匿名 combobox"（真机 react-select → ambiguous）。
  // 取最近两层的短文本当名字（有界 ≤40 字符，且要求容器别太大），只对字段生效。
  '    if (name === \'\' && isField) {',
  '      let node = el.parentElement',
  '      for (let depth = 0; depth < 2 && node; depth += 1) {',
  "        let ctx = ''",
  "        try { ctx = String(node.innerText || '') } catch (err) { ctx = '' }",
  "        ctx = ctx.split(String.fromCharCode(10)).join(' ').trim()",
  '        if (ctx !== \'\' && ctx.length <= 40) { name = ctx; break }',
  '        node = node.parentElement',
  '      }',
  '    }',
  "    if (!isField && (name === '' || /^\\d+$/.test(name))) {",
  "      const rawHint = String(el.getAttribute('data-test') || el.getAttribute('data-testid') || el.id || '')",
  "      const hint = rawHint.replace(/[-_]+/g, ' ').trim()",
  "      if (hint !== '' && /[a-zA-Z]/.test(hint)) {",
  "        name = (name === '' ? hint : hint + ' (' + name + ')').slice(0, 60)",
  '      }',
  '    }',
  "    if (name === '' && !isField) continue",
  // 孪生 DOM 壳去重：外层 div/span/li（因 onclick/tabindex/role 被抓到）若直接包裹了同名 a/button/input/select，
  // 只保留内层真实控件，避免内外两层生成两个同名候选平分 Jev 概率。
  "    if (!isField && !['a', 'button', 'summary', 'th'].includes(tag)) {",
  "      const inner = el.querySelector ? el.querySelector('a,button,input,select,textarea') : null",
  '      if (inner && nodes.indexOf(inner) >= 0) {',
  "        const innerName = String(inner.innerText || inner.value || inner.getAttribute('aria-label') || '').split(String.fromCharCode(10)).join(' ').trim().slice(0, 60)",
  "        if (innerName !== '' && innerName === name) continue",
  '      }',
  '    }',
  '    const cx = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2))',
  '    const cy = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2))',
  '    const top = document.elementFromPoint(cx, cy)',
  // **离屏 ≠ 被遮挡**：中心点在视口外时 elementFromPoint 只能拿到边缘元素，
  // 会把首屏之外的链接全标成 covered（bench fixture-dense：251 个元素被滤到只剩 37 个候选）。
  // 离屏元素要保留（CLI 点击会自动滚进视图），只有**视口内**才做遮挡判定。
  '    const inView = rect.top + rect.height / 2 >= 0 && rect.top + rect.height / 2 <= innerHeight && rect.left + rect.width / 2 >= 0 && rect.left + rect.width / 2 <= innerWidth',
  '    const covered = inView && top && top !== el && !el.contains(top) && !top.contains(el) ? 1 : 0',
  "    el.setAttribute('data-dsh-idx', String(idx))",
  // **显式 role 优先**：`<input role="combobox">`（react-select 等）被下面的 input 推断
  // 无条件覆盖成 textbox → 页面上一个 combobox 都没有 → 相关性门判定"缺角色 combobox"
  // 退回整树 → 45 个候选里判断层点了「Remove Purple」干扰项（真机 react-select，trace 直证）。
  "    const explicitRole = String(el.getAttribute('role') || '').toLowerCase()",
  // 表头给判断层一个明确角色（`th` 当角色名没有意义：它说明不了"这列能排序"）。
  "    let role = explicitRole !== '' ? explicitRole : tag === 'th' ? 'columnheader' : tag",
  "    if (explicitRole === '') {",
  "      if (tag === 'input') role = type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'search' ? 'searchbox' : type === 'submit' || type === 'button' ? 'button' : 'textbox'",
  "      else if (tag === 'select') role = 'combobox'",
  "      else if (tag === 'textarea') role = 'textbox'",
  "    }",
  "    let extra = ''",
  "    if (role === 'checkbox' || role === 'radio' || role === 'switch' || el.hasAttribute('aria-checked')) {",
  "      const on = el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : Boolean(el.checked)",
  "      extra = on ? '已勾选' : '未勾选'",
  "    } else if (tag === 'select') {",
  "      extra = '当前值: ' + String(el.value || '')",
  "    } else if (tag === 'input' || tag === 'textarea') {",
  "      const v = String(el.value || '')",
   // 标准 password、one-time-code 和 cc-* 字段仅报告是否填写，绝不输出输入原值。
   "      if (v) extra = sensitiveField ? '已有内容: ●●●' : '已有内容: ' + v.slice(0, 30)",
  "    } else if (tag === 'a' && el.href) {",
  "      try { const u = new URL(el.href); extra = '链接: ' + u.host + u.pathname.slice(0, 40) } catch (e) { extra = '' }",
  "    }",
  '    const ariaFlags = []',
  "    if (Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true') ariaFlags.push('已禁用')",
  "    if (el.getAttribute('aria-selected') === 'true') ariaFlags.push('已选中')",
  "    if (el.getAttribute('aria-pressed') === 'true') ariaFlags.push('已按下')",
  "    if (el.hasAttribute('aria-expanded')) ariaFlags.push(el.getAttribute('aria-expanded') === 'true' ? '已展开' : '已收起')",
  "    else if (tag === 'summary' && el.parentElement && el.parentElement.tagName === 'DETAILS') {",
  "      ariaFlags.push(el.parentElement.hasAttribute('open') ? '已展开' : '已收起')",
  '    }',
  '    if (ariaFlags.length > 0) {',
  "      if (extra === '') extra = ariaFlags.join('、')",
  "      else if (extra.indexOf('链接: ') === 0) extra = ariaFlags.join('、') + '，' + extra",
  '    }',
  "    let options = null",
  "    if (tag === 'select') { try { options = [...el.options].filter(function (o) { return o.value !== '' && !o.disabled }).slice(0, 30).map(function (o) { return [String(o.text || o.value).trim().slice(0, 60), String(o.value).slice(0, 60)] }) } catch (err) { options = null } }",
  // 元素**所在行/容器的文本**：判断层靠它区分"导航条的 comments"和"这条 story 的 42 comments"。
  // 但如果父节点包了整张列表/表格（TodoMVC 的 <main> 同时包住 Mark all as complete 与 <ul.todo-list>），
  // 不能把整张列表拼进 near，否则「Mark all as complete」会带上「附近: ... buy milk」抢走单条勾选目标。
  "    let near = ''",
  '    try {',
  '      var p = el.parentElement',
  "      var wrapsList = p && p.querySelector && p.querySelector('ul,ol,table') && (!el.closest || !el.closest('li,tr,td,th'))",
  "      if (p && !wrapsList) {",
  '        var parentText = parentTextCache.get(p)',
  '        if (parentText === undefined) {',
  "          parentText = String(p.innerText || '').split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(9)).join(' ').trim().slice(0, 80)",
  '          parentTextCache.set(p, parentText)',
  '        }',
  '        near = parentText',
  '      }',
  "    } catch (err) { near = '' }",
  '    let inMain = 0',
  '    try {',
  "      const inNav = Boolean(el.closest && el.closest('nav,header,footer,[role=\"navigation\"],[role=\"banner\"],[role=\"contentinfo\"]'))",
  "      const inPrimary = Boolean(el.closest && el.closest('main,article,form,table,dialog,[role=\"main\"],[role=\"dialog\"],[role=\"region\"],[aria-modal=\"true\"]'))",
  '      inMain = inPrimary && !inNav ? 1 : inNav ? -1 : 0',
  '    } catch (err) { inMain = 0 }',
  "    let inputType = ''",
  "    if (tag === 'input') {",
  "      inputType = type || 'text'",
  "    } else if (tag === 'button') {",
  "      const btnType = type || 'submit'",
  "      if (btnType === 'submit' && Boolean(el.form || (el.closest && el.closest('form')))) inputType = 'submit'",
  '    }',
  '    const ownerForm = el.form || (el.closest ? el.closest(\'form\') : null)',
  "    let formId = ''",
  '    if (ownerForm) {',
  "      const explicitFormId = String(ownerForm.id || '').trim()",
  "      if (explicitFormId !== '') { formId = 'id:' + explicitFormId }",
  '      else {',
  '        formId = formIds.get(ownerForm) || \'\'',
  "        if (formId === '') { formId = 'f' + String(nextFormId); nextFormId += 1; formIds.set(ownerForm, formId) }",
  '      }',
  '    }',
  '    keptEls.push(el)',
  "    out.push([idx, role, name, covered, extra, options, near, null, inMain, inputType, autocomplete, '', '', formId])",
  '    idx += 1',
  '    if (out.length >= 300) break',
  '  }',
  '  const ancCounts = new Map()',
  "  const groupableEls = keptEls.filter((el) => el.tagName !== 'LABEL')",
  '  for (let i = 0; i < groupableEls.length; i += 1) {',
  '    let cur = groupableEls[i].parentElement',
  '    for (let d = 0; d < 6 && cur; d += 1) {',
  "      const cTag = cur.tagName ? cur.tagName.toLowerCase() : ''",
  "      if (cTag === 'body' || cTag === 'html' || cTag === 'main') break",
  '      ancCounts.set(cur, (ancCounts.get(cur) || 0) + 1)',
  '      cur = cur.parentElement',
  '    }',
  '  }',
  '  const groupMap = new Map()',
  '  const groupLabels = new Map()',
  '  const groupTags = new Set([\'form\', \'fieldset\', \'div\', \'tr\', \'li\'])',
  '  let nextGroup = 1',
  '  for (let i = 0; i < keptEls.length; i += 1) {',
  '    let cur = keptEls[i].parentElement',
  '    let chosenGroup = null',
  '    for (let d = 0; d < 6 && cur; d += 1) {',
  "      const cTag = cur.tagName ? cur.tagName.toLowerCase() : ''",
  "      if (cTag === 'body' || cTag === 'html' || cTag === 'main') break",
  '      const cnt = ancCounts.get(cur) || 0',
  '      if (groupTags.has(cTag) && cnt >= 2 && cnt <= 6) { chosenGroup = cur; break }',
  '      cur = cur.parentElement',
  '    }',
  '    if (chosenGroup) {',
  '      let gid = groupMap.get(chosenGroup)',
  '      if (!gid) {',
  "        gid = 'g' + String(nextGroup)",
  '        nextGroup += 1',
  '        groupMap.set(chosenGroup, gid)',
  "        let gl = String(chosenGroup.getAttribute && chosenGroup.getAttribute('aria-label') || '')",
  '        if (!gl && chosenGroup.querySelector) {',
  "          const h = chosenGroup.querySelector('legend,h1,h2,h3,h4,h5,h6,caption')",
  "          if (h) gl = String(h.innerText || h.textContent || '')",
  '        }',
  "        gl = gl.split(String.fromCharCode(10)).join(' ').split(String.fromCharCode(9)).join(' ').trim().slice(0, 30)",
  '        groupLabels.set(chosenGroup, gl)',
  '      }',
  '      out[i][11] = gid',
  "      out[i][12] = groupLabels.get(chosenGroup) || ''",
  '    }',
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
  /** 语义区域：`true` = 主内容区（main/form/table/article/dialog），`false` = 页头/导航/页脚（nav/header/footer）。 */
  readonly inMain?: boolean
  /** 物理输入类型（如 `password` / `search` / `email` / `submit` / `text`），与语言无关。 */
  readonly inputType?: string
  /** HTML 标准自动填充语义（如 `username` / `current-password` / `one-time-code`）。 */
  readonly autocomplete?: string
  /** DOM 最小容器分组 ID（如 `g1`），同一局部容器内的控件共享。 */
  readonly groupId?: string
  /** 容器分组的简短标签（来自 legend / aria-label / 组内标题）。 */
  readonly groupLabel?: string
  /** 所属表单 ID；没有 DOM id 时为本次抽取内生成的编号。 */
  readonly formId?: string
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
    const [index, role, name, covered, extra, options, near, tag, inMain, inputType, autocomplete, groupId, groupLabel, formId] = entry as [
      unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown?, unknown?, unknown?, unknown?, unknown?, unknown?, unknown?,
    ]
    items.push({
      index: Number(index),
      role: String(role ?? ''),
      name: String(name ?? ''),
      covered: Number(covered) === 1,
      state: String(extra ?? ''),
      ...(Array.isArray(options) ? { options: options.map((option) => [String((option as unknown[])[0] ?? ''), String((option as unknown[])[1] ?? '')] as const) } : {}),
      ...(typeof near === 'string' && near !== '' ? { near } : {}),
      ...(typeof tag === 'string' && tag !== '' ? { tag } : {}),
      ...(typeof inMain === 'number' && inMain !== 0 ? { inMain: inMain > 0 } : typeof inMain === 'boolean' ? { inMain } : {}),
      ...(typeof inputType === 'string' && inputType !== '' ? { inputType } : {}),
      ...(typeof autocomplete === 'string' && autocomplete !== '' ? { autocomplete } : {}),
      ...(typeof groupId === 'string' && groupId !== '' ? { groupId } : {}),
      ...(typeof groupLabel === 'string' && groupLabel !== '' ? { groupLabel } : {}),
      ...(typeof formId === 'string' && formId !== '' ? { formId } : {}),
    })
  }
  return items
}

/** 动作句柄（CSS 选择器）。 */
export function handleOf(index: number): string {
  return `[${HANDLE_ATTRIBUTE}="${index}"]`
}
