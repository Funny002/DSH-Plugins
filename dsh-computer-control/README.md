# dsh-computer-control

A DeepSeek Harness Host plugin that gives the Agent a small, explicit desktop
capability on Windows: screenshot the screen, move/click/scroll/drag the real
pointer, type text or press key chords, inspect and control top-level windows,
and drive a window's UI Automation controls.

All desktop work happens in a bundled Windows PowerShell 5.1 runner that
P/Invokes `user32.dll` (plus UI Automation with a Microsoft Active Accessibility
fallback). The Node half owns the model-facing schemas, the screenshot directory,
durable image attachments, and a supervisor that keeps one runner process warm.

## Requirements

- Windows 10/11 with Windows PowerShell 5.1 (it supplies `System.Drawing`,
  `System.Windows.Forms`, and `UIAutomationClient`; PowerShell 7 does not).
- The plugin is mounted as a profile row through its bundle patch. The profile
  must provide the `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` peers.
- No runtime npm dependencies. The only native artifact is a small C# helper
  assembly compiled on first use and cached under
  `%LOCALAPPDATA%\dsh-computer-control` (keyed by a hash of its source).

## Tools

| Tool | Actions | Purpose |
| --- | --- | --- |
| `computer_screenshot` | capture | Whole display, virtual desktop, or a region; returns a PNG path and an image block. Regions are clamped to the virtual desktop; the text states the scale multiplier and cursor position. |
| `computer_screen_info` | — | Displays, virtual-desktop bounds, per-screen DPI/scale, cursor, foreground handle, and the runner's DPI awareness mode. |
| `computer_window` | `list`, `focus`, `move`, `minimize`, `maximize`, `restore`, `close` | Window handle/pid/process/bounds/title listing. `focus` verifies the foreground window; `close` refuses an ambiguous title. |
| `computer_mouse` | `move`, `click`, `scroll`, `drag` | Real pointer input in physical screen pixels. Every action accepts the `expect` foreground guard. |
| `computer_keyboard` | `type`, `key` | Unicode text (including CJK and surrogate pairs) or chords such as `ctrl+shift+s`, `ctrl++`, `f13`, `win`. Newlines become Enter. `expect` blocks input to an unexpected window. |
| `computer_ui` | `list`, `invoke`, `setValue`, `select`, `click`, `focus` | UI Automation controls: type, name, automation id, bounds, patterns, list items. Actions use UIA patterns first, MSAA fallback second, and coordinate click last. |

`computer_mouse`, `computer_keyboard`, the mutating `computer_window` actions,
and the mutating `computer_ui` actions are omitted when `inputEnabled` is false;
the plugin then only reads the screen and lists windows/controls.

## Configuration

The row config is optional; every key has a default.

| Key | Default | Meaning |
| --- | --- | --- |
| `screenshotDir` | `<DSH_HOME>/computer-control/screenshots` | Where PNG captures are written. |
| `maxImageWidth` | `1600` | Default downscale cap, 320–4096. A call may lower it, not raise it. |
| `inputEnabled` | `true` | `false` registers a read-only plugin. |
| `persistentRunner` | `true` | `false` forces one PowerShell process per action (useful for debugging). |

## Safety model

- **Input always goes to the foreground window.** `computer_keyboard` and
  `computer_mouse` accept `expect` — a decimal handle, `hwnd:…`, `pid:…`, or a
  title substring. The runner checks the foreground window immediately before
  sending anything and aborts with the actual title/handle/pid/process on a
  mismatch. Focus first with `computer_window focus`, then pass `expect`.
- **All actions are serialized.** The supervisor keeps one request in flight and
  the tools are registered as non-concurrency-safe, so two Agents cannot
  interleave keystrokes or clicks.
- **Mutating actions are not retried** after a transport failure. A lost click or
  keystroke may already have reached the desktop; replaying it is worse than
  reporting the failure. Read-only actions may fall back to one-shot.
- **Timeouts and cancellation kill the child process**, and disposal sends a
  `shutdown` request then force-kills the server if it does not exit.
- **Tests only drive `test/test-window.ps1`.** The window is created by the test,
  focused, driven with real input, and killed in a `finally` block. Never point
  these tests at an existing application.
- The plugin does not elevate, hook, install drivers, or make network calls.

## Architecture

- `lib/index.js` — config, tool schemas, screenshot directory/attachment
  projection, tool registration, and runner disposal.
- `lib/runner.js` — one warm `computer.ps1 -Server` process, JSON Lines protocol,
  request queue, idle shutdown, crash restart, one-shot fallback, temp-payload
  cleanup, timeout/cancellation.
- `lib/computer.ps1` — the desktop runner. In one-shot mode it performs one
  action and prints one JSON object. In server mode it prints
  `{"ready":true,...}`, then answers each `{"id","action","payload"}` line with
  `{"id","ok","result"}` or `{"id","ok":false,"error"}`.

Error contract: the PowerShell side catches every action error and writes one
line to stderr, `COMPUTER_CONTROL_ERROR: <message>`; the Node side reduces any
other PowerShell noise to its first useful line.

Coordinate handling: the runner sets per-monitor-v2 DPI awareness before any
screen or window query, so screenshot pixels, window bounds, UIA rectangles, and
`SetCursorPos` all use physical desktop pixels. A region crossing the virtual
desktop edge is clamped and reported with `clamped: true`.

Focus handling: `SetForegroundWindow` is supplemented with `AttachThreadInput`,
`BringWindowToTop`, and `SwitchToThisWindow`, then the result is verified. When
focusing by `pid`, hosted Windows Store windows are matched through child-window
ownership and process ancestry, because the launcher pid differs from the frame
host pid.

UI Automation detail: WinForms and other MSAA-based applications on some Windows
builds expose child windows as bare panes with no UIA patterns. The runner then
reads the MSAA role/name/state, infers the control type and supported patterns,
lists list/combo items, and uses `IAccessible` default actions or `accValue` when
UIA has no pattern. Editable controls also report their current value (except
password fields).

## Verification

Environment used: Windows 11 build 26200, primary display 2560×1440 at 0,0 and a
second 1920×1080 at x=2560 (virtual desktop 4480×1440), Node v26.13.0.

Commands and results:

```text
node --check lib/index.js lib/runner.js test/*.mjs      # syntax OK
powershell -File test/round1-check.ps1                   # failures=0 (29 checks)
powershell -File test/e2e-check.ps1                      # failures=0 (18 checks)
node test/tools-check.mjs                                # PASS (window/UIA/mouse/keyboard/screenshot)
node test/runner-check.mjs                               # PASS (warm server, fallback, timeout, cancellation)
node test/plugin-check.mjs                               # PASS (catalog, schemas, degradation, read-only)
node test/perf.mjs                                       # 20 moves, see below
```

Latency, 20 sequential `move` actions against the same test window:

| Path | Total | Average | p50 | Min | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| One-shot process per action | 13000 ms | 650.02 ms | 639.80 ms | 566.73 ms | 862.19 ms |
| Warm persistent runner | 22 ms | 1.11 ms | 0.84 ms | 0.75 ms | 4.86 ms |

Speedup ≈ 586×. Cold one-shot start was 996 ms; starting the warm server was
607 ms (including spawning PowerShell and announcing readiness). Once warm, a
desktop action costs roughly an IPC round trip.

The Node checks import `lib/index.js`, so they need `@deepseek-ai/schemastery`
resolvable from this directory. The development checkout keeps a git-ignored
`node_modules/@deepseek-ai/schemastery` junction to the installed Harness
package; a profile install supplies the same peer. The PowerShell checks have no
Node dependency.

## Known limits

- **UAC-elevated windows / higher integrity levels.** User Interface Privilege
  Isolation blocks `SendInput`, `SetCursorPos`, and UIA from a non-elevated
  runner. The call fails with a `SendInput ... Win32 error` or an unavailable UIA
  element; this plugin deliberately does not elevate.
- **Secure desktop.** The UAC consent prompt, lock screen, and Ctrl+Alt+Del
  desktop are separate desktops: window enumeration, capture, and input do not
  reach them.
- **Games with raw input.** DirectInput/Raw Input and anti-cheat software may
  ignore synthetic `SendInput`; there is no kernel driver or injection.
- **Protected content.** DRM/blacked-out windows may capture as black or expose
  no automation tree.
- **UIA quality varies.** Custom controls may expose no patterns; the MSAA
  fallback infers types/patterns and coordinate clicks depend on current bounds.
  A window that moves between `list` and `click` can invalidate coordinates.
- **Foreground restrictions.** Windows can still refuse focus changes from a
  background process (the mitigations are best effort). A locked or disconnected
  session may not be drivable at all.
- **Keyboard layout.** Text typing is layout-independent Unicode, but symbol key
  names assume a US layout; `win` can open the Start menu.
- **Scaling changes.** DPI awareness is fixed when the runner starts. Changing
  display scaling mid-session requires restarting the runner/plugin.
- **Close is a request.** `computer_window close` posts `WM_CLOSE`; an
  application may prompt, ignore it, or take longer than the wait window, which
  returns `closed: false`.
- **Capture size.** Large regions produce large PNGs; the default cap keeps image
  input near 1–2k tokens, and a call may not raise the configured cap.
- **Attachment store is optional.** A missing or refusing attachment service
  degrades the result to the text block with the PNG path and an
  `attachmentError` note.

## Development checks

```powershell
node --check lib/index.js
node --check lib/runner.js
Get-ChildItem test\*.mjs | ForEach-Object { node --check $_.FullName }
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File test\round1-check.ps1
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File test\e2e-check.ps1
node test\tools-check.mjs
node test\runner-check.mjs
node test\plugin-check.mjs
node test\perf.mjs
```

`test/test-window.ps1` is a disposable WinForms surface with a text box, an OK
button, a three-item list box, and a status label. It writes the text box to
`-ResultPath` when OK is clicked and the selected item to `<ResultPath>.selection`,
then closes itself after two minutes if a test crashes.

`test/plugin-check.mjs` also asserts that every tool's `parameters` and
`output.schema` are strict-API JSON Schema: `required` is an array of property
names and never the boolean form some schema DSLs accept, `type` is one string
rather than an array, and every required name exists in `properties`. A
malformed schema then fails this check instead of failing a live model request.

## License

MIT
