---
name: chrome-devtools
description: Drive and inspect a real Chrome browser through the `chrome-mcp` MCP server (chrome-devtools-mcp) — navigate pages, click and fill by accessible snapshot uid, capture screenshots, record performance traces and Lighthouse audits, read network requests and console messages, and debug CSS. Use whenever a task needs a live web page rather than static files or HTTP fetches.
whenToUse: The work involves a running Chrome page — reproduce or verify a web UI, automate a flow, inspect requests/console, audit performance or accessibility, or screenshot a site.
metadata:
  source: ChromeDevTools/chrome-devtools-mcp skills/chrome-devtools (v1.13.0)
  license: Apache-2.0
---

# Chrome DevTools for agents

The MCP server row is `chrome-mcp` in this profile, so every tool is exposed as
`mcp__chrome-mcp__<tool>`. This document uses the bare tool name; prefix it when
calling (for example `mcp__chrome-mcp__take_snapshot`, `mcp__chrome-mcp__navigate_page`).

Attribution: adapted from the `chrome-devtools` skill shipped with
ChromeDevTools/chrome-devtools-mcp (Apache-2.0).

## Browser lifecycle

- Chrome starts automatically on the first browser-touching call and stays up
  between calls. There is no start or stop tool; `close_page` closes a tab, not
  the browser.
- The server runs with `npx -y chrome-devtools-mcp --no-usage-statistics
  --no-performance-crux` (no CrUX field data, no usage statistics). Change the
  args on the Settings → MCP servers page; the writable block lives in the
  profile's `cordis.patch.yml`.
- Optional tool categories are **off** unless their flag is added to those args:
  `--categoryExtensions` (`install_extension`, `list_extensions`,
  `trigger_extension_action`), `--categoryNetworkMocks` (`mock_network`,
  `remove_network_mock`), `--memoryDebugging`. If a tool named in a recipe is
  absent, do not improvise: report which flag is missing.
- `--slim` is not enabled, so the full tool set is available.

## Core loop

1. `list_pages` — find the `pageId` (1-based) and page titles.
2. `navigate_page` (`type: url|back|forward|reload`) or `new_page` for a new tab.
3. `wait_for` when you know text that should appear; otherwise `take_snapshot`
   and read the rendered structure.
4. `take_snapshot` — an accessibility-tree text dump where every interactive
   element carries a `uid`. Prefer it over pixel guesses.
5. Act with that `uid`: `click`, `fill`, `fill_form`, `press_key`, `hover`,
   `drag`, optionally `upload_file`. Pass the same `pageId`.
6. Verify: a fresh `take_snapshot` (cheap) or `take_screenshot` (only when the
   visual state itself matters).

Snapshot uids are invalidated by navigation and by DOM churn — take a fresh
snapshot instead of reusing a stale uid.

## Tool selection

| Need | Tool |
|---|---|
| Page structure, element handles | `take_snapshot` |
| Visual state, layout, what the user sees | `take_screenshot` (`filePath` for large images, `uid` for one element, `fullPage` for the whole document) |
| Typing into a focused element / keyboard shortcuts | `press_key`, `type_text`, `fill` |
| Runtime data, one-off DOM math | `evaluate_script` (`function` or `sourcePath`; returns JSON-serializable values) |
| CSS cascade, matched rules, custom properties | `get_css_styles` — authoritative; paginate with `pageIdx` |
| Console output, with source-mapped stacks | `list_console_messages`, then `get_console_message` |
| Log an expression at a source line without editing code | `set_logpoints`, read back via `list_console_messages` |
| Network waterfall and request details (headers, cookies) | `list_network_requests`, `get_network_request` |
| Page load / interaction performance, Core Web Vitals | `performance_start_trace` → exercise the page → `performance_stop_trace` → `performance_analyze_insight` |
| Accessibility, SEO, best-practices, agentic-browsing audit | `lighthouse_audit` (saves full report; returns scores and failing nodes) |
| Device, network, color-scheme emulation | `emulate` (`viewport`, `networkConditions`, `cpuThrottlingRate`, `geolocation`, `colorScheme`, …; each call replaces prior settings) |
| Responsive check | `resize_page` |
| Dialog handling | `handle_dialog` (accept/dismiss; prompt text supported) |
| Video of a flow | `screencast_start` / `screencast_stop` |
| Memory analysis | `take_heapsnapshot` (writes a `.heapsnapshot` file) |

## Context discipline

- Large outputs: pass `filePath` (screenshots, snapshots, traces, reports) and
  read selectively afterwards instead of dumping everything into the transcript.
- Console and network listings support `pageSize` / `pageIdx` and type filters;
  narrow before paging.
- Set `includeSnapshot: false` (the default) on input actions; ask for a snapshot
  only when you need the new state.
- Parallel calls are fine as long as the causal order holds: navigate → wait →
  snapshot → interact.

## Performance workflow

1. `navigate_page` to the exact URL first (tracing reloads the page when
   `reload: true`, the default).
2. `performance_start_trace` (`filePath` for the raw trace, `ignoreCache` for a
   cold load).
3. Reproduce the interaction under test (scroll, click, type) while recording
   with `reload`/`autoStop` off.
4. `performance_stop_trace`, then `performance_analyze_insight` only for the
   insight ids the trace result lists (e.g. `LCPBreakdown`, `DocumentLatency`).
5. Report metric numbers and the specific insight, not the raw trace.

## Debugging workflow

- Reproduce first: navigate, wait, snapshot, then act, so console and network
  evidence belongs to the failing step.
- Console errors: `list_console_messages` (optionally `types: ["error",
  "warn"]`, `includeStackTraces: true`). Keep the console cleared between
  attempts by reloading the page.
- Network: `list_network_requests` (filter `resourceTypes`), then
  `get_network_request` for status, headers, timing and body (write bodies with
  `requestFilePath` / `responseFilePath` when large).
- If snapshots disagree with what you expect, `take_screenshot` the region and
  compare; if the page looks fine but behavior is wrong, use `set_logpoints`
  instead of editing source.

## Troubleshooting

- "Tool not found" for an extension, network-mock, or memory tool: the matching
  category flag is missing from the server args (see above).
- "No page" errors: call `list_pages`; the browser opens on first use, but a
  previous session may have left zero tabs — `new_page` recovers.
- A uid stops working: the page changed between snapshot and action — re-run
  `take_snapshot`.
- Chrome fails to launch: check the server log through the MCP settings page and
  the upstream guide,
  https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md
- When the MCP server cannot answer a question, point the user at DevTools
  itself (https://developer.chrome.com/docs/devtools) rather than guessing.
