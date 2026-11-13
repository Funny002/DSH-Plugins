#requires -Version 5.1
<#
Self-contained end-to-end check: starts the disposable WinForms window, lists its
UI Automation controls, sets text by UIA, invokes OK by UIA, selects a list item,
clicks OK by physical coordinates, captures a region screenshot, and asserts the
files the window wrote. Everything it drives is the window it started, and the
window process is always killed.

    powershell.exe -File e2e-check.ps1
#>
param(
  [string]$PluginRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$WorkDir = (Join-Path $env:TEMP ('dsh-computer-control-e2e-' + [guid]::NewGuid().ToString('N').Substring(0, 8)))
)

$ErrorActionPreference = 'Stop'
$runner = Join-Path $PluginRoot 'lib\computer.ps1'
$testWindow = Join-Path $PSScriptRoot 'test-window.ps1'
$powershell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$resultPath = Join-Path $WorkDir 'result.txt'
$selectionPath = $resultPath + '.selection'
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
  $json = if ($null -eq $payload) { '{}' } else { $payload | ConvertTo-Json -Compress -Depth 10 }
  Set-Content -LiteralPath $payloadPath -Value $json -Encoding UTF8
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
  Check 'starts the disposable test window' ($null -ne $window) ('hwnd=' + [string]$window.hwnd)
  if ($null -eq $window) { throw 'the test window never appeared' }
  $handle = [long]$window.hwnd

  $focus = Invoke-Runner 'focus' @{ hwnd = $handle }
  Check 'focus verifies the test window is foreground' ($focus.foreground -eq $true) ($focus | ConvertTo-Json -Compress)

  $list = Invoke-Runner 'ui' @{ op = 'list'; hwnd = $handle; maxDepth = 6; maxItems = 100 }
  $button = $list.controls | Where-Object { $_.name -eq 'OK' } | Select-Object -First 1
  $edit = $list.controls | Where-Object { $_.name -eq 'testBox' } | Select-Object -First 1
  $choice = $list.controls | Where-Object { $_.name -eq 'choiceList' } | Select-Object -First 1
  Check 'lists the OK button with Invoke' ($null -ne $button -and $button.type -eq 'Button' -and $button.patterns -contains 'Invoke') ($button | ConvertTo-Json -Compress)
  Check 'lists the text box with Value' ($null -ne $edit -and $edit.type -eq 'Edit' -and $edit.patterns -contains 'Value') ($edit | ConvertTo-Json -Compress)
  Check 'lists the list box items' ($null -ne $choice -and @($choice.items).Count -eq 3) ($choice | ConvertTo-Json -Compress)

  $cjk = [string][char]0x4E2D + [char]0x6587
  $emoji = [char]::ConvertFromUtf32(0x1F600)
  $uiaText = 'uia ' + $cjk + ' ' + $emoji
  $setValue = Invoke-Runner 'ui' @{ op = 'setValue'; hwnd = $handle; name = 'testBox'; value = $uiaText }
  Check 'setValue writes and verifies the text box' ($setValue.matched -eq $true -and $setValue.value -eq $uiaText) ($setValue | ConvertTo-Json -Compress)

  $invoked = Invoke-Runner 'ui' @{ op = 'invoke'; hwnd = $handle; name = 'OK' }
  Check 'invoke presses the OK button' ($invoked.ok -eq $true -and $invoked.control.type -eq 'Button') ($invoked.method)
  $saved = Wait-Content $resultPath $uiaText
  Check 'UIA invoke made the window write the text' ($saved -eq $uiaText) ('saved=[' + [string]$saved + ']')

  $secondText = 'coordinate pass'
  Invoke-Runner 'ui' @{ op = 'setValue'; hwnd = $handle; name = 'testBox'; value = $secondText } | Out-Null
  $clickedUi = Invoke-Runner 'ui' @{ op = 'click'; hwnd = $handle; name = 'OK' }
  Check 'ui click reaches the button' ($clickedUi.ok -eq $true) ($clickedUi.method)
  $secondSaved = Wait-Content $resultPath $secondText
  Check 'the button wrote the second text' ($secondSaved -eq $secondText) ('saved=[' + [string]$secondSaved + ']')

  $selected = Invoke-Runner 'ui' @{ op = 'select'; hwnd = $handle; name = 'choiceList'; item = 'Beta' }
  Check 'select chooses the list item' ($selected.selected -eq $true -and $selected.item -eq 'Beta') ($selected | ConvertTo-Json -Compress -Depth 8)
  $selection = Wait-Content $selectionPath 'Beta'
  Check 'the window recorded the selection' ($selection -eq 'Beta') ('selection=[' + [string]$selection + ']')

  $uiaList = Invoke-Runner 'ui' @{ op = 'list'; hwnd = $handle; name = 'OK' }
  $uiaButton = @($uiaList.controls)[0]
  $clickX = [int]($uiaButton.x + [Math]::Floor($uiaButton.width / 2))
  $clickY = [int]($uiaButton.y + [Math]::Floor($uiaButton.height / 2))
  $thirdText = 'coordinate click pass'
  Invoke-Runner 'ui' @{ op = 'setValue'; hwnd = $handle; name = 'testBox'; value = $thirdText } | Out-Null
  # The foreground window is not ours forever; prove focus again before real input.
  $reFocus = Invoke-Runner 'focus' @{ hwnd = $handle }
  Check 'refocus keeps the test window in front' ($reFocus.foreground -eq $true) ($reFocus | ConvertTo-Json -Compress)
  $clicked = Invoke-Runner 'click' @{ x = $clickX; y = $clickY; expect = 'DSH Computer Control Test' }
  Check 'clicks the OK button by physical coordinates' ($clicked.x -eq $clickX -and $clicked.y -eq $clickY) ('clicked=' + $clickX + ',' + $clickY)
  $thirdSaved = Wait-Content $resultPath $thirdText
  Check 'the coordinate click wrote the text' ($thirdSaved -eq $thirdText) ('saved=[' + [string]$thirdSaved + ']')

  $shotPath = Join-Path $WorkDir 'window.png'
  $shot = Invoke-Runner 'screenshot' @{
    path = $shotPath
    region = @{ x = $window.x; y = $window.y; width = $window.width; height = $window.height }
    maxWidth = 800
  }
  Check 'captures the test window region' (
    (Test-Path -LiteralPath $shotPath) -and $shot.originalWidth -eq $window.width -and
    $shot.originalHeight -eq $window.height -and $shot.bytes -gt 0
  ) ($shot | ConvertTo-Json -Compress)

  $fallback = Invoke-Runner 'ui' @{ op = 'click'; hwnd = $handle; name = 'statusLabel' }
  Check 'a patternless control falls back to a coordinate click' ($fallback.method -eq 'coordinate') ($fallback.method)

  $closed = Invoke-Runner 'window-close' @{ hwnd = $handle }
  Check 'closes the test window' ($closed.closed -eq $true) ($closed | ConvertTo-Json -Compress)
  $gone = $true
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 100
    $listing = Invoke-Runner 'windows' $null
    if ($null -ne ($listing.windows | Where-Object { $_.hwnd -eq $handle } | Select-Object -First 1)) { $gone = $false }
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
