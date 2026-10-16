/**
 * 浏览器设置页。
 *
 * 视觉照**通用设置面板**：一行 = 标题（14px）+ 子标题（12px secondary）+ 右侧控件；
 * 页头 = 标题（18px/500）+ 副标题（13px secondary）。见同目录 styles.css 的注释。
 *
 * 写入：`form.set(field, value)`（整个顶层字段原子提交）；老宿主退回 `props.mutate`。
 * 配置是**普通字段**（不是 volatile）：改「浏览器功能」/「决策」会让 loader 重新应用 entry，
 * 工具随之注册/撤销——这正是这两个开关的语义。
 */

import './react.js'
import { useEffect, useState } from 'react'
import { IDLE_PATTERN, SESSION_PATTERN, arrayOf, objectOf, parseDomains, snapshotOf, statusOf } from './config.js'
import CSS from './styles.css'

export function Panel(props) {
  const form = props.form
  const [tick, setTick] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState('')
  /** 安装自检结果（宿主 `ctx.browser.probe()` 的返回值）。 */
  const [probe, setProbe] = useState(null)
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState('')

  useEffect(() => {
    if (typeof form?.subscribe !== 'function') return undefined
    return form.subscribe(() => setTick((count) => count + 1))
  }, [form])

  // 进页面先跑一次轻量自检（不跑 CLI 的 doctor）；点「检查安装」才做深度检查。
  useEffect(() => {
    void runProbe(false)
    // 只在挂载时跑一次：`runProbe` 每次都重新取 ref，放进依赖会无限循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 调宿主自检。
   *
   * ⚠️ `probe(deep)` 的**实参个数必须与 host 方法的形参个数相等**（Gateway 的 wire 约束）：
   * 即使只想轻量检查也要显式传 `false`，否则客户端会抛 `expected 1 argument(s), got 0`。
   */
  async function runProbe(deep) {
    if (props.browser === undefined) {
      setProbeError('自检通路不可用（host 半未加载，或插件版本与客户端半不一致）')
      return
    }
    setProbing(true)
    setProbeError('')
    try {
      const envelope = await props.browser.probe(deep)
      if (envelope?.ok !== true) throw new Error(envelope?.error?.message ?? '自检失败')
      setProbe(envelope.value ?? null)
    } catch (cause) {
      setProbeError(String(cause?.message ?? cause))
    } finally {
      setProbing(false)
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
      if (typeof form?.set === 'function') await form.set(field, next)
      else if (typeof props.mutate === 'function') await props.mutate(props.entryId, [{ op: 'set', path: [field], value: next }])
      else throw new Error('配置表单不可写：宿主既没有 set 也没有 mutate')
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

  async function openDocument() {
    setOpening(true)
    setOpenError('')
    try {
      const result = await props.settings.openSettingsDocument()
      if (result?.ok === false) throw new Error(result.error?.message ?? '打开失败')
    } catch (cause) {
      setOpenError(String(cause?.message ?? cause))
    } finally {
      setOpening(false)
    }
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
        primitives={props.primitives}
        probe={probe}
        probing={probing}
        error={probeError}
        onCheck={() => { void runProbe(true) }}
      />

      <section className="ab-section">
        <Row
          title="浏览器功能"
          subtitle="关闭后不注册任何工具（模型面前零成本），也不再启动会话。"
          disabled={busy || !writable}
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
          disabled={!enabled}
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
      </section>

      <section className="ab-section">
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
      </section>

      <section className="ab-section">
        <h3 className="ab-groupTitle">进阶</h3>
        <Field
          title="允许域名"
          subtitle="--allowed-domains：逗号分隔，如 a.com, *.b.com。留空 = 不限制。设了它就不能再用 profile（CLI 的 fail-closed）。"
          control={(
            <TextField
              value={arrayOf(browser, 'allowedDomains').join(', ')}
              placeholder="a.com, *.b.com"
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
        <Field
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
        <Field
          title="命令超时（毫秒）"
          subtitle="单条 CLI 命令的 spawn 超时。"
          control={(
            <TextField
              value={String(limits.commandTimeoutMs ?? 30000)}
              placeholder="30000"
              disabled={!enabled || busy || !writable}
              onCommit={(text) => {
                const next = Number(text.trim())
                if (!Number.isInteger(next) || next < 1000 || next > 600000) {
                  setError('命令超时要是 1000–600000 之间的整数')
                  return
                }
                void setGroup('limits', limits, 'commandTimeoutMs', next)
              }}
            />
          )}
        />
        <Field
          title="最大输出（字符）"
          subtitle="--max-output：页面输出截断。0 = 用 CLI 默认。"
          control={(
            <TextField
              value={String(browser.maxOutput ?? 0)}
              placeholder="0"
              disabled={!enabled || busy || !writable}
              onCommit={(text) => {
                const next = Number(text.trim())
                if (!Number.isInteger(next) || next < 0 || next > 10_000_000) {
                  setError('最大输出要是 0–10000000 之间的整数')
                  return
                }
                void setGroup('browser', browser, 'maxOutput', next)
              }}
            />
          )}
        />
        <Field
          title="空闲超时"
          subtitle="--idle-timeout：守护进程空闲多久退出（10s / 3m / 1h / 裸毫秒）。留空 = CLI 默认 1h。"
          control={(
            <TextField
              value={String(browser.idleTimeout ?? '')}
              placeholder="30m"
              disabled={!enabled || busy || !writable}
              onCommit={(text) => {
                const next = text.trim()
                if (!IDLE_PATTERN.test(next)) {
                  setError('空闲超时要像 10s / 3m / 1h / 60000，或留空')
                  return
                }
                void setGroup('browser', browser, 'idleTimeout', next)
              }}
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

      <section className="ab-section">
        <h3 className="ab-groupTitle">配置文件</h3>
        <Row
          title="打开配置文件"
          subtitle={props.hasDocument
            ? '在系统文本编辑器中打开宿主设置文档——本插件的配置段就在里面。'
            : '当前部署不提供本地设置文档（只有 loopback 桌面端才有），请在「设置」里改。'}
          control={(
            <Button
              primitives={props.primitives}
              label={opening ? '打开中…' : '打开'}
              disabled={props.hasDocument !== true || opening || props.settings === undefined}
              onClick={() => { void openDocument() }}
            />
          )}
        />
        {openError !== '' ? <p className="ab-error" role="alert">{openError}</p> : null}
      </section>
    </div>
  )
}

/* ─────────────────────────── 行与控件 ─────────────────────────── */

/**
 * 安装自检的 summary：绿（可用）/ 黄（可用但有折扣）/ 红（不可用）。
 * 只把**有问题的项**直接摊开（warn/fail），通过的项收进「全部检查」——
 * 设置页在出问题时给可执行的原因与修法，在正常时给一句话就好。
 *
 * 具名导出是为了渲染测试（`tests/panel.test.mjs`）能单独验三态。
 */
export function InstallSummary({ primitives, probe, probing, error, onCheck }) {
  const tone = probe === null ? 'neutral' : probe.status === 'ok' ? 'ok' : probe.status === 'warn' ? 'warn' : 'danger'
  const checks = Array.isArray(probe?.checks) ? probe.checks : []
  const issues = checks.filter((check) => check.status === 'warn' || check.status === 'fail')
  const rest = checks.filter((check) => check.status !== 'warn' && check.status !== 'fail')

  const title = probing
    ? '正在检查 agent-browser…'
    : probe === null
      ? '还没有检查过 agent-browser'
      : probe.summary
  const subtitle = probe === null
    ? '浏览器功能需要本机有 agent-browser（支持区间 0.38.x）。点「检查安装」跑一次。'
    : `${probe.command}${probe.version === undefined ? '' : ` · ${probe.version}`}${probe.native ? ' · 原生二进制' : ' · Node 包装层'} · 检查于 ${timeOf(probe.checkedAt)}`

  return (
    <section className="ab-summary" data-tone={tone}>
      <div className="ab-summaryRow">
        <span className="ab-dot" data-dot={tone} />
        <div className="ab-summaryText">
          <div className="ab-summaryTitle">{title}</div>
          <div className="ab-summarySub">{subtitle}</div>
        </div>
        <Button
          primitives={primitives}
          label={probing ? '检查中…' : '检查安装'}
          disabled={probing}
          onClick={onCheck}
        />
      </div>

      {issues.length > 0 ? (
        <ul className="ab-checks">
          {issues.map((check) => (
            <li className="ab-check" key={check.id} data-status={check.status}>
              <span className="ab-checkMessage">{check.message}</span>
              {check.fix === undefined ? null : <span className="ab-checkFix">修法：{check.fix}</span>}
            </li>
          ))}
        </ul>
      ) : null}

      {rest.length === 0 ? null : (
        <details className="ab-details">
          <summary>全部检查（{checks.length}）</summary>
          <ul className="ab-checks">
            {rest.map((check) => (
              <li className="ab-check" key={check.id} data-status={check.status}>
                <span className="ab-checkMessage">{check.message}</span>
                {check.fix === undefined ? null : <span className="ab-checkFix">修法：{check.fix}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {error === '' ? null : <p className="ab-error" role="alert">{error}</p>}
    </section>
  )
}

function timeOf(iso) {
  const date = new Date(String(iso ?? ''))
  return Number.isNaN(date.getTime()) ? '刚刚' : date.toLocaleTimeString()
}

function Row({ title, subtitle, control, disabled }) {
  return (
    <div className="ab-row" data-disabled={disabled === true}>
      <div className="ab-rowText">
        <div className="ab-rowTitle">{title}</div>
        <div className="ab-rowSubtitle">{subtitle}</div>
      </div>
      <div className="ab-rowControl">{control}</div>
    </div>
  )
}

/** 进阶项：标题 + 子标题在左，输入框在右（与开关行同一条基线）。 */
function Field({ title, subtitle, control }) {
  return (
    <div className="ab-row ab-rowField">
      <div className="ab-rowText">
        <div className="ab-rowTitle">{title}</div>
        <div className="ab-rowSubtitle">{subtitle}</div>
      </div>
      <div className="ab-rowControl ab-rowControlWide">{control}</div>
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

/** 官方 primitives 的 Button；拿不到就退回原生 button。 */
function Button({ primitives, label, disabled, onClick }) {
  if (primitives?.Button !== undefined) {
    return <primitives.Button disabled={disabled} onClick={onClick}>{label}</primitives.Button>
  }
  return <button type="button" className="ab-button" disabled={disabled} onClick={onClick}>{label}</button>
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
