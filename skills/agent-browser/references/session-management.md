# Session Management

Multiple isolated browser sessions with state persistence and concurrent browsing.

## Named Sessions & Isolation Properties

Use `--session` to isolate browser contexts. Agent skills should derive one stable id and reuse it on every command:

```bash
SESSION="$(agent-browser session id --scope worktree --prefix my-skill)"
agent-browser --session "$SESSION" --restore open https://app.example.com/login
```

`--scope worktree` uses the Git worktree root when available, then the Git root, then the canonical current directory—recommended for parallel agent runs across worktrees.

```bash
# Session 1: Authentication flow
agent-browser --session auth open https://app.example.com/login
agent-browser --session auth fill @e1 "user@example.com"

# Session 2: Public browsing (separate cookies, storage)
agent-browser --session public open https://example.com
agent-browser --session public get text body
```

Each session launching its own browser has independent:
- Cookies
- LocalStorage / SessionStorage
- IndexedDB
- Cache
- Browsing history
- Open tabs

## Tab Pinning in a Shared Browser (`--pin-tab`)

Full isolation applies when each session launches its own browser. When sessions share one Chrome over `--cdp <port>` or `--auto-connect`, cookies and storage are shared, and only tab selection separates the sessions. Add `--pin-tab` on the first command so each session sticks to its own tab:

```bash
agent-browser --session agent1 --cdp 9222 --pin-tab open https://site-a.com
agent-browser --session agent2 --cdp 9222 --pin-tab open https://site-b.com
```

Every session remembers which tab it is bound to (by CDP `targetId`, persisted in the session's state directory), so a restarted daemon reattaches to the session's own tab instead of adopting the most recently active one. `--pin-tab` (env `AGENT_BROWSER_PIN_TAB=1`) makes the binding strict:

- Attaching with no binding opens a fresh tab instead of adopting an existing one
- If the bound tab is closed, commands fail with a `tab_gone` error instead of silently acting on another tab. JSON output includes `"code": "tab_gone"`, `data.targetId`, and optional `data.lastUrl`
- Recovery commands still work in that state: run `tab new <url>` to bind a fresh tab, or `tab list` and switch to an existing one
- Tabs opened by other sessions or the user never steal the pinned session's active tab

The flag is sticky per session: pass it once at session creation and later commands and daemon restarts keep the strict semantics. Pass `--no-pin-tab` to explicitly turn the pin off again. Use each tab's `targetId` from `tab list --json` when one session needs to reference another session's tab; target ids stay stable across daemon restarts.

The structured `lastUrl` is limited to sanitized HTTP(S) URLs and `about:blank` (credentials, query strings, and fragments are removed; opaque URLs like `data:` are omitted). In `batch --json`, the recovery object appears under `result` instead of `data`. Without `--pin-tab`, `open` preserves legacy behavior and navigates the shared active tab.

## Session State Persistence (`--restore`)

### Automatic Restore

```bash
# Bare --restore uses the current --session as the persistence key
SESSION="$(agent-browser session id --scope worktree --prefix next-dev-loop)"
agent-browser --session "$SESSION" --restore open https://app.example.com/dashboard
```

When `--restore` is configured, state is loaded before navigation and saved on close, daemon shutdown, idle timeout, and compatible relaunch. It is also saved periodically while the browser is open (after commands settle, at most once per `AGENT_BROWSER_AUTOSAVE_INTERVAL_MS`, default `30000`; set to `0` to save only on close), including during idle periods to capture background token refreshes. A `--session` ID alone only isolates the daemon in memory; without `--restore`, shutdown discards transient state and open tabs.

- **Idle timeout**: The daemon exits after 1 hour without commands or dashboard input by default (`--idle-timeout <time>` or `AGENT_BROWSER_IDLE_TIMEOUT_MS`; `0` disables). Headed, Safari/iOS WebDriver, and user-attached browsers are exempt; provider-owned cloud browsers are not.
- **Save policy & restore checks**: `--restore-save auto` (default) skips auto-save if restore or validation failed; `never` disables periodic autosave:
  ```bash
  agent-browser --session "$SESSION" --restore --restore-check-url "**/dashboard" open https://app.example.com/dashboard
  agent-browser --session "$SESSION" --restore --restore-check-text Dashboard open https://app.example.com/dashboard
  agent-browser --session "$SESSION" --restore --restore-check-fn "!!localStorage.getItem('session')" open https://app.example.com/dashboard
  ```
- **Diagnostics**: `agent-browser --session "$SESSION" session info --json`
- **Manual state files**: Use `state save`, `state load`, and `--state <path>` when you need an explicit portable JSON file. Do not construct paths under `~/.agent-browser/sessions/`; prefer `--restore` for reusable agent sessions.

## Common Patterns & Cleanup

### Concurrent Scraping

```bash
agent-browser --session site1 open https://site1.com &
agent-browser --session site2 open https://site2.com &
wait
agent-browser --session site1 get text body > site1.txt
agent-browser --session site2 get text body > site2.txt
agent-browser --session site1 close
agent-browser --session site2 close
```

### A/B Testing Sessions

```bash
agent-browser --session variant-a open "https://app.com?variant=a"
agent-browser --session variant-b open "https://app.com?variant=b"
agent-browser --session variant-a screenshot /tmp/variant-a.png
agent-browser --session variant-b screenshot /tmp/variant-b.png
```

### Session Listing, Cleanup & Best Practices

```bash
agent-browser session list                # List active sessions
agent-browser --session auth close        # Close specific session
timeout 60 agent-browser --session long-task get text body
```

- Name sessions semantically (`github-auth`, `docs-scrape`) or via `session id --scope worktree --prefix <name>`.
- Never commit state files (`echo "*.auth-state.json" >> .gitignore`); delete temporary state files when done.
