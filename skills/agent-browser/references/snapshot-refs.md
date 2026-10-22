# Snapshot and Refs

Compact `@eN` element references (`~200–400 tokens` vs `~3000–5000 tokens` for full DOM/HTML).

## The Snapshot Command & Output Format

```bash
agent-browser snapshot                # Full accessibility tree (page structure)
agent-browser snapshot -i             # Interactive elements only (RECOMMENDED)
agent-browser snapshot -c             # Compact output
agent-browser snapshot -d 3           # Limit tree depth
agent-browser snapshot -s "#main"     # Scope to CSS selector
agent-browser snapshot @e9            # Scope to a specific element ref container
agent-browser snapshot -i --delta     # Full state once, then structural deltas per tab/option-set
agent-browser snapshot --delta --full # Force full state and refresh delta baseline
```

Example output:

```
Page: Example Site - Home
URL: https://example.com

@e1 [header]
  @e2 [nav]
    @e3 [a] "Home"
    @e4 [a] "Products"
  @e6 [button] "Sign In"

@e7 [main]
  @e8 [h1] "Welcome"
  @e9 [form]
    @e10 [input type="email"] placeholder="Email"
    @e11 [input type="password"] placeholder="Password"
    @e12 [button type="submit"] "Log In"
```

Interact directly using `@eN` refs:

```bash
agent-browser click @e6                    # Click "Sign In"
agent-browser fill @e10 "user@example.com" # Fill email input
agent-browser fill @e11 "password123"      # Fill password
agent-browser click @e12                   # Submit form
```

## Ref Lifecycle

Same-document updates preserve refs for surviving DOM elements. Replaced elements and page or iframe document replacements invalidate the corresponding refs. Invalidated IDs are never recycled within the browser session. JSON snapshot responses list refs that disappeared in `removedRefs`. Virtual accessibility nodes have snapshot-local refs.

```bash
agent-browser snapshot -i   # Initial snapshot: @e1 [button] "Next"
agent-browser click @e1     # Triggers navigation or DOM replacement
agent-browser snapshot -i   # Re-snapshot to get new refs: @e2 [heading] "Page 2"
```

## Best Practices

1. **Always snapshot before interacting**: Never guess `@e1` after `open` without running `snapshot -i` first.
2. **Re-snapshot after navigation**: Page transitions replace the document and invalidate prior refs.
3. **Re-snapshot after dynamic DOM changes**: After clicking a dropdown trigger, modal button, or tab, run `snapshot -i` to see newly revealed elements.
4. **Scope complex pages**: Use `agent-browser snapshot @e9` or `snapshot -s "#main"` to inspect a specific region.

## Ref Notation Details

```
@e1 [tag type="value"] "text content" placeholder="hint"
│    │   │             │               └─ Additional attributes
│    │   │             └─ Visible text
│    │   └─ Key attributes shown
│    └─ HTML tag name
└─ Unique ref ID
```

Common patterns:

```
@e1 [button] "Submit"                    # Button with text
@e2 [input type="email"]                 # Email input
@e3 [input type="password"]              # Password input
@e4 [a href="/page"] "Link Text"         # Anchor link
@e5 [select]                             # Dropdown
@e6 [textarea] placeholder="Message"     # Text area
@e7 [div class="modal"]                  # Container (when relevant)
@e8 [img alt="Logo"]                     # Image
@e9 [checkbox] checked                   # Checked checkbox
@e10 [radio] selected                    # Selected radio
```

## Iframes

Snapshots automatically detect and inline iframe content. When the main-frame snapshot runs, each `Iframe` node is resolved and its child accessibility tree is included directly beneath it in the output. Refs assigned to elements inside iframes carry frame context, so `click`, `fill`, and `type` work without manually switching frames:

```bash
agent-browser snapshot -i
# @e1 [heading] "Checkout"
# @e2 [Iframe] "payment-frame"
#   @e3 [input] "Card number"
#   @e4 [input] "Expiry"
#   @e5 [button] "Pay"
# @e6 [button] "Cancel"

agent-browser fill @e3 "4111111111111111"
agent-browser fill @e4 "12/28"
agent-browser click @e5
```

**Key details:**
- Only one level of iframe nesting is expanded (iframes within iframes are not recursed)
- Cross-origin iframes that block accessibility tree access are silently skipped
- Empty iframes or iframes with no interactive content are omitted from the output
- To scope a snapshot to a single iframe, use `frame @ref` then `snapshot -i` (and `frame main` to return)

## Troubleshooting

- **`"Ref not found"` / `"Could not locate"`**: Element was replaced or page changed—run `agent-browser snapshot -i`.
- **Element not visible in snapshot**: Scroll down (`agent-browser scroll down 1000 && agent-browser snapshot -i`) or wait for dynamic content (`agent-browser wait @e1` / `wait --text "..."`).
- **Too many elements**: Scope to a container (`agent-browser snapshot @e5`) or extract text only (`agent-browser get text @e5`).
