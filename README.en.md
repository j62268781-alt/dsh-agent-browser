# dsh-agent-browser

Browser automation for **DeepSeek Harness**: the [`agent-browser`](https://www.npmjs.com/package/agent-browser)
CLI (Rust + CDP) exposed as a **narrow tool surface** plus a **settings page**, with an optional
goal loop judged by [`dsh-judgment`](../dsh-judgment/README.en.md).

**Language:** [中文](README.md) · English (this file)

> Why not MCP: `agent-browser mcp` injects dozens of atomic actions into the prompt globally, and it
> **structurally cannot** provide an in-plugin bounded loop, per-step freshness gating, an action
> ledger, or a settings page. Full reasoning in [DESIGN.md](DESIGN.md) §1.2 (Chinese).

## Status

| Item | State |
|---|---|
| Settings page (install self-check + two switches + tool rows + advanced + open config file) | ✅ |
| Install self-check: version / binary / native layer, optional deep Chrome + daemon check | ✅ (host `@Remote` + hand-written client contribution, cross-verified by `pnpm verify:remote`) |
| Bundled skill (`skills/agent-browser/`: core commands + 5 references) | ✅ (runtime `ctx.skills.register()`, no separate install) |
| `browser_snapshot` / `browser_act` / `browser_read` / `browser_session` / `browser_screenshot` | ✅ |
| `browser_raw` escape hatch (allowlist), default off | ✅ |
| `browser_run` goal loop with `ctx.judgment` | ✅ (live run still pending a Jev connection) |
| CLI version lock `>=0.38 <0.39` | ✅ (measured on 0.38.2) |
| Ledger / quota UI | ⏳ see DESIGN.md §8 |

### Install self-check

Opening **Settings → Browser** runs a lightweight check automatically; "检查安装" adds the deep pass.
Green = found, version in range, native binary. Yellow = usable but discounted (e.g. still going
through the Node wrapper, ~54ms per call). Red = missing / out of range / not runnable — with an
actionable fix. The deep pass reuses `agent-browser doctor --quick --json` (~0.5s) and keeps only
what affects browser availability.

### Bundled skill

`skills/agent-browser/` ships a core skill aligned with the installed CLI (130-line SKILL.md plus five
on-demand references). It is registered as a runtime skill at plugin start; the SKILL.md is used
verbatim and a short plugin-specific note is appended (tool names, `browser_run`, absolute reference
paths). `ctx.skills` is optional — without `dsh-skill` the registration is skipped and nothing else breaks.

`pnpm probe` spawns a real browser to verify the version lock, ref parsing, ref-based clicking, and
that a **stale ref is rejected** rather than silently clicking a different element.

## Install

```bash
dsh plugin --profile desktop add /Users/joeson/Documents/dsh-plugins/dsh-agent-browser
brew install agent-browser      # must be in [0.38.0, 0.39.0)
```

Configure in **Settings → Browser**. No MCP server is configured: tools only exist while
"Browser features" is on — turning it off costs zero prompt tokens.

## Tools

| Tool | Purpose |
|---|---|
| `browser_snapshot` | Accessibility tree + `@eN` refs, returns `origin` / `refs` / `digest`. Snapshot first, act second. |
| `browser_act` | The single mutation entry point, one action per call. Optional `expectUrl` / `expectName` freshness assertion. |
| `browser_read` | Read-only: `read <url>` (markdown / llms.txt negotiation) or element text/html/value/attr/title/url/count. |
| `browser_session` | `open` / `close` / `tabs`, on a named session (never hijacks another agent's or a human's window). |
| `browser_screenshot` | Screenshot (can be disabled). |
| `browser_raw` | Allowlisted other subcommands; `mcp`/`chat`/`install`/`plugin`/`connect`/`auth`/`--cdp`/`--profile` are refused. Off by default. |
| `browser_run` | Registered only when Decision is on: one goal → bounded in-plugin loop → trace + handoff. |

Refs are element-identity bound on 0.38.2 (measured): a stale ref fails with `Unknown ref` or
`Could not locate element with role=… name=…` instead of clicking something else. That is why this
plugin does **not** impose a mandatory `snapshot_id` gate.

## Performance (measured, agent-browser 0.38.2)

`spawn /bin/echo` 1.2ms · `spawn bash -c …` 1.4ms (bash is *more* expensive, not less) ·
`agent-browser --version` through the PATH Node wrapper 57.3ms ·
**native binary** `--version` 3.1ms / `get title` 3.7ms / `snapshot -i` 5.1ms / `click @e2` 16.8ms.

The plugin therefore spawns the CLI directly (one process, cheaper than the bash route) and by
default **resolves past the Node wrapper to the native `agent-browser-<platform>-<arch>` binary**
(11–15× less startup). `browser.executablePath` overrides it; a value containing `/` is used as-is.
In the decision loop the CLI is not the bottleneck (~22ms/step vs ~500ms per Jev judgment) — the win
is N steps inside **one** host turn. `pnpm probe` prints the command actually used plus per-call timings.

## Development

```bash
pnpm install && pnpm build && pnpm test && pnpm verify:remote && pnpm probe
```

Host half is a Node module: **restart DSH after changing it**. The client half reloads on refresh.
Config changes re-apply the entry, so tool registration follows the switches without a restart.

## License

MIT
