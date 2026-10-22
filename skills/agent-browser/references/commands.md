# Command Reference

Complete reference for all `agent-browser` commands. For quick start and common patterns, see `SKILL.md`.

## Navigation

```bash
agent-browser open            # Launch browser on about:blank (no navigation).
                              # Pair with `network route`, `cookies set --curl`, or
                              # `addinitscript` to stage state before the first navigation.
agent-browser open <url>      # Launch + navigate (aliases: goto, navigate)
                              # Supports: https://, http://, file://, about:, data://
                              # Auto-prepends https:// if no protocol given
agent-browser read [url]      # Fetch agent-readable text, or read rendered active-tab DOM
                              # Explicit URLs send Accept: text/markdown, then try .md if needed
                              # Walks ancestor paths for llms.txt before HTML fallback
                              # --llms and --require-md without URL use the active tab URL
                              # --filter narrows page content to matching heading sections
                              # Honors --allowed-domains, --content-boundaries, and --max-output
                              # Options: --raw, --require-md, --outline, --llms <index|full>, --filter, --timeout <ms>
agent-browser back            # Go back
agent-browser forward         # Go forward
agent-browser reload          # Reload page
agent-browser pushstate <url> # SPA client-side navigation. Auto-detects
                              # window.next.router.push (triggers RSC fetch on Next.js);
                              # falls back to history.pushState + popstate/navigate events.
agent-browser close           # Close browser (aliases: quit, exit)
agent-browser connect 9222    # Connect to browser via CDP port
```

### Pre-navigation setup (one-turn batch)

```bash
agent-browser batch \
  '["open"]' \
  '["network","route","*","--abort","--resource-type","script"]' \
  '["cookies","set","--curl","cookies.curl","--domain","localhost"]' \
  '["navigate","http://localhost:3000/target"]'
```

`open` with no URL gives a clean launch so interception, cookies, or init scripts take effect on the *first* real navigation (useful for SSR-only debug with `--resource-type script`, protected-origin auth, or clean `react suspense`/`vitals` capture).

## Snapshot (page analysis)

```bash
agent-browser snapshot                # Full accessibility tree
agent-browser snapshot -i             # Interactive elements only (recommended)
agent-browser snapshot -c             # Compact output
agent-browser snapshot -d 3           # Limit depth to 3
agent-browser snapshot -s "#main"     # Scope to CSS selector (or `snapshot @e5`)
agent-browser snapshot --delta        # Full state once, then bounded structural deltas
agent-browser snapshot --delta --full # Force full state and refresh baseline
```

Delta history is isolated per tab and option set. Responses are `full`, `unchanged`, or `delta` (URL changes or large deltas return `full`). For `delta`, apply `changes` (`add`, `remove`, `replace`) to ref metadata; split the previous tree on newlines, splice `treeChange.lines` at zero-based `startLine` replacing `deleteCount` lines, then join with newlines. Apply both to `baseRevision` before advancing to `revision`; pass `--full` if the baseline is unavailable.

## Interactions (use @refs from snapshot)

```bash
agent-browser click @e1           # Click
agent-browser click @e1 --new-tab # Click and open in new tab
agent-browser dblclick @e1        # Double-click
agent-browser focus @e1           # Focus element
agent-browser fill @e2 "text"     # Clear and type
agent-browser type @e2 "text"     # Type without clearing
agent-browser press Enter         # Press key (alias: key)
agent-browser press Control+a     # Key combination
agent-browser keydown Shift       # Hold key down
agent-browser keyup Shift         # Release key
agent-browser hover @e1           # Hover
agent-browser check @e1           # Check checkbox
agent-browser uncheck @e1         # Uncheck checkbox
agent-browser select @e1 "value"  # Select by value or visible label (NBSP-normalized)
agent-browser select @e1 "a" "b"  # Select multiple options
agent-browser scroll down 500     # Scroll page (up/down/left/right; default: down 300px)
agent-browser scrollintoview @e1  # Scroll element into view (alias: scrollinto)
agent-browser drag @e1 @e2        # Drag and drop
agent-browser upload @e1 file.pdf # Upload files
```

Clicks fail before dispatch when another element covers the target's click point (`covered by <div#consent-banner>`). Dismiss or interact with the covering element, re-snapshot, then retry.

## Get Information

```bash
agent-browser get text @e1        # Get element text
agent-browser get html @e1        # Get innerHTML
agent-browser get value @e1       # Get input value
agent-browser get attr @e1 href   # Get attribute
agent-browser get title           # Get page title
agent-browser get url             # Get current URL
agent-browser get cdp-url         # Get CDP WebSocket URL
agent-browser get count ".item"   # Count matching elements
agent-browser get box @e1         # Get bounding box
agent-browser get styles @e1      # Get computed styles (font, color, bg, etc.)
```

## Check State

```bash
agent-browser is visible @e1      # Check if visible
agent-browser is enabled @e1      # Check if enabled
agent-browser is checked @e1      # Check if checked
```

## Screenshots and PDF

```bash
agent-browser screenshot                  # Save to temporary directory
agent-browser screenshot path.png         # Save to specific path
agent-browser screenshot --full           # Full page
agent-browser screenshot --if-changed     # Skip unchanged images to save tokens
agent-browser screenshot --threshold 0.01 # Ignore changes affecting <= 1% of pixels
agent-browser pdf output.pdf              # Save as PDF
```

`--threshold <0-1>` implies `--if-changed` (history isolated by tab and capture scope; first capture is always changed). JSON responses include `changed`, `revision`, `pixelChangeRatio`, and `threshold`; `path` is present only when the change exceeds the threshold. Headless Chromium hides native scrollbars by default; pass `--hide-scrollbars false` at launch to keep them visible.

## Video Recording

```bash
agent-browser open https://example.com
agent-browser record start ./demo.webm                # Record current page at 30 fps (1–60)
agent-browser record start ./scroll.webm --fps 60     # 60 fps for motion-heavy takes
agent-browser record start ./demo.webm --cursor       # Render animated mouse pointer
agent-browser record start ./demo.webm --contact-sheet # Save timestamped PNG summary
agent-browser record stop                             # Stop and save video
agent-browser record restart ./take2.webm             # Stop current + start new
```

Requires `ffmpeg` on PATH and an output filename with extension. `--contact-sheet-threshold <0-1>` adjusts keyframe sensitivity and implies `--contact-sheet`.

## Wait

```bash
agent-browser wait @e1                     # Wait for element
agent-browser wait 2000                    # Wait milliseconds
agent-browser wait --text "Success"        # Wait for text (or -t)
agent-browser wait --url "**/dashboard"    # Wait for URL pattern (or -u)
agent-browser wait --load domcontentloaded # Wait for DOMContentLoaded (or -l)
agent-browser wait --load load             # Wait for load event
agent-browser wait --load networkidle      # Wait for network idle (only on known-quiet pages)
agent-browser wait --fn "window.ready"     # Wait for JS condition (or -f)
```

Prefer selector, `--text`, `--url`, or `--fn` over `networkidle` (SSE, WebSockets, and polling can keep `networkidle` from resolving).

## Mouse Control

```bash
agent-browser mouse move 100 200                      # Move mouse instantly
agent-browser mouse move 600 400 --duration 250 --steps 24
agent-browser mouse move 600 400 --human --seed 42    # Reproducible human-like path
agent-browser mouse down left                         # Press button
agent-browser mouse up left                           # Release button
agent-browser mouse wheel 100                         # Scroll wheel
```

Use `--human` with `click`, `drag`, or `mouse move` when pointer-path events matter. `--duration` is target total duration including browser response time.

## Semantic Locators (alternative to refs)

```bash
agent-browser find role button click --name "Submit"
agent-browser find role heading text --name "Skills"  # Implicit roles work: <h2>=heading, <ul>=list, <header>=banner
agent-browser find text "Sign In" click
agent-browser find text "Sign In" click --exact       # Exact match only
agent-browser find label "Email" fill "user@test.com"
agent-browser find placeholder "Search" fill "query"
agent-browser find alt "Logo" click
agent-browser find title "Close" click
agent-browser find testid "submit-btn" click
agent-browser find first ".item" click
agent-browser find last ".item" click
agent-browser find nth 2 "a" hover
```

## Browser Settings

```bash
agent-browser set viewport 1920 1080          # Set viewport size
agent-browser set viewport 1920 1080 2        # 2x retina (same CSS size, higher-res screenshots)
agent-browser set device "iPhone 14"          # Emulate device
agent-browser set geo 37.7749 -122.4194       # Set geolocation (alias: geolocation)
agent-browser set offline on                  # Toggle offline mode
agent-browser set headers '{"X-Key":"v"}'     # Extra HTTP headers (set `{}` to reset)
agent-browser set credentials user pass       # HTTP basic auth for current and future tabs (alias: auth)
agent-browser set media dark                  # Emulate color scheme
agent-browser set media light reduced-motion  # Light mode + reduced motion
```

## Cookies and Storage

```bash
agent-browser cookies                                         # Get all cookies
agent-browser cookies set name value                          # Set cookie
agent-browser cookies set --curl <file> [--domain example.com] # Auto-detects JSON [{name,value}], DevTools Copy-as-cURL, or Cookie header (never echoes values)
agent-browser cookies clear                                   # Clear cookies
agent-browser storage local                                   # Get all localStorage
agent-browser storage local key                               # Get specific key
agent-browser storage local set k v                           # Set value
agent-browser storage local clear                             # Clear all
```

## Network

```bash
agent-browser network route <url>                                    # Intercept requests
agent-browser network route <url> --abort                            # Block requests
agent-browser network route <url> --body '{}'                        # Mock response
agent-browser network route '*' --abort --resource-type script       # Block scripts only (SSR-lock pattern)
agent-browser network route '*' --resource-type image,font --body '' # Stub images and fonts
agent-browser network unroute [url]                                  # Remove routes
agent-browser network requests                                       # View tracked requests
agent-browser network requests --filter api                          # Filter requests
agent-browser network request <requestId>                            # Full request/response detail incl. body
agent-browser network har start                                      # Record traffic (embeds text response bodies)
agent-browser network har start --content all                        # Embed all bodies (binary as base64)
agent-browser network har start --content none                       # Sizes and headers only
agent-browser network har stop [output.har]                          # Stop and save HAR
```

## Tabs and Windows

```bash
agent-browser tab                              # List tabs with tabId and label
agent-browser tab list --json                  # Include CDP targetId (stable across daemon restarts)
agent-browser tab new [url]                    # New tab
agent-browser tab new --label docs [url]       # New tab with a unique session label
agent-browser tab t2                           # Switch to tab by id (positional integers like `2` are rejected)
agent-browser tab docs                         # Switch to tab by label (or `tab <targetId>`)
agent-browser tab close [t2|docs|<targetId>]   # Close current or specified tab
agent-browser window new                       # New window
```

- **Refs & active tab**: Refs (`@eN`) belong to the tab active when `snapshot` ran; switch tabs first:
  ```bash
  agent-browser tab new --label docs https://docs.example.com
  agent-browser tab new --label app  https://app.example.com
  agent-browser tab docs && agent-browser snapshot -i && agent-browser click @e1
  agent-browser tab app  && agent-browser tab close docs
  ```
- **Inherited setup**: Tabs opened via `tab new` or `click --new-tab` inherit UA, `set headers`, `set credentials`, `--headers`, init scripts, `route` rules, and emulation overrides before their first document loads.
- **Pinned tabs (`--pin-tab`)**: If the bound tab closes, commands fail with `code: "tab_gone"` and recovery data (`data.targetId`, optional sanitized `data.lastUrl`; under `result` in `batch --json`). Recover via `tab new` or `tab list`.
- **Discarded & dialog-blocked tabs**: Switching to a memory-discarded tab reloads it and reports `"revived": true` (or `"activeTabRevived": true` when closing onto a discarded successor). A tab paused by a JS dialog is not reloaded and reports `"dialogBlocked": true`—resolve via `dialog accept`/`dialog dismiss`.

## Frames & Dialogs

```bash
agent-browser frame "#iframe"       # Switch to iframe by CSS selector (or frame name/URL)
agent-browser frame @e3             # Switch to iframe by element ref
agent-browser frame main            # Return to main frame
agent-browser dialog accept [text]  # Accept dialog
agent-browser dialog dismiss        # Dismiss dialog
agent-browser dialog status         # Check if a dialog is currently open
```

- **Iframes**: `snapshot -i` automatically inlines one level of accessible `Iframe` children (`@e3 [Iframe] "payment-frame"` → `@e4 [input] "Card number"`), and those child refs work directly (`agent-browser fill @e4 "4111..."`) without switching frames. Use `frame @e3` when you want snapshots scoped to that iframe.
- **Dialogs**: `alert` and `beforeunload` auto-accept by default; `confirm` and `prompt` require explicit `dialog accept`/`dismiss`. Pass `--no-auto-dialog` to disable auto-accept.

## JavaScript & Init Scripts

```bash
agent-browser eval "document.title"                 # Simple expressions only
agent-browser eval -b "<base64>"                    # Base64-encoded JS (avoids shell quote issues)
agent-browser eval --stdin                          # Read multiline script from stdin
agent-browser open --init-script <path>             # Register before first navigation (repeatable)
agent-browser addinitscript <js>                    # Register at runtime (returns session-wide identifier)
agent-browser removeinitscript <identifier>         # Remove from all open and future tabs in session

# Multiline script via heredoc:
cat <<'EOF' | agent-browser eval --stdin
Array.from(document.querySelectorAll('a')).map(a => a.href);
EOF
```

## Authentication, Plugins & State

```bash
agent-browser auth save <name> --url <url> --username <user> --password-stdin
agent-browser auth login <name>                                              # Navigate + login
agent-browser auth login <name> --no-navigate [--url <expected-origin-url>]  # Login on active same-origin HTTP(S) page without initial nav
agent-browser auth login <name> --credential-provider <plugin> [--item <ref>] [--url <url>]
agent-browser auth login <name> --username-selector <s> --password-selector <s> [--submit-selector <s>]
agent-browser auth list                                                      # List saved auth profiles
agent-browser auth show <name>                                               # Show profile metadata (never echoes passwords)
agent-browser auth delete <name>                                             # Delete a saved profile
agent-browser plugin add <ref> [--name <n>]                                  # Add plugin from npm or GitHub
agent-browser plugin list                                                    # List configured plugins
agent-browser plugin show <name>                                             # Show one configured plugin
agent-browser plugin run <name> <type> --payload <json>                      # Run `command.run` / custom plugin request
agent-browser state save auth.json                                           # Save cookies, storage, auth state
agent-browser state load auth.json                                           # Restore saved state
```

- `auth login` validates layout size, visibility, opacity, and disabled/readonly state; aborts if a credential field is replaced or redirects focus before entry.
- Plugins use `agent-browser.plugin.v1` stdio JSON capabilities: `credential.read` (gate with `--confirm-actions plugin:<name>:credential.read`), `browser.provider` (`--provider <name>`), `launch.mutate`, and `command.run`.

## Live Streaming, WebMCP & Dashboard

```bash
agent-browser stream status --json                  # Enabled state, port, client count
agent-browser stream enable [--port 9223]           # Start WebSocket stream server (ws://127.0.0.1:<port>)
agent-browser stream disable                        # Stop stream server
agent-browser webmcp list [tool] [--frame <id>] --json
agent-browser webmcp invoke <tool> [--frame <id>] --params '{"k":"v"}'       # Or `--params @input.json --detach`
agent-browser webmcp result <invocation-id>
agent-browser webmcp cancel <invocation-id>
agent-browser dashboard start [--port 8080] [--allowed-origins https://dashboard.example.com]
agent-browser dashboard stop
```

- **Stream protocol**: Clients receive `frame`, `status`, `tabs`, `url`, `console`; send `input_mouse`, `input_keyboard`, `input_touch`, `{"type":"config","maxFps":N}` (1–120, `0`=uncapped), or `{"type":"config","pacing":"ack"}` + `{"type":"ack","seq":N}` (also configurable via query `?pacing=ack&maxFps=10`).
- **Dashboard**: Loopback IPv4/IPv6 needs no token; `--allowed-origins` requires exact HTTPS origins and prints private tokenized URLs once.

## MCP Server

```bash
agent-browser mcp                              # Start stdio MCP server (default profile: `core`)
agent-browser mcp --tools all                  # Full typed CLI parity surface
agent-browser mcp --tools core,network,react   # Combine profiles
```

- **Profiles**: `core` (nav, snapshot, interact, wait, read, screenshot, eval, close, tab basics, profiles), `network` (routes, requests, HAR, headers, credentials, offline), `state` (cookies, storage, auth, state, sessions, profiles, skills), `debug` (console/errors, trace, profiler, record, a11y, clipboard, plugins, doctor, dashboard, batch, confirm/deny), `tabs` (history, tabs, windows, frames, dialogs), `react` (tree/inspect/renders/suspense, vitals, pushstate), `mobile` (viewport/device/geo/media, touch, swipe, mouse, keyboard), `all`.
- **Common tools**: `agent_browser_tools_profiles`, `agent_browser_open`, `agent_browser_snapshot`, `agent_browser_click`, `agent_browser_fill`, `agent_browser_type`, `agent_browser_press`, `agent_browser_wait_for_selector`, `agent_browser_screenshot`, `agent_browser_get_url`, `agent_browser_eval`, `agent_browser_close` (each accepts typed args, `session`, `allowedDomains`, and `extraArgs`).

## React, Web Vitals & Accessibility Audit

```bash
agent-browser open --enable react-devtools <url>        # Required at launch for `react ...` commands
agent-browser react tree                                # Full component tree
agent-browser react inspect <fiberId>                   # Props, hooks, state, source
agent-browser react renders start                       # Begin re-render recording
agent-browser react renders stop [--json]               # Stop and print render profile
agent-browser react suspense [--only-dynamic] [--json]  # Suspense boundaries (--only-dynamic hides static list)
agent-browser vitals [url] [--json]                     # LCP/CLS/TTFB/FCP/INP + hydration (framework-agnostic)
agent-browser a11y [url] [--tags wcag2a,wcag2aa] [--selector "#main"] [--json]
```

`a11y` runs embedded axe-core across frames via CDP (unaffected by page CSP; preserves `window.axe` and iframe/shadow-DOM selector paths; requires CDP browser). `--json` returns `counts`, `violations`, and `incomplete` (`id`, `impact`, `help`, `helpUrl`, `tags`, `nodeCount`, and up to 10 `nodes` with `target` selector path arrays, `html`, `failureSummary`).

## Debugging

```bash
agent-browser --headed open example.com   # Show browser window
agent-browser --cdp 9222 snapshot         # Connect via CDP port
agent-browser console [--clear]           # View or clear console messages
agent-browser errors [--clear]            # View or clear page errors
agent-browser highlight @e1               # Highlight element
agent-browser inspect                     # Open Chrome DevTools for this session
agent-browser trace start                 # Start recording trace
agent-browser trace stop trace.json       # Stop and save trace
agent-browser profiler start              # Start Chrome DevTools profiling
agent-browser profiler stop trace.json    # Stop and save profile
```

## Global Options

```bash
agent-browser --session <name> ...    # Isolated browser session
agent-browser --json ...              # JSON output for parsing
agent-browser --headed ...            # Show browser window (auto-starts Xvfb on displayless Linux)
agent-browser --webgpu ...            # Enable WebGPU (SwiftShader software Vulkan on Linux)
agent-browser --no-webmcp ...         # Disable experimental WebMCP Chrome features
agent-browser --cdp <port|url> ...    # Connect via CDP; root query slash is optional
agent-browser --auto-connect ...      # Auto-discover running Chrome with remote debugging
agent-browser --pin-tab ...           # Pin session to its bound tab (strict tab binding)
agent-browser --no-pin-tab ...        # Disable sticky pin previously enabled with --pin-tab
agent-browser -p <provider> ...       # Browser provider or configured provider plugin
agent-browser --profile <name|path>   # Chrome profile name (read-only snapshot) or persistent directory
agent-browser --restore ...           # Persist session cookies + storage across close/idle/relaunch
agent-browser --state <path> ...      # Load initial state from file
agent-browser --allowed-domains <d>   # Network allowlist (blocks HTTP/WS/SSE/beacon/WebRTC/workers)
agent-browser --content-boundaries    # Wrap page output in untrusted content boundary markers
agent-browser --max-output <bytes>    # Cap command output size
agent-browser --confirm-actions <l>   # Require confirmation for listed categories/capabilities
agent-browser --idle-timeout <time>   # Daemon idle timeout (default 1h; 0 = disable)
agent-browser --proxy <url> ...       # Use proxy server
agent-browser --proxy-bypass <hosts>  # Hosts to bypass proxy
agent-browser --headers <json> ...    # HTTP headers scoped to URL's origin
agent-browser --executable-path <p>   # Custom browser executable
agent-browser --extension <path> ...  # Load browser extension (repeatable)
agent-browser --ignore-https-errors   # Ignore SSL certificate errors
agent-browser --ca-cert <path>        # Trust a CA in local Chromium on Linux (uses certutil)
agent-browser --no-ca-cert            # Clear CA trust retained by the running session
agent-browser --hide-scrollbars false # Keep native scrollbars visible in headless screenshots
agent-browser --no-auto-dialog        # Disable automatic accept of alert/beforeunload dialogs
agent-browser --help | --version      # Show help (-h) or version (-V)
```

## Environment Variables

```bash
AGENT_BROWSER_SESSION="mysession"            # Default session name
AGENT_BROWSER_EXECUTABLE_PATH="/path/chrome" # Custom browser path
AGENT_BROWSER_EXTENSIONS="/ext1,/ext2"       # Comma-separated extension paths
AGENT_BROWSER_INIT_SCRIPTS="/a.js,/b.js"     # Comma-separated init script paths
AGENT_BROWSER_ENABLE="react-devtools"        # Comma-separated built-in init script features
AGENT_BROWSER_HIDE_SCROLLBARS="false"        # Keep native scrollbars visible in headless screenshots
AGENT_BROWSER_WEBGPU="1"                     # Enable WebGPU launch preset
AGENT_BROWSER_NO_XVFB="1"                    # Disable automatic Xvfb for headed mode on displayless Linux
AGENT_BROWSER_NO_WEBMCP="1"                  # Disable experimental WebMCP features
AGENT_BROWSER_PROVIDER="browserbase"         # Browser provider or configured provider plugin
AGENT_BROWSER_PROFILE="~/.myapp-profile"     # Default profile name or persistent directory
AGENT_BROWSER_PIN_TAB="1"                    # Enable strict sticky tab pinning
AGENT_BROWSER_AUTOSAVE_INTERVAL_MS="30000"   # --restore periodic autosave interval (0 = save only on close)
AGENT_BROWSER_IDLE_TIMEOUT_MS="3600000"      # Daemon idle timeout in ms (0 = disable)
AGENT_BROWSER_ENCRYPTION_KEY="<hex32>"       # 32-byte hex key to encrypt saved state at rest
AGENT_BROWSER_STREAM_PORT="9223"             # Override WebSocket streaming port (default: OS-assigned)
AGENT_BROWSER_DASHBOARD_ALLOWED_ORIGINS="https://dashboard.example.com" # Trusted HTTPS dashboard origins
AGENT_BROWSER_CONFIG="./agent-browser.json"  # Custom config file
AGENT_BROWSER_CDP="9222"                     # Connect daemon to CDP port or WebSocket URL
AGENT_BROWSER_ALLOWED_DOMAINS="example.com"  # Restrict network domains (requires fresh controllable context)
AGENT_BROWSER_PLUGINS='[{"name":"vault","command":"agent-browser-plugin-vault","capabilities":["credential.read"]}]'
BROWSER_USE_API_KEY="your-api-key"           # Browser Use Cloud API key
BROWSER_USE_PROFILE_ID="profile-uuid"        # Optional Browser Use profile UUID
BROWSER_USE_PROXY_COUNTRY="de"               # Managed proxy country; none/direct disables proxy
BROWSER_USE_ENABLE_RECORDING="true"          # Record the Browser Use Cloud session
```

Browser Use Cloud lifecycle: setup is bounded to 18s (10s create, 8s CDP attach, 4s stop). `close` succeeds only after the Cloud session confirms stop; a failed stop keeps the session id for retrying `close` and blocks new launches until released.
