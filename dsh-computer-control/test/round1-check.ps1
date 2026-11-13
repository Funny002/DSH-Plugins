#requires -Version 5.1
<#
Round-1 check: runner correctness and robustness against the disposable test
window only. It never drives an existing application.

Covers: window listing/focus/foreground, the `expect` guard for typing, clicking,
and key chords, Unicode and surrogate-pair text, unusual chords (`ctrl++`, `f13`),
the meaningful PowerShell error line, screenshot region clamping and bounds,
screenshot directory failures, window move/minimize/restore/close, and the
UI Automation AndCondition used to locate the OK button.

    powershell.exe -File round1-check.ps1
#>
param(
  [string]$PluginRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$WorkDir = (Join-Path $env:TEMP ('dsh-computer-control-round1-' + [guid]::NewGuid().ToString('N').Substring(0, 8)))
)

$ErrorActionPreference = 'Stop'
$runner = Join-Path $PluginRoot 'lib\computer.ps1'
$testWindow = Join-Path $PSScriptRoot 'test-window.ps1'
$powershell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$resultPath = Join-Path $WorkDir 'result.txt'

New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

$failures = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) {
    Write-Output ('PASS ' + $name + $(if ($detail) { ' :: ' + $detail } else { '' }))
  } else {
    Write-Output ('FAIL ' + $name + $(if ($detail) { ' :: ' + $detail } else { '' }))
    $script:failures++
  }
}

function Invoke-RunnerRaw([string]$action, $payload) {
  $payloadPath = Join-Path $WorkDir ('payload-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
  $json = if ($null -eq $payload) { '{}' } else { $payload | ConvertTo-Json -Compress -Depth 8 }
  Set-Content -LiteralPath $payloadPath -Value $json -Encoding UTF8

  # Capture the child's raw streams with .NET instead of PowerShell redirection:
  # Windows PowerShell 5.1 decorates native stderr with "At line ..." frames,
  # which would hide the clean one-line error contract under test.
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $powershell
  $startInfo.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $runner +
    '" -Action "' + $action + '" -PayloadPath "' + $payloadPath + '"'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $startInfo.StandardOutputEncoding = $utf8
  $startInfo.StandardErrorEncoding = $utf8
  $process = [System.Diagnostics.Process]::Start($startInfo)
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  $code = $process.ExitCode
  $process.Dispose()
  Remove-Item -LiteralPath $payloadPath -Force -ErrorAction SilentlyContinue
  return [pscustomobject]@{ ExitCode = $code; Stdout = $stdout; Stderr = $stderr }
}

function Invoke-Runner([string]$action, $payload) {
  $raw = Invoke-RunnerRaw $action $payload
  if ($raw.ExitCode -ne 0) {
    $message = $raw.Stderr.Trim()
    if ($message -eq '') { $message = 'exit code ' + $raw.ExitCode }
    throw $message
  }
  $text = $raw.Stdout.Trim()
  if ($text -eq '') { throw 'the runner returned no result' }
  return ($text | ConvertFrom-Json)
}

function Wait-Content([string]$path, [string]$expected, [int]$timeoutMs = 8000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
  $last = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $path) {
      $last = [System.IO.File]::ReadAllText($path).Trim()
      if ($last -eq $expected) { return $last }
    }
    Start-Sleep -Milliseconds 120
  }
  return $last
}

function Get-Window([long]$handle) {
  $listing = Invoke-Runner 'windows' $null
  return ($listing.windows | Where-Object { $_.hwnd -eq $handle } | Select-Object -First 1)
}

$windowProcess = $null
try {
  $windowProcess = Start-Process -FilePath $powershell -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', $testWindow, '-ResultPath', $resultPath
  ) -PassThru

  $window = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 200
    $listing = Invoke-Runner 'windows' $null
    $window = $listing.windows | Where-Object { $_.title -eq 'DSH Computer Control Test' } | Select-Object -First 1
    if ($null -ne $window) { break }
  }
  Check 'test window appears in the window list' ($null -ne $window) ('hwnd=' + [string]$window.hwnd)
  if ($null -eq $window) { throw 'the test window never appeared' }
  $handle = [long]$window.hwnd

  $focus = Invoke-Runner 'focus' @{ hwnd = $handle }
  Check 'focus activates and verifies the window' ($focus.activated -eq $true -and $focus.foreground -eq $true) ($focus | ConvertTo-Json -Compress)

  $pidFocus = Invoke-Runner 'focus' @{ pid = $window.pid }
  Check 'focus by pid finds the window' ($pidFocus.hwnd -eq $handle) ('pid=' + [string]$window.pid)

  $front = Invoke-Runner 'foreground' $null
  Check 'foreground reports the focused window' ($front.hwnd -eq $handle) ($front.title)

  # The original harness failed here: New-Object cannot build an AndCondition
  # from two parenthesized expressions. Use the constructor instead.
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $form = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
  $nameCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'OK')
  $enabledCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true)
  $buttonCondition = [System.Windows.Automation.AndCondition]::new($nameCondition, $enabledCondition)
  $button = $form.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
  Check 'UIA AndCondition locates the OK button' ($null -ne $button) ($(if ($null -ne $button) { $button.Current.Name } else { 'not found' }))
  if ($null -eq $button) { throw 'the OK button was not found' }
  $rect = $button.Current.BoundingRectangle
  $buttonX = [int]($rect.X + $rect.Width / 2)
  $buttonY = [int]($rect.Y + $rect.Height / 2)

  $cjk = [string][char]0x4E2D + [char]0x6587
  $emoji = [char]::ConvertFromUtf32(0x1F600)
  $text = 'round1 ' + $cjk + ' ' + $emoji

  Invoke-Runner 'focus' @{ hwnd = $handle } | Out-Null
  $typed = Invoke-Runner 'type' @{ text = $text; expect = 'Computer Control Test' }
  Check 'guarded typing accepts Unicode and surrogate pairs' ($typed.typed -eq $text.Length) ('typed=' + $typed.typed + ' units=' + $text.Length)

  Invoke-Runner 'focus' @{ hwnd = $handle } | Out-Null
  $clicked = Invoke-Runner 'click' @{ x = $buttonX; y = $buttonY; expect = 'Computer Control Test' }
  Check 'coordinate click reaches the OK button' ($clicked.x -eq $buttonX -and $clicked.y -eq $buttonY) ('clicked=' + $clicked.x + ',' + $clicked.y)
  $saved = Wait-Content $resultPath $text
  Check 'the button wrote the typed text' ($saved -eq $text) ('saved=[' + [string]$saved + ']')

  $blocked = Invoke-RunnerRaw 'type' @{ text = 'SHOULD-NOT-APPEAR'; expect = 'a window that does not exist' }
  $blockedMessage = $blocked.Stderr.Trim()
  Check 'mismatched expect blocks typing' ($blocked.ExitCode -ne 0) $blockedMessage
  Check 'the input guard error starts with the clean prefix' ($blockedMessage.StartsWith('COMPUTER_CONTROL_ERROR:')) $blockedMessage
  Check 'the input guard error has no PowerShell stack frame' (-not $blockedMessage.Contains('At line')) $blockedMessage

  $beforeCursor = Invoke-Runner 'info' $null
  $blockedClick = Invoke-RunnerRaw 'click' @{ x = $buttonX; y = $buttonY; expect = 'a window that does not exist' }
  $afterCursor = Invoke-Runner 'info' $null
  Check 'mismatched expect blocks the click' ($blockedClick.ExitCode -ne 0) $blockedClick.Stderr.Trim()
  Check 'a blocked click does not move the pointer' (
    $beforeCursor.cursor.x -eq $afterCursor.cursor.x -and $beforeCursor.cursor.y -eq $afterCursor.cursor.y
  ) ('cursor=' + $afterCursor.cursor.x + ',' + $afterCursor.cursor.y)

  Invoke-Runner 'focus' @{ hwnd = $handle } | Out-Null
  $chord = Invoke-Runner 'key' @{ keys = 'ctrl++'; expect = 'Computer Control Test' }
  Check 'ctrl++ resolves to a multi-key chord' ($chord.pressed -ge 2 -and $chord.events -gt 0) ($chord | ConvertTo-Json -Compress)
  $f13 = Invoke-Runner 'key' @{ keys = 'f13'; expect = 'Computer Control Test' }
  Check 'f13 is a known key' ($f13.pressed -eq 1) ($f13 | ConvertTo-Json -Compress)
  $badChord = Invoke-RunnerRaw 'key' @{ keys = 'ctrl+nosuchkey'; expect = 'Computer Control Test' }
  Check 'an unknown key name is reported cleanly' (
    $badChord.ExitCode -ne 0 -and $badChord.Stderr.Contains('unknown key name')
  ) $badChord.Stderr.Trim()

  $shotPath = Join-Path $WorkDir 'region.png'
  $shot = Invoke-Runner 'screenshot' @{
    path = $shotPath
    region = @{ x = $window.x; y = $window.y; width = $window.width; height = $window.height }
    maxWidth = 800
  }
  Check 'region screenshot reports the physical bounds' (
    $shot.originalWidth -eq $window.width -and $shot.originalHeight -eq $window.height -and
    $shot.left -eq $window.x -and $shot.top -eq $window.y
  ) ($shot | ConvertTo-Json -Compress)
  Check 'region screenshot honors maxWidth' ($shot.width -le 800 -and $shot.height -gt 0) ($shot.width.ToString() + 'x' + $shot.height.ToString())
  Check 'screenshot includes the cursor position' ($null -ne $shot.cursorX -and $null -ne $shot.cursorY)
  Check 'screenshot file exists' (Test-Path -LiteralPath $shotPath) $shotPath

  $clamped = Invoke-Runner 'screenshot' @{
    path = (Join-Path $WorkDir 'clamped.png')
    region = @{ x = 4440; y = 0; width = 400; height = 100 }
    maxWidth = 400
  }
  Check 'a region crossing the desktop edge is clamped' ($clamped.clamped -eq $true -and $clamped.width -eq 40) ($clamped | ConvertTo-Json -Compress)

  $outside = Invoke-RunnerRaw 'screenshot' @{
    path = (Join-Path $WorkDir 'outside.png')
    region = @{ x = 9000; y = 9000; width = 100; height = 100 }
  }
  Check 'a region outside the desktop is refused' (
    $outside.ExitCode -ne 0 -and $outside.Stderr.Contains('outside the virtual desktop')
  ) $outside.Stderr.Trim()

  $blocker = Join-Path $WorkDir 'not-a-directory'
  Set-Content -LiteralPath $blocker -Value 'file' -Encoding ASCII
  $badDirectory = Invoke-RunnerRaw 'screenshot' @{ path = (Join-Path $blocker 'sub\shot.png') }
  Check 'an unusable screenshot directory is reported' (
    $badDirectory.ExitCode -ne 0 -and $badDirectory.Stderr.Contains('screenshot directory')
  ) $badDirectory.Stderr.Trim()

  $moved = Invoke-Runner 'window-move' @{ hwnd = $handle; x = 300; y = 300 }
  Check 'window-move reports the new position' ($moved.x -eq 300 -and $moved.y -eq 300) ($moved | ConvertTo-Json -Compress)
  $minimized = Invoke-Runner 'window-minimize' @{ hwnd = $handle }
  Check 'window-minimize reports the minimized state' ($minimized.minimized -eq $true) ($minimized | ConvertTo-Json -Compress)
  $restored = Invoke-Runner 'window-restore' @{ hwnd = $handle }
  Check 'window-restore clears the minimized state' ($restored.minimized -eq $false) ($restored | ConvertTo-Json -Compress)
  $focusAgain = Invoke-Runner 'focus' @{ hwnd = $handle }
  Check 'the window can be focused after restore' ($focusAgain.foreground -eq $true) ($focusAgain | ConvertTo-Json -Compress)

  $closed = Invoke-Runner 'window-close' @{ hwnd = $handle }
  Check 'window-close reports the window gone' ($closed.closed -eq $true) ($closed | ConvertTo-Json -Compress)
  $gone = $true
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 100
    if ($null -ne (Get-Window $handle)) { $gone = $false }
  }
  Check 'the closed window leaves the window list' $gone
} catch {
  Write-Output ('FAIL harness :: ' + $_.Exception.Message)
  $script:failures++
} finally {
  if ($null -ne $windowProcess) { Stop-Process -Id $windowProcess.Id -Force -ErrorAction SilentlyContinue }
  Get-Process -Name 'powershell' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -eq 'DSH Computer Control Test' } |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output ('failures=' + $failures)
exit $(if ($failures -eq 0) { 0 } else { 1 })
