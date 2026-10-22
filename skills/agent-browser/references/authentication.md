# Authentication Patterns

Login flows, session persistence, OAuth, 2FA, auth vault, and credential plugins.

## Import Auth from Your Browser

Reuse cookies and storage from a Chrome session you are already logged into.

**Step 1: Start Chrome with remote debugging**

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

> **Security note:** `--remote-debugging-port` exposes full browser control on localhost. Any local process can connect and read cookies or execute JS. Only use on trusted machines and close Chrome when done.

**Step 2: Grab the auth state**

```bash
agent-browser --auto-connect state save ./my-auth.json
```

**Step 3: Reuse in automation**

```bash
# Load auth at launch
agent-browser --state ./my-auth.json open https://app.example.com/dashboard

# Or load into an already-launched session
agent-browser open about:blank
agent-browser state load ./my-auth.json
agent-browser open https://app.example.com/dashboard

# Combine with --session <id> --restore so imported auth auto-persists across restarts
SESSION="$(agent-browser session id --scope worktree --prefix myapp)"
agent-browser --session "$SESSION" --restore --state ./my-auth.json open https://app.example.com/dashboard
```

> **Security note:** State files contain session tokens in plaintext. Add them to `.gitignore`, delete when no longer needed, and set `AGENT_BROWSER_ENCRYPTION_KEY` for encryption at rest.

## Persistent Profiles (`--profile`)

Point `agent-browser` at a Chrome user data directory (persists cookies, IndexedDB, service workers, and cache across restarts) or a Chrome profile name (read-only snapshot):

```bash
agent-browser profiles                                            # List available profiles
agent-browser --profile Default open https://app.example.com      # Read-only snapshot of Chrome Default profile
agent-browser --profile ~/.myapp-profile open https://app.example.com/login
agent-browser --profile ~/.profiles/admin open https://app.example.com
export AGENT_BROWSER_PROFILE=~/.myapp-profile
```

## Session Persistence (`--restore`)

Use `--restore` with a stable `--session` to auto-save and restore cookies + localStorage without managing files:

```bash
export AGENT_BROWSER_ENCRYPTION_KEY=$(openssl rand -hex 32)       # Optional: encrypt state at rest
SESSION="$(agent-browser session id --scope worktree --prefix twitter)"
agent-browser --session "$SESSION" --restore open https://twitter.com
# ... complete login flow ...
agent-browser --session "$SESSION" --restore close                # State saved to ~/.agent-browser/sessions/
```

## Basic Login Flow & Auth Vault (`auth save` / `auth login`)

```bash
# Navigate to login page and wait until credential inputs are usable
agent-browser open https://app.example.com/login
agent-browser wait --load domcontentloaded
agent-browser wait --fn "(() => { const usable = (el) => { const style = getComputedStyle(el); return !el.disabled && !el.readOnly && style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0; }; const username = Array.from(document.querySelectorAll('input[type=email], input[type=text], input[autocomplete=username], input[name*=email i], input[name*=user i], input[name*=login i]')).some(usable); const password = Array.from(document.querySelectorAll('input[type=password]')).some(usable); return username && password; })()"

agent-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Sign In"
agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
```

Do not use `networkidle` as a generic login wait because long-lived background connections (SSE/WebSockets) can keep it from resolving.

### Built-in Auth Vault & `--no-navigate`

```bash
echo "pw" | agent-browser auth save my-app --url https://app.example.com/login --username u --password-stdin
agent-browser auth login my-app
agent-browser auth login my-app --username-selector "#user" --password-selector "#pass" --submit-selector "#go"
agent-browser auth list
agent-browser auth show my-app    # Metadata only, never echoes passwords
agent-browser auth delete my-app
```

`auth login` filters matching controls by layout size, computed visibility and opacity, and disabled/readonly state (including custom CSS selectors). If a selected credential field is replaced or redirects focus before entry, the command fails without submitting.

For a form reached through an in-page click, challenge clearance, or consent dismissal, use `--no-navigate` so the prepared document is not discarded:

```bash
agent-browser open https://app.example.com/
agent-browser click "a[href='/login']"
agent-browser auth login my-app --no-navigate

# Hosted identity-provider flow (expected-origin override):
agent-browser auth login work --no-navigate --url https://identity.example.com/login
```

`--no-navigate` suppresses only the initial navigation. An active top-level HTTP(S) page is required, and `agent-browser` verifies that its scheme, host, and effective port match the credential URL (or command-level `--url` override) before filling either credential. Paths, queries, and fragments may differ.

## Plugins (`agent-browser.plugin.v1`)

External executables configured in `agent-browser.json` (or `AGENT_BROWSER_PLUGINS`) over the `agent-browser.plugin.v1` stdio JSON protocol. Plain `name` or `@scope/name` resolves from npm; `owner/repo` resolves from GitHub:

```bash
agent-browser plugin add agent-browser-plugin-vault --name vault
agent-browser plugin add @company/agent-browser-plugin-vault --name vault
agent-browser plugin add org/agent-browser-plugin-cloud-browser
agent-browser plugin list
agent-browser plugin show vault
```

Example `agent-browser.json`:

```json
{
  "plugins": [
    { "name": "vault", "command": "agent-browser-plugin-vault", "capabilities": ["credential.read"] },
    { "name": "cloud-browser", "command": "agent-browser-plugin-cloud-browser", "capabilities": ["browser.provider"] },
    { "name": "stealth", "command": "agent-browser-plugin-stealth", "capabilities": ["launch.mutate"] },
    { "name": "captcha", "command": "agent-browser-plugin-captcha", "capabilities": ["command.run", "captcha.solve"] }
  ]
}
```

Usage and capability confirmation gates:

```bash
# Just-in-time credential resolution (secret stays in memory, out of process args/output)
agent-browser auth login my-app --credential-provider vault --item "My App"
agent-browser auth login my-app --credential-provider vault --item "My App" --no-navigate --url https://identity.example.com/login

# Browser provider and generic domain commands
agent-browser --provider cloud-browser open https://example.com
agent-browser plugin run captcha captcha.solve --payload '{"siteKey":"...","url":"https://example.com"}'

# Gate sensitive capabilities with --confirm-actions
agent-browser --confirm-actions plugin:vault:credential.read auth login my-app --credential-provider vault --item "My App"
agent-browser --confirm-actions plugin:cloud-browser:browser.provider --provider cloud-browser open https://example.com
agent-browser --confirm-actions plugin:stealth:launch.mutate open https://example.com
```

Do not put vault tokens or passwords in plugin command args; use the vault vendor's own login/session mechanism or environment variables outside `agent-browser` config.

## OAuth / SSO, 2FA, Basic Auth, Cookies & Token Refresh

### OAuth / SSO Flows

```bash
agent-browser open https://app.example.com/auth/google
agent-browser wait --url "**/accounts.google.com**"
agent-browser snapshot -i
agent-browser fill @e1 "user@gmail.com"
agent-browser click @e2
agent-browser wait 2000 && agent-browser snapshot -i
agent-browser fill @e3 "$GOOGLE_PASSWORD"
agent-browser click @e4
agent-browser wait --url "**/app.example.com**"
agent-browser state save ./oauth-state.json
```

### Two-Factor Authentication (Human Handoff)

```bash
agent-browser open https://app.example.com/login --headed
agent-browser snapshot -i
agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "$APP_PASSWORD"
agent-browser click @e3
# Wait up to 2 minutes for user to complete 2FA manually in the browser window
agent-browser wait --url "**/dashboard" --timeout 120000
agent-browser state save ./2fa-state.json
```

### HTTP Basic Auth & Cookie-Based Auth

```bash
# HTTP Basic Auth (applies to current and future tabs opened via tab new / click --new-tab)
agent-browser set credentials username password
agent-browser open https://protected.example.com/api

# Cookie-Based Auth
agent-browser cookies set session_token "abc123xyz"
agent-browser cookies set --curl ./auth.curl --domain app.example.com
agent-browser open https://app.example.com/dashboard
```

### Token Refresh Wrapper

```bash
STATE_FILE="./auth-state.json"
if [[ -f "$STATE_FILE" ]]; then
  agent-browser state load "$STATE_FILE"
  agent-browser open https://app.example.com/dashboard
  if [[ "$(agent-browser get url)" == *"/login"* ]]; then
    agent-browser snapshot -i
    agent-browser fill @e1 "$USERNAME" && agent-browser fill @e2 "$PASSWORD" && agent-browser click @e3
    agent-browser wait --url "**/dashboard"
    agent-browser state save "$STATE_FILE"
  fi
fi
```
