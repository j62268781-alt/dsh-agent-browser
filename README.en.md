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
| Settings page (install self-check + flat row list + open config file) | ✅ |
| Install self-check: **two items** (CLI / Chrome) + one-click CLI install | ✅ (host `@Remote probe/installCli` + hand-written client contribution, cross-verified by `pnpm verify:remote`) |
| Bundled skill (`skills/agent-browser/`: core commands + 5 references) | ✅ (runtime `ctx.skills.register()`, no separate install) |
| `browser_snapshot` / `browser_act` / `browser_read` / `browser_session` / `browser_screenshot` | ✅ |
| `browser_raw` escape hatch (allowlist), default off | ✅ |
| `browser_run` goal loop with `ctx.judgment` | ✅ (verified on 39-task live benchmark: in-page DOM extraction, `inputs` batching, `subgoals`, and low-cost **Jev + upstream LLM handoff closed-loop**) |
| CLI requirement `>=0.38.2` (no upper bound) | ✅ (measured on 0.38.2; re-verified on 0.39.1) |
| Ledger / quota UI | ⏳ see DESIGN.md §8 |

### Install self-check

Opening **Settings → Browser** runs the check automatically. The button has two states: **environment
ready → a disabled grey "已安装"**, **environment unusable (or not checked yet) → an enabled "检查安装"**.
Exactly **two items**
(no paths, no wrapper/doctor noise): **agent-browser** (`已安装 0.39.1` — any version ≥ 0.38.2, or `本机没安装` plus an
**[安装]** button that runs `brew install agent-browser` / `npm i -g agent-browser` on click) and
**Chrome** (`已就绪`, or `没找到` with a download link — Chrome is mandatory). Both pass → green card;
otherwise red with the reason and the fix. Chrome is deliberately **not** auto-installed:
`brew install --cask google-chrome` needs an admin password, and a background process waiting for
one is the worst possible interaction.

### Bundled skill

`skills/agent-browser/` ships a core skill aligned with the installed CLI (130-line SKILL.md plus five
on-demand references). It is registered as a runtime skill at plugin start; the SKILL.md is used
verbatim and a short plugin-specific note is appended (tool names, `browser_run`, absolute reference
paths). `ctx.skills` is optional — without `dsh-skill` the registration is skipped and nothing else breaks.

`pnpm probe` spawns a real browser to verify the version floor, ref parsing, ref-based clicking, and
that a stale ref pointing at a deleted element is rejected instead of clicking something else
(the same-name ordinal fallback documented in DESIGN §1.1 is a known CLI caveat, not covered by the probe).

## Install

```bash
dsh plugin --profile desktop add @j62268781-alt/dsh-agent-browser
brew install agent-browser      # requires >= 0.38.2; newer versions work too
```

Also [on npm](https://www.npmjs.com/package/@j62268781-alt/dsh-agent-browser). The unscoped
name `dsh-agent-browser` was already taken on npm by an unrelated package, so this one is
published under the `@j62268781-alt` scope. To track the repository instead of the published
package, install from git:

```bash
dsh plugin --profile desktop add https://github.com/j62268781-alt/dsh-agent-browser.git
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

Refs are mostly element-identity bound (measured on 0.38.2 and 0.39.1): a stale ref usually fails
with `Unknown ref` or `Could not locate element with role=… name=…`. **There is one exception**:
when the target element is gone but a **same-named** element remains, resolution falls back to
role+name ordinal matching and silently clicks the neighbour (e.g. a list of identical `Delete`
buttons). That is why this plugin does **not** impose a mandatory `snapshot_id` gate, but instead
re-snapshots every step; for same-named lists / bulk actions pass `expectUrl` / `expectName` on
`browser_act` as an explicit freshness assertion.

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

- `src/extract.ts`: in-page DOM candidate extraction (one `eval` returns visible candidates, states, `near` context, page text, title, and URL).
- `src/task/`: modular decision loop split by responsibility (`types.ts`, `utils.ts`, `candidates.ts`, `gates.ts`, `judge.ts`, `actions.ts`, `loop.ts`, `index.ts`).When Jev cannot confidently progress (alternate probability `< 0.25` or ambiguous candidates), `browser_run` stops early and hands back the top actionable `candidates` (including `ref` selectors) and `pageText` so the upstream LLM can take over in one `browser_act` call without an extra snapshot roundtrip.
- `bench/`: 39-task live benchmark suite with per-task storage isolation and navigation diagnostics (`run.mjs`, `score.mjs`, `nav.mjs`, `tasks.mjs`).
- `tests/`: 177 unit and regression tests covering tool surface, self-check, extraction, deterministic gates, and loop handoff.

Host half is a Node module: **restart DSH after changing it**. The client half reloads on refresh.
Config changes re-apply the entry, so tool registration follows the switches without a restart.

## License

MIT
