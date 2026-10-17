/**
 * 浏览器设置页。
 *
 * 视觉照**通用设置面板**：一行 = 标题（14px）+ 子标题（12px secondary）+ 右侧控件；
 * 页头 = 标题（18px/500）+ 副标题（13px secondary）；**每一行都是同一条 16px 竖距 +
 * `.5px` 下边框，只有整页最后一行没有**（与 General 的 `:last-child{border-bottom:none}` 一致）。
 * 按钮样式逐字抄 skills-mcp 面板的「添加服务器」（`flex:none` + primary 填充色）——
 * 少了 `flex:none`，按钮会被左列的 `flex:1` 挤成竖排（真机踩过）。
 *
 * 写入：`form.set(field, value)`（整个顶层字段原子提交）；老宿主退回 `props.mutate`。
 * 配置是**普通字段**（不是 volatile）：改「浏览器功能」/「决策」会让 loader 重新应用 entry，
 * 工具随之注册/撤销——这正是这两个开关的语义。
 */

import './react.js'
import { useEffect, useState } from 'react'
import { SESSION_PATTERN, arrayOf, objectOf, parseDomains, snapshotOf, statusOf } from './config.js'
import CSS from './styles.css'

export function Panel(props) {
  const form = props.form
  const [tick, setTick] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** 安装自检结果（宿主 `ctx.browser.probe()` 的返回值）。 */
  const [probe, setProbe] = useState(null)
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState('')
  /** 帮忙装 CLI 的进度与结果。 */
  const [installing, setInstalling] = useState(false)
  const [installNote, setInstallNote] = useState('')

  useEffect(() => {
    if (typeof form?.subscribe !== 'function') return undefined
    return form.subscribe(() => setTick((count) => count + 1))
  }, [form])

  // 进页面就跑一次自检（CLI + Chrome）。`runProbe` 每次都重新取 ref，所以只跑一次。
  useEffect(() => {
    void runProbe()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 调宿主自检。
   *
   * ⚠️ `probe()` 是**零实参**方法：客户端必须一个都不传（多传会被客户端校验拦下）。
   */
  async function runProbe() {
    if (props.browser === undefined) {
      setProbeError('自检通路不可用（host 半未加载，或插件版本与客户端半不一致）')
      return
    }
    setProbing(true)
    setProbeError('')
    try {
      const envelope = await props.browser.probe()
      if (envelope?.ok !== true) throw new Error(envelope?.error?.message ?? '自检失败')
      setProbe(envelope.value ?? null)
    } catch (cause) {
      setProbeError(String(cause?.message ?? cause))
    } finally {
      setProbing(false)
    }
  }

  /** 帮忙装 agent-browser（**用户点击触发**），装完自动重跑自检。 */
  async function runInstall(target) {
    if (props.browser === undefined) return
    setInstalling(true)
    setInstallNote('正在安装…（可能要几分钟）')
    try {
      const envelope = await props.browser.installCli(target)
      if (envelope?.ok !== true) throw new Error(envelope?.error?.message ?? '安装失败')
      setInstallNote(envelope.value?.message ?? '安装结束')
      await runProbe()
    } catch (cause) {
      setInstallNote(`安装失败：${String(cause?.message ?? cause)}`)
    } finally {
      setInstalling(false)
    }
  }

  const value = snapshotOf(form)
  const status = statusOf(form)
  const browser = objectOf(value, 'browser')
  const tools = objectOf(value, 'tools')
  const limits = objectOf(value, 'limits')
  const session = objectOf(value, 'session')
  const judgment = objectOf(value, 'judgment')

  const writable = typeof form?.set === 'function' || typeof props.mutate === 'function'
  const enabled = value.enabled !== false
  const decision = tools.decision === true
  const screenshot = tools.screenshot !== false
  const raw = tools.raw === true
  const headed = browser.headed === true
  const contentBoundaries = browser.contentBoundaries !== false

  /** 一次顶层字段的原子提交。 */
  async function commit(field, next) {
    setBusy(true)
    setError('')
    try {
      // ⚠️ 宿主拒绝时 `set` **resolve false** 而不是 throw（见 dsh-client-ui-settings 的 ConfigForm）。
      // 早先这里只看 throw，所以"写被拒绝"表现为"点了没反应"——真机上就是这种现象。
      let accepted = true
      if (typeof form?.set === 'function') accepted = await form.set(field, next)
      else if (typeof props.mutate === 'function') accepted = await props.mutate(props.entryId, [{ op: 'set', path: [field], value: next }])
      else throw new Error('配置表单不可写：宿主既没有 set 也没有 mutate')
      if (accepted === false) throw new Error(`宿主拒绝了这次写入（${field}）：配置可能未通过校验，或当前文档不可写`)
      setTick((count) => count + 1)
      return true
    } catch (cause) {
      setError(String(cause?.message ?? cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** 改一个分组字段：`setGroup('tools', tools, 'decision', true)`。 */
  function setGroup(name, group, key, next) {
    return commit(name, { ...group, [key]: next })
  }

  void tick

  return (
    <div className="ab-page">
      <style>{CSS}</style>

      <header className="ab-pageHead">
        <h2 className="ab-pageTitle">浏览器</h2>
        <p className="ab-pageIntro">
          agent-browser（Rust + CDP）的窄工具面：快照、一个动作、读取、会话；可选一个由
          ctx.judgment 判断的目标循环。工具只在开启时进模型上下文，关掉即零成本。
        </p>
      </header>

      {status === 'loading' ? <p className="ab-note">正在读取设置…</p> : null}
      {writable ? null : <p className="ab-note">当前设置文档不可写：这个 profile 里该插件的配置被更高层覆盖了。</p>}
      {error !== '' ? <p className="ab-error" role="alert">{error}</p> : null}

      <InstallSummary
        probe={probe}
        probing={probing}
        error={probeError}
        installing={installing}
        note={installNote}
        onCheck={() => { void runProbe() }}
        onInstall={(target) => { void runInstall(target) }}
      />

      <section className="ab-section">
        <Row
          title="浏览器功能"
          subtitle="关闭后不注册任何工具（模型面前零成本），也不再启动会话。"
          control={(
            <Switch
              primitives={props.primitives}
              label="浏览器功能"
              checked={enabled}
              disabled={busy || !writable}
              onChange={(next) => { void commit('enabled', next) }}
            />
          )}
        />
        <Row
          title="决策"
          subtitle={decision
            ? `开启：多一个 browser_run，每步由 ctx.judgment 判断（用途名 ${String(judgment.purpose ?? 'browser.action')}）。`
            : '开启后多一个 browser_run：插件内部跑有界循环，每步由 ctx.judgment 在代码枚举的候选里选一个动作。'}
          control={(
            <Switch
              primitives={props.primitives}
              label="决策"
              checked={decision}
              disabled={!enabled || busy || !writable}
              onChange={(next) => { void setGroup('tools', tools, 'decision', next) }}
            />
          )}
        />
        <h3 className="ab-groupTitle">工具面</h3>
        <Row
          title="截图工具"
          subtitle="browser_screenshot：视觉兜底，或把页面给你看。"
          control={(
            <Switch
              primitives={props.primitives}
              label="截图工具"
              checked={screenshot}
              disabled={!enabled || busy || !writable}
              onChange={(next) => { void setGroup('tools', tools, 'screenshot', next) }}
            />
          )}
        />
        <Row
          title="逃生舱 browser_raw"
          subtitle="白名单内的其它 CLI 子命令（get / find / network / storage …）。禁 mcp、chat、install、plugin、connect、auth、--cdp、--profile。"
          control={(
            <Switch
              primitives={props.primitives}
              label="逃生舱"
              checked={raw}
              disabled={!enabled || busy || !writable}
              onChange={(next) => { void setGroup('tools', tools, 'raw', next) }}
            />
          )}
        />
        <h3 className="ab-groupTitle">进阶</h3>
        <StackedRow
          title="允许域名"
          subtitle="--allowed-domains：一行一个（逗号也行），如 a.com、*.b.com。留空 = 不限制。设了它就不能再用 profile（CLI 的 fail-closed）。"
          control={(
            <TextArea
              value={arrayOf(browser, 'allowedDomains').join('\n')}
              placeholder={'a.com\n*.b.com'}
              rows={4}
              disabled={!enabled || busy || !writable}
              onCommit={(text) => {
                const { domains, invalid } = parseDomains(text)
                if (invalid.length > 0) {
                  setError(`域名格式不合法：${invalid.join('、')}`)
                  return
                }
                void setGroup('browser', browser, 'allowedDomains', domains)
              }}
            />
          )}
        />
        <Row
          title="会话名"
          subtitle="--session：每个 agent 一个命名会话，避免劫持别的 agent 或人类开着的窗口。留空 = dsh-agent-browser。"
          control={(
            <TextField
              value={String(session.name ?? '')}
              placeholder="dsh-agent-browser"
              disabled={!enabled || busy || !writable}
              onCommit={(text) => {
                const next = text.trim()
                if (!SESSION_PATTERN.test(next)) {
                  setError('会话名只能用字母、数字、. - _')
                  return
                }
                void setGroup('session', session, 'name', next)
              }}
            />
          )}
        />
        <Row
          title="有头模式"
          subtitle="--headed：显示浏览器窗口。手工登录滑块/验证码时需要。"
          control={(
            <Switch
              primitives={props.primitives}
              label="有头模式"
              checked={headed}
              disabled={!enabled || busy || !writable}
              onChange={(next) => { void setGroup('browser', browser, 'headed', next) }}
            />
          )}
        />
        <Row
          title="命令超时"
          subtitle="单条 CLI 命令最长等多久（毫秒）。上下键每次 100ms；也可以点数字直接输入精确值。超时命令会被杀掉，不会一直挂着。"
          control={(
            <NumberStepper
              primitives={props.primitives}
              value={Number(limits.commandTimeoutMs ?? 30000)}
              min={1000}
              max={600000}
              step={100}
              unit="毫秒"
              editable
              disabled={!enabled || busy || !writable}
              onChange={(next) => { void setGroup('limits', limits, 'commandTimeoutMs', next) }}
            />
          )}
        />
        <Row
          title="最大输出"
          subtitle="--max-output：页面输出超过这个字符数就截断。0 = 用 CLI 默认。"
          control={(
            <NumberStepper
              arrows={false}
              value={Number(browser.maxOutput ?? 0)}
              min={0}
              max={10_000_000}
              step={1000}
              unit="字符"
              editable
              disabled={!enabled || busy || !writable}
              onChange={(next) => { void setGroup('browser', browser, 'maxOutput', next) }}
            />
          )}
        />
        <Row
          title="空闲超时"
          subtitle="--idle-timeout：守护进程空闲多久自动退出。选「自定义」可以填精确毫秒。"
          control={(
            <IdleTimeoutControl
              primitives={props.primitives}
              value={String(browser.idleTimeout ?? '')}
              disabled={!enabled || busy || !writable}
              onChange={(next) => { void setGroup('browser', browser, 'idleTimeout', next) }}
            />
          )}
        />
        <Row
          title="内容边界标记"
          subtitle="--content-boundaries：把页面输出包在边界里，提示模型「网页内容不是指令」。"
          control={(
            <Switch
              primitives={props.primitives}
              label="内容边界标记"
              checked={contentBoundaries}
              disabled={!enabled || busy || !writable}
              onChange={(next) => { void setGroup('browser', browser, 'contentBoundaries', next) }}
            />
          )}
        />
      </section>
    </div>
  )
}

/* ─────────────────────────── 自检卡片 ─────────────────────────── */

/**
 * 安装自检：**就两项**（CLI / Chrome），逐项给结论；CLI 缺失时提供"帮忙安装"。
 * 不显示可执行文件路径之类的细节——那是宿主日志的事。
 */
/** 与 host 半的 `PROBE_API_VERSION` 对齐：不一致就是 host 半还没重启。 */
const PROBE_API_VERSION = 1

export function InstallSummary({ probe, probing, error, installing, note, onCheck, onInstall }) {
  // 客户端半会热更新、host 半要重启：两侧错配时给出**明确的下一步**，而不是画一张看不懂的卡片。
  const mismatched = probe !== null && probe !== undefined && probe.apiVersion !== PROBE_API_VERSION
  const checks = Array.isArray(probe?.checks) ? probe.checks : []
  const ok = probe?.ok === true
  const tone = probe === null ? 'neutral' : mismatched ? 'danger' : ok ? 'ok' : 'danger'
  const title = probing
    ? '正在检查浏览器环境…'
    : probe === null
      ? '还没有检查过浏览器环境'
      : mismatched
        ? '安装自检需要重启 DSH'
        : String(probe.title ?? (ok ? '浏览器环境就绪' : '浏览器环境不完整'))

  /**
   * 按钮只有两个状态（用户口径）：
   * - **环境可用**（两项都过）→ `已安装`，**置灰不可点**——没问题就不该给一个"再检查一次"的诱惑；
   * - **环境不可用**（或还没检查过）→ `检查安装`，可点（修完环境后能重新确认）。
   */
  const needsCheck = probe === null || mismatched || !ok
  const buttonLabel = probing ? '检查中…' : needsCheck ? '检查安装' : '已安装'
  const buttonDisabled = probing || !needsCheck

  return (
    <section className="ab-summary" data-tone={tone}>
      <div className="ab-summaryHead">
        <span className="ab-dot" data-dot={tone} />
        <div className="ab-summaryTitle">{title}</div>
        <div className="ab-summaryAction">
          <button
            type="button"
            className="ab-button"
            data-variant="primary"
            disabled={buttonDisabled}
            title={needsCheck ? '检查本机的 agent-browser 与 Chrome' : '环境已就绪，无需检查'}
            onClick={onCheck}
          >
            {buttonLabel}
          </button>
        </div>
      </div>

      {mismatched ? (
        <p className="ab-note">客户端半已是新版本，但 host 半还是旧代码（Node 模块只在启动时加载）。重启 DSH 后自检即可正常显示。</p>
      ) : null}

      {!mismatched && checks.length === 0 && probe !== null ? <p className="ab-note">自检没有返回任何检查项。</p> : null}

      {(mismatched ? [] : checks).map((check) => (
        <div className="ab-check" key={String(check.id)} data-status={check.status}>
          <div className="ab-checkHead">
            <span className="ab-checkMark" aria-hidden="true">{check.status === 'pass' ? '✓' : '✗'}</span>
            <span className="ab-checkLabel">{String(check.label ?? check.id)}</span>
            <span className="ab-checkMessage">{String(check.message ?? '')}</span>
            {check.status === 'fail' && check.installable === true ? (
              <span className="ab-checkAction">
                <button
                  type="button"
                  className="ab-button"
                  data-variant="primary"
                  disabled={installing}
                  onClick={() => onInstall('cli')}
                >
                  {installing ? '安装中…' : '安装'}
                </button>
              </span>
            ) : null}
          </div>
          {check.status === 'fail' && check.fix !== undefined ? (
            <div className="ab-checkFix">修法：{check.fix}</div>
          ) : null}
        </div>
      ))}

      {note === '' ? null : <p className="ab-note">{note}</p>}
      {error === '' ? null : <p className="ab-error" role="alert">{error}</p>}
    </section>
  )
}

/* ─────────────────────────── 行与控件 ─────────────────────────── */

function Row({ title, subtitle, control }) {
  return (
    <div className="ab-row">
      <div className="ab-rowText">
        <div className="ab-rowTitle">{title}</div>
        <div className="ab-rowSubtitle">{subtitle}</div>
      </div>
      <div className="ab-rowControl">{control}</div>
    </div>
  )
}

/** 官方 primitives 的 Switch；拿不到就退回原生 checkbox（页面不因此不可用）。 */
function Switch({ primitives, label, checked, disabled, onChange }) {
  if (primitives?.Switch !== undefined) {
    return <primitives.Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
  }
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  )
}

/**
 * 数字步进器：照「通用设置 → 字号」那一行（ui-theme 的 `FontSizeRow`）——
 * 数值居中、右侧浮出上下两个小箭头，hover / 聚焦时才显形。没有 primitives 时用 ▲▼ 兜底。
 *
 * `editable` 时数值本身是个输入框（回车/失焦提交、自动夹到 [min,max]）：
 * 毫秒这种值光靠 ±100 点太累，但**别把数值做成只能点**。
 */
function NumberStepper({ primitives, value, min, max, step = 1, unit, disabled, editable = false, arrows = true, onChange }) {
  const Up = primitives?.IconChevronUpOutlineRegular
  const Down = primitives?.IconChevronDownOutlineRegular
  const [draft, setDraft] = useState(String(value))
  useEffect(() => {
    setDraft(String(value))
  }, [value])

  /** 输入框提交：非数字就还原；数字夹到区间内。 */
  function commitDraft() {
    const parsed = Number.parseInt(draft.replace(/[^\d]/g, ''), 10)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const next = Math.min(max, Math.max(min, parsed))
    setDraft(String(next))
    if (next !== value) onChange(next)
  }

  return (
    <>
      <div className="ab-stepper" data-disabled={disabled === true} data-editable={editable} data-arrows={arrows}>
        {editable ? (
          <input
            className="ab-stepperInput"
            value={draft}
            inputMode="numeric"
            aria-label={`${unit}数`}
            disabled={disabled === true}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
          />
        ) : (
          <span className="ab-stepperValue">{value}</span>
        )}
        {arrows ? (
        <span className="ab-stepperArrows">
          <button
            type="button"
            className="ab-stepperArrow"
            aria-label={`增加${unit}`}
            disabled={disabled === true || value >= max}
            // 别让点击箭头先把输入框失焦（那会先提交一次草稿，真机上表现为"点了没反应"）
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(Math.min(max, value + step))}
          >
            {Up === undefined ? '▲' : <Up size={9} />}
          </button>
          <button
            type="button"
            className="ab-stepperArrow"
            aria-label={`减少${unit}`}
            disabled={disabled === true || value <= min}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(Math.max(min, value - step))}
          >
            {Down === undefined ? '▼' : <Down size={9} />}
          </button>
        </span>
        ) : null}
      </div>
      <span className="ab-stepperUnit">{unit}</span>
    </>
  )
}

/** 空闲超时的预设（值是 CLI 的写法；`''` = 用 CLI 默认 1h）。 */
const IDLE_PRESETS = [
  { value: '', label: 'CLI 默认（1 小时）' },
  { value: '10m', label: '10 分钟' },
  { value: '30m', label: '30 分钟' },
  { value: '1h', label: '1 小时' },
  { value: '2h', label: '2 小时' },
]
/** 选「自定义」时，从当前预设折算一个初始毫秒值再让人改。 */
const IDLE_PRESET_MS = { '': 3_600_000, '10m': 600_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000 }
const IDLE_CUSTOM = '__custom__'

/**
 * 空闲超时：预设下拉 + 「自定义」时才出现的毫秒输入。
 * 存的是 CLI 认的字符串（`10m` / `1h` / 裸毫秒），所以切换预设就是换字符串，不需要换算。
 */
function IdleTimeoutControl({ primitives, value, disabled, onChange }) {
  const isPreset = value === '' || IDLE_PRESETS.some((preset) => preset.value === value)
  const selectValue = isPreset ? value : IDLE_CUSTOM
  const ms = isPreset ? (IDLE_PRESET_MS[value] ?? 3_600_000) : (Number(value) || 3_600_000)
  return (
    <>
      <select
        className="ab-select"
        value={selectValue}
        disabled={disabled}
        aria-label="空闲超时预设"
        onChange={(event) => {
          const next = event.target.value
          // 切到自定义：把当前预设折算成毫秒写进去，用户看到的就是真实生效值。
          onChange(next === IDLE_CUSTOM ? String(IDLE_PRESET_MS[value] ?? ms) : next)
        }}
      >
        {IDLE_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
        <option value={IDLE_CUSTOM}>自定义…</option>
      </select>
      {selectValue === IDLE_CUSTOM ? (
        <NumberStepper
          primitives={primitives}
          arrows={false}
          value={ms}
          min={0}
          max={86_400_000}
          step={1000}
          unit="毫秒"
          editable
          disabled={disabled}
          onChange={(next) => onChange(String(next))}
        />
      ) : null}
    </>
  )
}

/**
 * 上下布局的行：标题 + 子标题在上，控件在下面**占满整行**。
 * 留给"控件本身需要宽度"的项（目前只有允许域名——多行 textarea）。
 */
function StackedRow({ title, subtitle, control }) {
  return (
    <div className="ab-row ab-rowStacked">
      <div className="ab-rowText">
        <div className="ab-rowTitle">{title}</div>
        <div className="ab-rowSubtitle">{subtitle}</div>
      </div>
      <div className="ab-rowControl ab-rowControlFull">{control}</div>
    </div>
  )
}

/** 多行文本：本地草稿，**失焦时提交**（回车留给换行，别把用户输入打断）。 */
function TextArea({ value, placeholder, rows, disabled, onCommit }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => {
    setDraft(String(value))
  }, [value])
  return (
    <textarea
      className="ab-textarea"
      value={draft}
      placeholder={placeholder}
      rows={rows}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== String(value)) onCommit(draft)
      }}
    />
  )
}

/** 受控文本输入：本地草稿，失焦或回车时提交（避免每敲一个字写一次宿主文档）。 */
function TextField({ value, placeholder, disabled, onCommit }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => {
    setDraft(String(value))
  }, [value])
  return (
    <input
      className="ab-input"
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== String(value)) onCommit(draft)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
    />
  )
}
