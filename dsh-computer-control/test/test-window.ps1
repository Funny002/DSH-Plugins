#requires -Version 5.1
<#
A disposable WinForms surface used to exercise the computer-control tools
without touching any real application.

It puts a labeled text box, an OK button, and a three-item list box on screen at
a fixed, known position. The OK button writes the text box contents to
`-ResultPath`, and every list selection writes the selected item to
`<ResultPath>.selection`, so a test can drive the window with real mouse and
keyboard input (or UI Automation) and then read the files to prove what actually
arrived.

    powershell.exe -File test-window.ps1 -ResultPath <file> [-Left 260] [-Top 220]

The window closes itself after two minutes so a crashed test cannot leave it
behind forever.
#>
param(
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [int]$Left = 260,
  [int]$Top = 220,
  [switch]$TopMost
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH Computer Control Test'
$form.AccessibleName = 'DSH Computer Control Test'
$form.Width = 600
$form.Height = 430
$form.StartPosition = 'Manual'
$form.Left = $Left
$form.Top = $Top
$form.TopMost = [bool]$TopMost

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Type here, then click OK'
$label.Left = 20
$label.Top = 16
$label.Width = 520
$label.Height = 20
$form.Controls.Add($label)

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'testBox'
$box.AccessibleName = 'testBox'
$box.Left = 20
$box.Top = 40
$box.Width = 540
$box.Height = 28
$form.Controls.Add($box)

$button = New-Object System.Windows.Forms.Button
$button.Name = 'okButton'
$button.AccessibleName = 'OK'
$button.Text = 'OK'
$button.Left = 20
$button.Top = 90
$button.Width = 120
$button.Height = 36
$form.Controls.Add($button)

$list = New-Object System.Windows.Forms.ListBox
$list.Name = 'choiceList'
$list.AccessibleName = 'choiceList'
$list.Left = 160
$list.Top = 90
$list.Width = 160
$list.Height = 82
[void]$list.Items.Add('Alpha')
[void]$list.Items.Add('Beta')
[void]$list.Items.Add('Gamma')
$form.Controls.Add($list)

$status = New-Object System.Windows.Forms.Label
$status.Name = 'statusLabel'
$status.AccessibleName = 'statusLabel'
$status.Text = 'ready'
$status.Left = 20
$status.Top = 190
$status.Width = 540
$status.Height = 20
$form.Controls.Add($status)

$selectionPath = $ResultPath + '.selection'
function Save-Selection {
  if ($null -eq $list.SelectedItem) {
    Set-Content -LiteralPath $selectionPath -Value '' -Encoding UTF8
    return
  }
  Set-Content -LiteralPath $selectionPath -Value ([string]$list.SelectedItem) -Encoding UTF8
}

$button.Add_Click({
  $text = $box.Text
  Set-Content -LiteralPath $ResultPath -Value $text -Encoding UTF8
  Save-Selection
  $status.Text = 'saved ' + $text.Length + ' characters'
})

$list.Add_SelectedIndexChanged({
  Save-Selection
  if ($null -ne $list.SelectedItem) {
    $status.Text = 'selected ' + [string]$list.SelectedItem
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 120000
$timer.Add_Tick({
  $timer.Stop()
  $form.Close()
})
$timer.Start()

[void]$form.ShowDialog()
