#requires -Version 5.1
<#
Computer-control action runner for the dsh-computer-control Host plugin.

Two modes:

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File computer.ps1 `
        -Action <name> -PayloadPath <utf8-json-file>

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File computer.ps1 -Server

One-shot mode performs one action, writes one compact JSON object to stdout, and
exits. Server mode stays warm and speaks JSON Lines on stdin/stdout: it announces
`{"ready":true,...}` once, then answers every `{"id","action","payload"}` line
with `{"id","ok","result"}` or `{"id","ok":false,"error"}`. Diagnostics go to
stderr. The Node half owns tool schemas, argument validation, the screenshot
directory, process supervision, and result rendering; this script owns only the
Windows desktop interaction.

All source here is ASCII so Windows PowerShell 5.1 can read it without a BOM.
#>
param(
  [string]$Action,
  [string]$PayloadPath,
  [switch]$Server
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = $utf8
  [Console]::InputEncoding = $utf8
  $OutputEncoding = $utf8
} catch {
  # Encoding setup is best effort; the default still works for ASCII payloads.
}

$script:NativeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ComputerControlNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x1000;

    public const int SW_MAXIMIZE = 3;
    public const int SW_MINIMIZE = 6;
    public const int SW_RESTORE = 9;

    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint WM_CLOSE = 0x0010;

    public static string DpiMode = "unaware";

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("shcore.dll")]
    public static extern int SetProcessDpiAwareness(int value);

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromPoint(POINT point, uint flags);

    [DllImport("shcore.dll")]
    public static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);

    [DllImport("oleacc.dll")]
    public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out object accessible);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static string EnableDpiAwareness()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) { DpiMode = "per-monitor-v2"; return DpiMode; }
        }
        catch (Exception)
        {
        }
        try
        {
            if (SetProcessDpiAwareness(2) == 0) { DpiMode = "per-monitor"; return DpiMode; }
        }
        catch (Exception)
        {
        }
        try
        {
            if (SetProcessDPIAware()) { DpiMode = "system"; return DpiMode; }
        }
        catch (Exception)
        {
        }
        return DpiMode;
    }

    public static int[] DpiAt(int x, int y)
    {
        try
        {
            POINT point;
            point.X = x;
            point.Y = y;
            IntPtr monitor = MonitorFromPoint(point, 2);
            uint dpiX;
            uint dpiY;
            if (GetDpiForMonitor(monitor, 0, out dpiX, out dpiY) != 0) return new int[] { 0, 0 };
            return new int[] { (int)dpiX, (int)dpiY };
        }
        catch (Exception)
        {
            return new int[] { 0, 0 };
        }
    }

    private static void Send(INPUT[] batch)
    {
        if (batch.Length == 0) return;
        int size = Marshal.SizeOf(typeof(INPUT));
        int offset = 0;
        int stalls = 0;
        while (offset < batch.Length)
        {
            INPUT[] slice;
            if (offset == 0)
            {
                slice = batch;
            }
            else
            {
                slice = new INPUT[batch.Length - offset];
                Array.Copy(batch, offset, slice, 0, slice.Length);
            }
            uint sent = SendInput((uint)slice.Length, slice, size);
            if (sent == 0)
            {
                int error = Marshal.GetLastWin32Error();
                throw new InvalidOperationException(
                    "SendInput inserted 0 of " + slice.Length + " events (Win32 error " + error +
                    "). The target may be elevated, on the secure desktop, or refusing synthetic input.");
            }
            offset += (int)sent;
            if (offset < batch.Length)
            {
                stalls++;
                if (stalls > 8)
                {
                    throw new InvalidOperationException(
                        "SendInput kept accepting only part of a batch (" + offset + " of " + batch.Length + " events).");
                }
                Thread.Sleep(10);
            }
        }
    }

    private static INPUT MouseInput(uint flags, int data)
    {
        INPUT item = new INPUT();
        item.type = INPUT_MOUSE;
        item.u.mi.dwFlags = flags;
        item.u.mi.mouseData = (uint)data;
        return item;
    }

    private static INPUT KeyInput(ushort virtualKey, ushort scanCode, uint flags)
    {
        INPUT item = new INPUT();
        item.type = INPUT_KEYBOARD;
        item.u.ki.wVk = virtualKey;
        item.u.ki.wScan = scanCode;
        item.u.ki.dwFlags = flags;
        return item;
    }

    private static void ReleaseKeys(int[] virtualKeys)
    {
        try
        {
            List<INPUT> batch = new List<INPUT>();
            for (int i = virtualKeys.Length - 1; i >= 0; i--)
            {
                batch.Add(KeyInput((ushort)virtualKeys[i], 0, KEYEVENTF_KEYUP));
            }
            Send(batch.ToArray());
        }
        catch (Exception)
        {
            // Releasing keys is best effort; preserve the original failure.
        }
    }

    public static void Move(int x, int y)
    {
        if (!SetCursorPos(x, y))
        {
            throw new InvalidOperationException("SetCursorPos(" + x + ", " + y + ") failed (Win32 error " + Marshal.GetLastWin32Error() + ")");
        }
    }

    public static int[] Cursor()
    {
        POINT point;
        if (!GetCursorPos(out point))
        {
            throw new InvalidOperationException("GetCursorPos failed (Win32 error " + Marshal.GetLastWin32Error() + ")");
        }
        return new int[] { point.X, point.Y };
    }

    public static void Click(int x, int y, string button, int count)
    {
        Move(x, y);
        Thread.Sleep(25);
        uint down;
        uint up;
        string name = (button == null ? "left" : button).ToLowerInvariant();
        if (name == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        else if (name == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
        else { down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; }
        for (int i = 0; i < count; i++)
        {
            Send(new INPUT[] { MouseInput(down, 0), MouseInput(up, 0) });
            if (i < count - 1) Thread.Sleep(60);
        }
    }

    public static void Scroll(int x, int y, int amount, bool horizontal)
    {
        Move(x, y);
        Thread.Sleep(20);
        int delta = amount * 120;
        Send(new INPUT[] { MouseInput(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, delta) });
    }

    public static void Drag(int x1, int y1, int x2, int y2, string button, int durationMs)
    {
        string name = (button == null ? "left" : button).ToLowerInvariant();
        uint down;
        uint up;
        if (name == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        else if (name == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
        else { down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; }

        int steps = Math.Max(4, Math.Min(60, durationMs / 20));
        Move(x1, y1);
        Thread.Sleep(40);
        Send(new INPUT[] { MouseInput(down, 0) });
        try
        {
            for (int i = 1; i <= steps; i++)
            {
                double t = (double)i / steps;
                int x = (int)Math.Round(x1 + (x2 - x1) * t);
                int y = (int)Math.Round(y1 + (y2 - y1) * t);
                SetCursorPos(x, y);
                Thread.Sleep(Math.Max(5, durationMs / steps));
            }
        }
        finally
        {
            Send(new INPUT[] { MouseInput(up, 0) });
        }
    }

    public static int TapChord(int[] virtualKeys, int repeat)
    {
        if (virtualKeys == null || virtualKeys.Length == 0)
        {
            throw new InvalidOperationException("the key chord is empty");
        }
        int events = 0;
        for (int r = 0; r < repeat; r++)
        {
            List<INPUT> batch = new List<INPUT>();
            for (int i = 0; i < virtualKeys.Length; i++) batch.Add(KeyInput((ushort)virtualKeys[i], 0, 0));
            for (int i = virtualKeys.Length - 1; i >= 0; i--) batch.Add(KeyInput((ushort)virtualKeys[i], 0, KEYEVENTF_KEYUP));
            try
            {
                Send(batch.ToArray());
                events += batch.Count;
            }
            catch (Exception)
            {
                ReleaseKeys(virtualKeys);
                throw;
            }
            if (r < repeat - 1) Thread.Sleep(60);
        }
        return events;
    }

    private static void AddUnicode(List<INPUT> batch, char value)
    {
        batch.Add(KeyInput(0, (ushort)value, KEYEVENTF_UNICODE));
        batch.Add(KeyInput(0, (ushort)value, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }

    private static void FlushTyped(List<INPUT> batch)
    {
        if (batch.Count == 0) return;
        Send(batch.ToArray());
        batch.Clear();
        Thread.Sleep(4);
    }

    public static int TypeText(string text)
    {
        if (text == null) return 0;
        int units = 0;
        List<INPUT> batch = new List<INPUT>();
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (c == '\r') continue;
            if (c == '\n')
            {
                FlushTyped(batch);
                TapChord(new int[] { 0x0D }, 1);
                Thread.Sleep(15);
                continue;
            }
            AddUnicode(batch, c);
            units++;
            if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
            {
                AddUnicode(batch, text[i + 1]);
                units++;
                i++;
            }
            if (batch.Count >= 64) FlushTyped(batch);
        }
        FlushTyped(batch);
        return units;
    }

    public static string[] ListWindows()
    {
        List<string> rows = new List<string>();
        IntPtr foreground = GetForegroundWindow();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            int length = GetWindowTextLengthW(hWnd);
            if (length <= 0) return true;
            StringBuilder buffer = new StringBuilder(length + 2);
            GetWindowTextW(hWnd, buffer, buffer.Capacity);
            string title = buffer.ToString();
            if (title.Trim().Length == 0) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            RECT rect;
            GetWindowRect(hWnd, out rect);
            string process = "";
            try { process = Process.GetProcessById((int)pid).ProcessName; }
            catch (Exception) { }
            rows.Add(string.Format(
                "{0}\t{1}\t{2}\t{3}\t{4}\t{5}\t{6}\t{7}\t{8}\t{9}",
                hWnd.ToInt64(),
                pid,
                hWnd == foreground ? 1 : 0,
                rect.Left,
                rect.Top,
                rect.Right - rect.Left,
                rect.Bottom - rect.Top,
                IsIconic(hWnd) ? 1 : 0,
                process,
                title.Replace("\t", " ").Replace("\r", " ").Replace("\n", " ")));
            return true;
        }, IntPtr.Zero);
        return rows.ToArray();
    }

    public static bool WindowBelongsToPid(long handle, int pid)
    {
        IntPtr hWnd = new IntPtr(handle);
        uint topPid;
        GetWindowThreadProcessId(hWnd, out topPid);
        if (topPid == (uint)pid) return true;
        bool found = false;
        EnumChildWindows(hWnd, delegate(IntPtr child, IntPtr lParam)
        {
            uint childPid;
            GetWindowThreadProcessId(child, out childPid);
            if (childPid == (uint)pid)
            {
                found = true;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool Activate(long handle)
    {
        IntPtr hWnd = new IntPtr(handle);
        if (!IsWindowVisible(hWnd)) return false;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            if (IsIconic(hWnd))
            {
                ShowWindow(hWnd, SW_RESTORE);
                Thread.Sleep(100);
            }
            if (GetForegroundWindow() == hWnd) return true;

            IntPtr foreground = GetForegroundWindow();
            uint foregroundPid;
            uint foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
            uint targetPid;
            uint targetThread = GetWindowThreadProcessId(hWnd, out targetPid);
            bool attached = false;
            try
            {
                if (foregroundThread != 0 && targetThread != 0 && foregroundThread != targetThread)
                {
                    attached = AttachThreadInput(foregroundThread, targetThread, true);
                }
            }
            catch (Exception)
            {
            }
            BringWindowToTop(hWnd);
            bool activated = SetForegroundWindow(hWnd);
            try
            {
                SetActiveWindow(hWnd);
                SetFocus(hWnd);
            }
            catch (Exception)
            {
            }
            if (attached)
            {
                try { AttachThreadInput(foregroundThread, targetThread, false); }
                catch (Exception) { }
            }
            if (!activated)
            {
                // The foreground lock can still refuse SetForegroundWindow; this
                // is the shell's own activation path and needs no injected keys.
                try { SwitchToThisWindow(hWnd, true); }
                catch (Exception) { }
            }
            Thread.Sleep(120);
            if (GetForegroundWindow() == hWnd) return true;
            Thread.Sleep(80);
        }
        return GetForegroundWindow() == hWnd;
    }

    public static bool ShowWindowEx(long handle, int command)
    {
        return ShowWindow(new IntPtr(handle), command);
    }

    public static bool MoveWindowTo(long handle, int x, int y, int width, int height)
    {
        return SetWindowPos(new IntPtr(handle), IntPtr.Zero, x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
    }

    public static bool CloseWindow(long handle)
    {
        return PostMessageW(new IntPtr(handle), WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }

    public static int[] WindowRect(long handle)
    {
        RECT rect;
        if (!GetWindowRect(new IntPtr(handle), out rect))
        {
            return new int[] { 0, 0, 0, 0 };
        }
        return new int[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
    }

    public static bool IsWindowMinimized(long handle)
    {
        return IsIconic(new IntPtr(handle));
    }

    public static bool IsWindowMaximized(long handle)
    {
        return IsZoomed(new IntPtr(handle));
    }

    public static object GetAccessible(long handle)
    {
        if (handle == 0) return null;
        Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
        object accessible = null;
        int hr = AccessibleObjectFromWindow(new IntPtr(handle), 0xFFFFFFFC, ref iid, out accessible);
        if (hr != 0 || accessible == null)
        {
            throw new InvalidOperationException("AccessibleObjectFromWindow failed (HRESULT 0x" + hr.ToString("X8") + ")");
        }
        return accessible;
    }
}
'@

$script:NativeReady = $false
$script:DpiMode = 'unaware'
$script:UiLoaded = $false

function Get-Native {
  if ($script:NativeReady) { return }
  if (-not ('ComputerControlNative' -as [type])) {
    $cacheDir = Join-Path $env:LOCALAPPDATA 'dsh-computer-control'
    if (-not (Test-Path -LiteralPath $cacheDir)) {
      New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($script:NativeSource)
      $hash = ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').Substring(0, 12).ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
    $dll = Join-Path $cacheDir ("ComputerControlNative-$hash.dll")
    if (-not (Test-Path -LiteralPath $dll)) {
      try {
        Add-Type -TypeDefinition $script:NativeSource -OutputAssembly $dll
      } catch {
        # A locked or unwritable cache must not disable the plugin: compile in memory.
        Add-Type -TypeDefinition $script:NativeSource
      }
      Get-ChildItem -LiteralPath $cacheDir -Filter 'ComputerControlNative-*.dll' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -ne $dll } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    }
    if (-not ('ComputerControlNative' -as [type])) {
      Add-Type -Path $dll
    }
  }
  $script:DpiMode = [ComputerControlNative]::EnableDpiAwareness()
  $script:NativeReady = $true
}

function Get-ErrorMessage($record) {
  if ($null -eq $record) { return 'unknown error' }
  $exception = $record
  if ($record -is [System.Management.Automation.ErrorRecord]) { $exception = $record.Exception }
  if ($null -eq $exception) { return ([string]$record).Trim() }
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  $message = [string]$exception.Message
  if ([string]::IsNullOrWhiteSpace($message)) { $message = [string]$record }
  $message = ($message -replace '\s*\r?\n\s*', ' ').Trim()
  if ($message.Length -gt 2000) { $message = $message.Substring(0, 2000) + '...' }
  return $message
}

function Write-ErrorLine([string]$message) {
  [Console]::Error.WriteLine('COMPUTER_CONTROL_ERROR: ' + (($message -replace '\s*\r?\n\s*', ' ').Trim()))
}

function Read-Payload([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return [pscustomobject]@{} }
  if (-not (Test-Path -LiteralPath $path)) { return [pscustomobject]@{} }
  $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) { return [pscustomobject]@{} }
  return ($raw | ConvertFrom-Json)
}

function Limit-Text([string]$text, [int]$maxLength = 160) {
  if ($null -eq $text) { return '' }
  $clean = ($text -replace '\s+', ' ').Trim()
  if ($clean.Length -le $maxLength) { return $clean }
  return $clean.Substring(0, $maxLength) + '...'
}

function Get-WindowRows {
  $rows = @()
  foreach ($row in [ComputerControlNative]::ListWindows()) {
    $fields = $row.Split("`t")
    if ($fields.Count -lt 10) { continue }
    $rows += [pscustomobject]@{
      hwnd      = [long]$fields[0]
      pid       = [int]$fields[1]
      focused   = ($fields[2] -eq '1')
      x         = [int]$fields[3]
      y         = [int]$fields[4]
      width     = [int]$fields[5]
      height    = [int]$fields[6]
      minimized = ($fields[7] -eq '1')
      process   = $fields[8]
      title     = $fields[9]
    }
  }
  return $rows
}

function Get-ForegroundInfo {
  $handle = [ComputerControlNative]::GetForegroundWindow()
  $processId = [uint32]0
  [void][ComputerControlNative]::GetWindowThreadProcessId($handle, [ref]$processId)
  $length = [ComputerControlNative]::GetWindowTextLengthW($handle)
  $buffer = New-Object System.Text.StringBuilder ($length + 2)
  [void][ComputerControlNative]::GetWindowTextW($handle, $buffer, $buffer.Capacity)
  $process = ''
  try { $process = (Get-Process -Id ([int]$processId) -ErrorAction Stop).ProcessName } catch { }
  return [pscustomobject]@{
    hwnd    = $handle.ToInt64()
    pid     = [int]$processId
    process = $process
    title   = $buffer.ToString()
  }
}

function Assert-Foreground($expect) {
  $front = Get-ForegroundInfo
  if ($null -eq $expect -or "$expect".Trim() -eq '') { return $front }
  $wanted = "$expect".Trim()
  $matched = $false
  $kind = 'title'
  if ($wanted -match '^pid:(\d+)$') {
    $kind = 'pid'
    $matched = ($front.pid -eq [int]$Matches[1])
  } elseif ($wanted -match '^hwnd:(\d+)$') {
    $kind = 'hwnd'
    $matched = ($front.hwnd -eq [long]$Matches[1])
  } elseif ($wanted -match '^\d+$') {
    $kind = 'hwnd'
    $matched = ($front.hwnd -eq [long]$wanted)
  } else {
    $matched = $front.title.IndexOf($wanted, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  }
  if (-not $matched) {
    throw ("refusing to send input: the foreground window is [" + $front.title + "] (hwnd " + $front.hwnd +
      ", pid " + $front.pid + ", process " + $front.process + "), which does not match expect=" + $wanted +
      " (" + $kind + "). Focus the target window first with computer_window focus.")
  }
  return $front
}

function Test-PidRelated([int]$first, [int]$second) {
  if ($first -eq $second) { return $true }
  $parents = @{}
  try {
    Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop |
      ForEach-Object { $parents[[int]$_.ProcessId] = [int]$_.ParentProcessId }
  } catch {
    return $false
  }
  foreach ($start in @($second, $first)) {
    $current = $start
    $seen = @{}
    for ($i = 0; $i -lt 12; $i++) {
      if ($current -eq $first -and $start -eq $second) { return $true }
      if ($current -eq $second -and $start -eq $first) { return $true }
      if (-not $parents.ContainsKey($current)) { break }
      $next = [int]$parents[$current]
      if ($next -eq 0 -or $seen.ContainsKey($next)) { break }
      $seen[$next] = $true
      $current = $next
    }
  }
  return $false
}

function Resolve-WindowTarget($payload, [switch]$Unique) {
  $rows = @(Get-WindowRows)
  $matches = @()
  $selector = ''
  if ($null -ne $payload.hwnd -and "$($payload.hwnd)" -ne '') {
    $selector = 'hwnd'
    $wanted = [long]$payload.hwnd
    $matches = @($rows | Where-Object { $_.hwnd -eq $wanted })
  } elseif ($null -ne $payload.title -and "$($payload.title)" -ne '') {
    $selector = 'title'
    $wanted = "$($payload.title)"
    $matches = @($rows | Where-Object { $_.title -eq $wanted })
    if ($matches.Count -eq 0) {
      $matches = @($rows | Where-Object { $_.title.IndexOf($wanted, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
    }
  } elseif ($null -ne $payload.pid -and "$($payload.pid)" -ne '') {
    $selector = 'pid'
    $wantedPid = [int]$payload.pid
    $matches = @($rows | Where-Object { $_.pid -eq $wantedPid })
    if ($matches.Count -eq 0) {
      # Windows Store apps host their top-level window in ApplicationFrameHost.exe,
      # so the launcher pid differs from the window pid. Check hosted child windows
      # first, then the process ancestry chain.
      $matches = @($rows | Where-Object { [ComputerControlNative]::WindowBelongsToPid($_.hwnd, $wantedPid) })
    }
    if ($matches.Count -eq 0) {
      $matches = @($rows | Where-Object { Test-PidRelated $wantedPid $_.pid })
    }
  } else {
    throw "the window selector needs 'hwnd', 'title', or 'pid'"
  }
  if ($matches.Count -eq 0) {
    throw "no visible window matched the requested $selector selector"
  }
  if ($Unique -and $matches.Count -gt 1 -and $selector -ne 'hwnd') {
    $handles = ($matches | Select-Object -First 6 | ForEach-Object { "$($_.hwnd) [$($_.title)]" }) -join ', '
    throw "the $selector selector is ambiguous ($($matches.Count) windows: $handles); pass hwnd to choose one"
  }
  return $matches[0]
}

function Get-ScreenInfo {
  Add-Type -AssemblyName System.Windows.Forms
  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $screens = @()
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $dpi = [ComputerControlNative]::DpiAt($screen.Bounds.X + 10, $screen.Bounds.Y + 10)
    $effective = 96
    if ($dpi[0] -gt 0) { $effective = $dpi[0] }
    $work = $screen.WorkingArea
    $screens += [pscustomobject]@{
      name        = $screen.DeviceName
      primary     = [bool]$screen.Primary
      x           = $screen.Bounds.X
      y           = $screen.Bounds.Y
      width       = $screen.Bounds.Width
      height      = $screen.Bounds.Height
      dpi         = $effective
      scale       = [Math]::Round($effective / 96.0, 2)
      workArea    = [pscustomobject]@{ x = $work.X; y = $work.Y; width = $work.Width; height = $work.Height }
    }
  }
  $cursor = [ComputerControlNative]::Cursor()
  return [pscustomobject]@{
    virtualScreen = [pscustomobject]@{ x = $virtual.X; y = $virtual.Y; width = $virtual.Width; height = $virtual.Height }
    screens       = $screens
    cursor        = [pscustomobject]@{ x = $cursor[0]; y = $cursor[1] }
    foreground    = [ComputerControlNative]::GetForegroundWindow().ToInt64()
    dpiAwareness  = [ComputerControlNative]::DpiMode
    os            = [System.Environment]::OSVersion.VersionString
  }
}

function Get-TargetRectangle($payload) {
  Add-Type -AssemblyName System.Windows.Forms
  if ($null -ne $payload.region) {
    $region = $payload.region
    return New-Object System.Drawing.Rectangle ([int]$region.x), ([int]$region.y), ([int]$region.width), ([int]$region.height)
  }
  if ($payload.all -eq $true) {
    $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
    return New-Object System.Drawing.Rectangle $virtual.X, $virtual.Y, $virtual.Width, $virtual.Height
  }
  if ($null -ne $payload.screen -and "$($payload.screen)" -ne '') {
    $screens = [System.Windows.Forms.Screen]::AllScreens
    $index = [int]$payload.screen - 1
    if ($index -lt 0 -or $index -ge $screens.Length) {
      throw "screen index '$($payload.screen)' is out of range (1..$($screens.Length))"
    }
    $bounds = $screens[$index].Bounds
    return New-Object System.Drawing.Rectangle $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height
  }
  $primary = $null
  foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    if ($screen.Primary) { $primary = $screen; break }
  }
  if ($null -eq $primary) { $primary = [System.Windows.Forms.Screen]::AllScreens[0] }
  $bounds = $primary.Bounds
  return New-Object System.Drawing.Rectangle $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height
}

function Save-Screenshot($payload) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $path = [string]$payload.path
  if ([string]::IsNullOrWhiteSpace($path)) { throw 'screenshot requires a destination path' }
  $parent = Split-Path -Parent $path
  if (-not [string]::IsNullOrEmpty($parent)) {
    if (-not (Test-Path -LiteralPath $parent)) {
      try {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
      } catch {
        throw "cannot create the screenshot directory '$parent': $(Get-ErrorMessage $_)"
      }
    }
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
      throw "cannot create the screenshot directory '$parent': the path is not a usable directory"
    }
  }

  $target = Get-TargetRectangle $payload
  if ($target.Width -le 0 -or $target.Height -le 0) {
    throw "capture region has no area ($($target.Width)x$($target.Height))"
  }

  $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $virtualRectangle = New-Object System.Drawing.Rectangle $virtual.X, $virtual.Y, $virtual.Width, $virtual.Height
  $intersected = [System.Drawing.Rectangle]::Intersect($target, $virtualRectangle)
  if ($intersected.Width -le 0 -or $intersected.Height -le 0) {
    throw ("capture region $($target.X),$($target.Y) $($target.Width)x$($target.Height) is outside the " +
      "virtual desktop $($virtual.X),$($virtual.Y) $($virtual.Width)x$($virtual.Height)")
  }
  $clamped = ($intersected.X -ne $target.X -or $intersected.Y -ne $target.Y -or
    $intersected.Width -ne $target.Width -or $intersected.Height -ne $target.Height)
  $target = $intersected

  $bitmap = New-Object System.Drawing.Bitmap $target.Width, $target.Height
  $output = $null
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($target.X, $target.Y, 0, 0, $target.Size)
    } finally {
      $graphics.Dispose()
    }

    $maxWidth = 0
    if ($null -ne $payload.maxWidth) { $maxWidth = [int]$payload.maxWidth }
    $output = $bitmap
    $newWidth = $bitmap.Width
    $newHeight = $bitmap.Height
    $resized = $false
    if ($maxWidth -gt 0 -and $bitmap.Width -gt $maxWidth) {
      $ratio = [double]$maxWidth / [double]$bitmap.Width
      $newWidth = $maxWidth
      $newHeight = [int][Math]::Max(1, [Math]::Round($bitmap.Height * $ratio))
      $scaled = New-Object System.Drawing.Bitmap $newWidth, $newHeight
      $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
      try {
        $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $scaledGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $scaledGraphics.DrawImage($bitmap, 0, 0, $newWidth, $newHeight)
      } finally {
        $scaledGraphics.Dispose()
      }
      $output = $scaled
      $resized = $true
    }

    try {
      $output.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    } catch {
      throw "cannot write the screenshot to '$path': $(Get-ErrorMessage $_)"
    } finally {
      if ($resized) { $output.Dispose() }
    }

    $cursor = [ComputerControlNative]::Cursor()
    return [pscustomobject]@{
      path           = $path
      width          = $newWidth
      height         = $newHeight
      originalWidth  = $target.Width
      originalHeight = $target.Height
      left           = $target.X
      top            = $target.Y
      clamped        = [bool]$clamped
      cursorX        = $cursor[0]
      cursorY        = $cursor[1]
      bytes          = (Get-Item -LiteralPath $path).Length
    }
  } finally {
    $bitmap.Dispose()
  }
}

function Resolve-Chord([string]$sequence) {
  if ([string]::IsNullOrWhiteSpace($sequence)) { throw "key requires a non-empty 'keys' chord" }

  $names = @{
    'ctrl' = 0x11; 'control' = 0x11; 'shift' = 0x10; 'alt' = 0x12
    'win' = 0x5B; 'lwin' = 0x5B; 'rwin' = 0x5C; 'meta' = 0x5B
    'apps' = 0x5D; 'menu' = 0x5D
    'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B
    'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D
    'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22
    'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
    'capslock' = 0x14; 'numlock' = 0x90; 'scrolllock' = 0x91
    'printscreen' = 0x2C; 'pause' = 0x13
    'plus' = 0xBB; 'equal' = 0xBB; 'minus' = 0xBD; 'comma' = 0xBC; 'period' = 0xBE
    'semicolon' = 0xBA; 'slash' = 0xBF; 'backslash' = 0xDC; 'quote' = 0xDE
    'lbracket' = 0xDB; 'rbracket' = 0xDD; 'backtick' = 0xC0
    'multiply' = 0x6A; 'add' = 0x6B; 'subtract' = 0x6D; 'decimal' = 0x6E; 'divide' = 0x6F
  }
  for ($i = 1; $i -le 24; $i++) { $names["f$i"] = 0x70 + ($i - 1) }
  for ($i = 0; $i -le 9; $i++) { $names["numpad$i"] = 0x60 + $i }

  $symbols = @{
    '+' = 0xBB; '=' = 0xBB; '-' = 0xBD; ',' = 0xBC; '.' = 0xBE; ';' = 0xBA
    '/' = 0xBF; '\' = 0xDC; '`' = 0xC0; '[' = 0xDB; ']' = 0xDD; "'" = 0xDE
  }

  $tokens = @()
  $current = ''
  foreach ($character in $sequence.ToCharArray()) {
    if ($character -eq '+') {
      if ($current -ne '') {
        $tokens += $current
        $current = ''
      } else {
        $current = '+'
      }
    } else {
      $current += $character
    }
  }
  if ($current -ne '') { $tokens += $current }
  if ($tokens.Count -eq 0) { throw "key chord '$sequence' is empty" }

  $resolved = @()
  $hasShift = $false
  foreach ($token in $tokens) {
    $name = $token.Trim().ToLowerInvariant()
    if ($name -eq '') { continue }
    if ($names.ContainsKey($name)) {
      $virtualKey = [int]$names[$name]
      if ($virtualKey -eq 0x10) { $hasShift = $true }
      $resolved += $virtualKey
    } elseif ($symbols.ContainsKey($name)) {
      $resolved += [int]$symbols[$name]
    } elseif ($name.Length -eq 1) {
      $upper = $name.ToUpperInvariant()
      if (($upper -ge 'A' -and $upper -le 'Z') -or ($upper -ge '0' -and $upper -le '9')) {
        $resolved += [int][char]$upper
      } else {
        throw "unknown key name '$name' in chord '$sequence'"
      }
    } else {
      throw "unknown key name '$name' in chord '$sequence'"
    }
  }

  if ($resolved -contains 0xBB -and -not $hasShift) {
    # A literal '+' is a shifted '=' on a US layout; without Shift the chord
    # would press '='. Insert Shift once so `ctrl++` means Ctrl+Plus.
    $shiftIndex = [Array]::IndexOf($resolved, 0xBB)
    $withShift = @()
    for ($i = 0; $i -lt $resolved.Count; $i++) {
      if ($i -eq $shiftIndex) { $withShift += 0x10 }
      $withShift += $resolved[$i]
    }
    $resolved = $withShift
  }

  if ($resolved.Count -eq 0) { throw "key chord '$sequence' resolved to no keys" }
  return ,$resolved
}

function Invoke-KeyboardAction([string]$operation, $payload) {
  $front = Assert-Foreground $payload.expect
  $repeat = 1
  if ($null -ne $payload.repeat) {
    $repeat = [int]$payload.repeat
    if ($repeat -lt 1) { $repeat = 1 }
    if ($repeat -gt 20) { $repeat = 20 }
  }

  if ($operation -eq 'type') {
    if ($null -eq $payload.text) { throw "type requires a 'text' string" }
    $text = [string]$payload.text
    $typed = [ComputerControlNative]::TypeText($text)
    if ($payload.submit -eq $true) {
      Start-Sleep -Milliseconds 60
      [void][ComputerControlNative]::TapChord(@(0x0D), 1)
    }
    # The next tool call usually follows immediately in server mode; give the
    # foreground thread time to drain WM_CHAR before a click can read the field.
    Start-Sleep -Milliseconds 120
    return [pscustomobject]@{
      typed  = [int]$typed
      units  = [int]$text.Length
      submit = [bool]($payload.submit -eq $true)
      window = $front.title
      hwnd   = $front.hwnd
      pid    = $front.pid
    }
  }

  $sequence = [string]$payload.keys
  $resolved = Resolve-Chord $sequence
  $events = [ComputerControlNative]::TapChord([int[]]$resolved, $repeat)
  Start-Sleep -Milliseconds 80
  return [pscustomobject]@{
    keys    = $sequence
    pressed = $resolved.Count
    repeat  = $repeat
    events  = [int]$events
    window  = $front.title
    hwnd    = $front.hwnd
  }
}

function Initialize-Ui {
  if ($script:UiLoaded) { return }
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $script:UiLoaded = $true
  } catch {
    throw "Windows UI Automation is unavailable: $(Get-ErrorMessage $_)"
  }
}

$script:MsaaRoles = @{
  9 = 'Window'; 10 = 'Pane'; 11 = 'Menu'; 12 = 'MenuItem'; 13 = 'ToolTip'; 14 = 'Application'
  15 = 'Document'; 16 = 'Pane'; 17 = 'Group'; 20 = 'Separator'; 21 = 'ToolBar'; 23 = 'StatusBar'
  24 = 'Table'; 25 = 'Header'; 26 = 'Header'; 27 = 'HeaderItem'; 28 = 'DataItem'; 29 = 'DataItem'
  30 = 'Hyperlink'; 32 = 'Text'; 33 = 'List'; 34 = 'ListItem'; 35 = 'Tree'; 36 = 'TreeItem'
  37 = 'Tab'; 38 = 'TabItem'; 39 = 'Indicator'; 40 = 'Image'; 41 = 'Text'; 42 = 'Edit'
  43 = 'Button'; 44 = 'CheckBox'; 45 = 'RadioButton'; 46 = 'ComboBox'; 47 = 'ComboBox'
  48 = 'ProgressBar'; 51 = 'Slider'; 52 = 'Spinner'; 56 = 'SplitButton'; 57 = 'MenuButton'
  60 = 'Tab'; 62 = 'SplitButton'; 64 = 'Button'
}

$script:MsaaPatterns = @{
  12 = @('Invoke'); 15 = @('Text'); 24 = @('Selection'); 30 = @('Invoke')
  33 = @('Selection'); 34 = @('SelectionItem'); 35 = @('Selection'); 36 = @('SelectionItem')
  37 = @('Selection'); 38 = @('SelectionItem'); 42 = @('Value'); 43 = @('Invoke')
  44 = @('Toggle'); 45 = @('SelectionItem'); 46 = @('Value', 'ExpandCollapse')
  48 = @('RangeValue'); 51 = @('RangeValue'); 56 = @('Invoke'); 57 = @('Invoke')
  60 = @('Selection'); 62 = @('Invoke'); 64 = @('Invoke')
}

function Get-Msaa([long]$handle) {
  if ($handle -eq 0) { return $null }
  try {
    $accessible = [ComputerControlNative]::GetAccessible($handle)
    if ($null -eq $accessible) { return $null }
    # A bare COM object returned from a function is unrolled by the pipeline, so
    # carry it inside a wrapper object.
    return [pscustomobject]@{ accessible = $accessible }
  } catch {
    return $null
  }
}

function Get-MsaaInfo($accessible) {
  $role = -1
  $name = ''
  $defaultAction = ''
  $childCount = 0
  try { $role = [int]$accessible.accRole(0) } catch { }
  try { $name = [string]$accessible.accName(0) } catch { }
  try { $defaultAction = [string]$accessible.accDefaultAction(0) } catch { }
  try { $childCount = [int]$accessible.accChildCount } catch { }
  $type = 'Pane'
  if ($script:MsaaRoles.ContainsKey($role)) { $type = [string]$script:MsaaRoles[$role] }
  $patterns = @()
  if ($script:MsaaPatterns.ContainsKey($role)) { $patterns = @($script:MsaaPatterns[$role]) }
  return [pscustomobject]@{
    role          = $role
    type          = $type
    name          = $name
    defaultAction = $defaultAction
    childCount    = $childCount
    patterns      = $patterns
  }
}

function Get-MsaaItems($accessible, [int]$limit = 50) {
  $items = @()
  $count = 0
  try { $count = [int]$accessible.accChildCount } catch { return $items }
  $maximum = [Math]::Min($count, $limit)
  for ($childId = 1; $childId -le $maximum; $childId++) {
    try {
      $name = [string]$accessible.accName($childId)
      $role = [int]$accessible.accRole($childId)
      $state = [int]$accessible.accState($childId)
      $items += [pscustomobject]@{
        childId = $childId
        name    = Limit-Text $name
        role    = $role
        selected = (($state -band 2) -ne 0)
        focused  = (($state -band 4) -ne 0)
        enabled  = (($state -band 1) -eq 0)
      }
    } catch {
      continue
    }
  }
  return $items
}

function Convert-Pixel([double]$value) {
  if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { return 0 }
  if ($value -gt 100000) { return 100000 }
  if ($value -lt -100000) { return -100000 }
  return [int][Math]::Round($value)
}

function Get-UiElementSummary($element) {
  $current = $element.Current
  $patterns = New-Object System.Collections.Generic.List[string]
  try {
    foreach ($pattern in $element.GetSupportedPatterns()) {
      $name = $pattern.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', ''
      if (-not $patterns.Contains($name)) { $patterns.Add($name) }
    }
  } catch {
  }

  $type = $current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  $name = [string]$current.Name
  $automationId = [string]$current.AutomationId
  $handle = [long]$current.NativeWindowHandle
  $rect = $current.BoundingRectangle

  $accessible = $null
  $msaa = $null
  if ($handle -ne 0 -and $patterns.Count -eq 0) {
    $holder = Get-Msaa $handle
    if ($null -ne $holder) {
      $accessible = $holder.accessible
      $msaa = Get-MsaaInfo $accessible
    }
  }
  if ($null -ne $msaa) {
    if (-not [string]::IsNullOrWhiteSpace($msaa.name) -and ($patterns.Count -eq 0 -or $type -eq 'Pane')) {
      $name = $msaa.name
    }
    if ($patterns.Count -eq 0 -or $type -eq 'Pane') { $type = $msaa.type }
    foreach ($pattern in $msaa.patterns) {
      if (-not $patterns.Contains($pattern)) { $patterns.Add($pattern) }
    }
  }

  $summary = [pscustomobject]@{
    type         = $type
    name         = Limit-Text $name
    automationId = Limit-Text $automationId 60
    className    = Limit-Text ([string]$current.ClassName) 80
    handle       = $handle
    pid          = [int]$current.ProcessId
    x            = Convert-Pixel $rect.X
    y            = Convert-Pixel $rect.Y
    width        = Convert-Pixel $rect.Width
    height       = Convert-Pixel $rect.Height
    enabled      = [bool]$current.IsEnabled
    offscreen    = [bool]$current.IsOffscreen
    focusable    = [bool]$current.IsKeyboardFocusable
    focused      = [bool]$current.HasKeyboardFocus
    password     = [bool]$current.IsPassword
    patterns     = @($patterns.ToArray())
  }

  if ($null -ne $accessible -and $null -ne $msaa -and $msaa.childCount -gt 0) {
    if (@(33, 35, 46, 47, 24, 60) -contains $msaa.role) {
      $items = @(Get-MsaaItems $accessible)
      if ($items.Count -gt 0) {
        $summary | Add-Member -NotePropertyName items -NotePropertyValue $items
      }
      $summary | Add-Member -NotePropertyName defaultAction -NotePropertyValue (Limit-Text $msaa.defaultAction 60)
    }
  }
  if ($null -ne $accessible -and $null -ne $msaa -and -not $summary.password) {
    if (@(42, 46, 47) -contains $msaa.role) {
      try {
        $summary | Add-Member -NotePropertyName value -NotePropertyValue (Limit-Text ([string]$accessible.accValue(0)) 200)
      } catch {
      }
    }
  }
  return $summary
}

function Get-UiTree($root, [int]$maxDepth, [int]$maxItems) {
  $items = New-Object System.Collections.Generic.List[object]
  $queue = New-Object System.Collections.Generic.Queue[object]
  $queue.Enqueue([pscustomobject]@{ element = $root; depth = 0 })
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $truncated = $false
  while ($queue.Count -gt 0) {
    if ($items.Count -ge $maxItems) {
      $truncated = $true
      break
    }
    $node = $queue.Dequeue()
    if ($node.depth -gt 0) {
      try {
        $summary = Get-UiElementSummary $node.element
        $items.Add([pscustomobject]@{ element = $node.element; summary = $summary; depth = $node.depth })
      } catch {
        # An element that disappears during enumeration is simply skipped.
      }
    }
    if ($node.depth -ge $maxDepth) { continue }
    $child = $null
    try { $child = $walker.GetFirstChild($node.element) } catch { $child = $null }
    while ($null -ne $child) {
      $queue.Enqueue([pscustomobject]@{ element = $child; depth = $node.depth + 1 })
      try { $child = $walker.GetNextSibling($child) } catch { $child = $null }
    }
  }
  if ($queue.Count -gt 0) { $truncated = $true }
  return [pscustomobject]@{ items = $items.ToArray(); truncated = $truncated }
}

function Filter-UiItems($items, $payload) {
  $filtered = @($items)
  if ($null -ne $payload.name -and "$($payload.name)" -ne '') {
    $needle = "$($payload.name)"
    $filtered = @($filtered | Where-Object { $_.summary.name.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
    $exact = @($filtered | Where-Object { $_.summary.name.Equals($needle, [System.StringComparison]::OrdinalIgnoreCase) })
    if ($exact.Count -gt 0) { $filtered = $exact }
  }
  if ($null -ne $payload.automationId -and "$($payload.automationId)" -ne '') {
    $needle = "$($payload.automationId)"
    $filtered = @($filtered | Where-Object { $_.summary.automationId.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
  }
  if ($null -ne $payload.controlType -and "$($payload.controlType)" -ne '') {
    $needle = "$($payload.controlType)"
    $filtered = @($filtered | Where-Object { $_.summary.type.Equals($needle, [System.StringComparison]::OrdinalIgnoreCase) })
  }
  return $filtered
}

function Find-MsaaChildId([long]$handle, [string]$itemName) {
  if ($handle -eq 0 -or [string]::IsNullOrWhiteSpace($itemName)) { return 0 }
  $holder = Get-Msaa $handle
  if ($null -eq $holder) { return 0 }
  $accessible = $holder.accessible
  $count = 0
  try { $count = [int]$accessible.accChildCount } catch { return 0 }
  $partial = 0
  $maximum = [Math]::Min($count, 200)
  for ($childId = 1; $childId -le $maximum; $childId++) {
    try { $name = [string]$accessible.accName($childId) } catch { continue }
    if ($name.Equals($itemName, [System.StringComparison]::OrdinalIgnoreCase)) { return $childId }
    if ($partial -eq 0 -and $name.IndexOf($itemName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $partial = $childId
    }
  }
  return $partial
}

function Find-UiElement($root, $payload) {
  $tree = Get-UiTree $root 10 2000
  $items = @(Filter-UiItems $tree.items $payload)
  $itemName = ''
  if ($null -ne $payload.item) { $itemName = "$($payload.item)" }
  $hasControlSelector = (
    ($null -ne $payload.name -and "$($payload.name)" -ne '') -or
    ($null -ne $payload.automationId -and "$($payload.automationId)" -ne '') -or
    ($null -ne $payload.controlType -and "$($payload.controlType)" -ne '') -or
    ($null -ne $payload.index)
  )

  if ($items.Count -gt 0 -and $hasControlSelector) {
    $index = -1
    if ($null -ne $payload.index) { $index = [int]$payload.index }
    $chosen = $null
    if ($index -ge 0) {
      if ($index -ge $items.Count) {
        throw "control index $index is out of range (0..$($items.Count - 1)) for the current filter"
      }
      $chosen = $items[$index]
    } else {
      $chosen = $items[0]
    }
    if ($itemName -ne '') {
      $childId = Find-MsaaChildId $chosen.summary.handle $itemName
      if ($childId -gt 0) {
        return [pscustomobject]@{ node = $chosen; childId = $childId }
      }
      throw "the control [$($chosen.summary.name)] has no list item matching '$itemName'"
    }
    return [pscustomobject]@{ node = $chosen; childId = 0 }
  }

  if ($itemName -ne '') {
    foreach ($node in $tree.items) {
      $childId = Find-MsaaChildId $node.summary.handle $itemName
      if ($childId -gt 0) {
        return [pscustomobject]@{ node = $node; childId = $childId }
      }
    }
    $itemNodes = @($tree.items | Where-Object {
      $_.summary.name.Equals($itemName, [System.StringComparison]::OrdinalIgnoreCase) -and
      (@('ListItem', 'TreeItem', 'DataItem', 'TabItem') -contains $_.summary.type)
    })
    if ($itemNodes.Count -gt 0) {
      return [pscustomobject]@{ node = $itemNodes[0]; childId = 0 }
    }
  }

  $described = ''
  if ($null -ne $payload.name) { $described += " name=[$($payload.name)]" }
  if ($null -ne $payload.automationId) { $described += " automationId=[$($payload.automationId)]" }
  if ($null -ne $payload.controlType) { $described += " type=[$($payload.controlType)]" }
  throw "no UI Automation control matched$described in the target window"
}

function Get-UiPattern($element, $pattern) {
  $value = $null
  try {
    if ($element.TryGetCurrentPattern($pattern, [ref]$value)) { return $value }
  } catch {
  }
  return $null
}

function Get-UiWindowSummary($window) {
  return [pscustomobject]@{
    hwnd    = $window.hwnd
    title   = $window.title
    pid     = $window.pid
    process = $window.process
  }
}

function Invoke-Ui($payload) {
  Initialize-Ui
  $window = Resolve-WindowTarget $payload
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$window.hwnd)
  } catch {
    throw "cannot attach UI Automation to window [$($window.title)] (hwnd $($window.hwnd)): $(Get-ErrorMessage $_)"
  }
  if ($null -eq $root) {
    throw "window [$($window.title)] (hwnd $($window.hwnd)) has no UI Automation element"
  }

  $operation = [string]$payload.op
  if ([string]::IsNullOrWhiteSpace($operation)) {
    throw "ui requires 'op' (list, invoke, setValue, select, click, focus)"
  }

  $maxDepth = 8
  if ($null -ne $payload.maxDepth) { $maxDepth = [Math]::Max(1, [Math]::Min(20, [int]$payload.maxDepth)) }
  $maxItems = 250
  if ($null -ne $payload.maxItems) { $maxItems = [Math]::Max(1, [Math]::Min(2000, [int]$payload.maxItems)) }

  if ($operation -eq 'list') {
    $tree = Get-UiTree $root $maxDepth $maxItems
    $items = @(Filter-UiItems $tree.items $payload)
    $controls = @()
    foreach ($item in $items) { $controls += $item.summary }
    return [pscustomobject]@{
      action    = 'ui'
      op        = 'list'
      window    = Get-UiWindowSummary $window
      count     = $controls.Count
      truncated = [bool]$tree.truncated
      controls  = $controls
    }
  }

  $target = Find-UiElement $root $payload
  $summary = $target.node.summary
  $element = $target.node.element
  $accessible = $null
  if ($null -ne $target.node.summary.handle -and $target.node.summary.handle -ne 0) {
    $holder = Get-Msaa $target.node.summary.handle
    if ($null -ne $holder) { $accessible = $holder.accessible }
  }

  $method = ''
  $value = ''
  $matched = $null
  $selected = $null
  $focused = $null
  $state = 0

  switch ($operation) {
    'invoke' {
      $invoke = Get-UiPattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
      if ($null -ne $invoke) {
        $invoke.Invoke()
        $method = 'invoke'
      } elseif ($null -ne $accessible) {
        $invokeChild = 0
        if ($null -ne $target.childId) { $invokeChild = [int]$target.childId }
        $role = -1
        $defaultAction = ''
        try { $role = [int]$accessible.accRole($invokeChild) } catch { }
        try { $defaultAction = [string]$accessible.accDefaultAction($invokeChild) } catch { }
        $actionable = @(12, 34, 36, 38, 43, 44, 45, 56, 57, 62, 64) -contains $role
        if ($defaultAction -eq '' -and -not $actionable) {
          throw "the control [$($summary.name)] supports no Invoke pattern (patterns: $($summary.patterns -join ', '))"
        }
        try {
          $accessible.accDoDefaultAction($invokeChild)
          $method = 'defaultAction'
        } catch {
          throw "the control [$($summary.name)] cannot be invoked: $(Get-ErrorMessage $_)"
        }
      } else {
        throw "the control [$($summary.name)] supports no Invoke pattern (patterns: $($summary.patterns -join ', '))"
      }
      Start-Sleep -Milliseconds 150
    }
    'setvalue' {
      if ($null -eq $payload.value) { throw "setValue requires a 'value' string" }
      $text = [string]$payload.value
      $valuePattern = Get-UiPattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
      if ($null -ne $valuePattern) {
        if ($valuePattern.Current.IsReadOnly) { throw "the control [$($summary.name)] is read-only" }
        $valuePattern.SetValue($text)
        Start-Sleep -Milliseconds 80
        $value = [string]$valuePattern.Current.Value
        $method = 'valuePattern'
      } elseif ($null -ne $accessible) {
        try {
          $accessible.accValue(0) = $text
          Start-Sleep -Milliseconds 80
          $value = [string]$accessible.accValue(0)
          $method = 'msaaValue'
        } catch {
          throw "the control [$($summary.name)] cannot set a value: $(Get-ErrorMessage $_)"
        }
      } else {
        throw "the control [$($summary.name)] supports no Value pattern (patterns: $($summary.patterns -join ', '))"
      }
      $matched = ($value -eq $text)
    }
    'select' {
      $itemName = ''
      if ($null -ne $payload.item) { $itemName = [string]$payload.item }
      if ([string]::IsNullOrWhiteSpace($itemName)) { throw "select requires an 'item' name" }
      if ($null -ne $target.childId -and [int]$target.childId -gt 0) {
        if ($null -eq $accessible) {
          $holder = Get-Msaa $summary.handle
          if ($null -ne $holder) { $accessible = $holder.accessible }
        }
        if ($null -eq $accessible) { throw "cannot read the list items of [$($summary.name)]" }
        try {
          # A background list can ignore a default action on an item; focus it first.
          try { $element.SetFocus() } catch { }
          Start-Sleep -Milliseconds 80
          $accessible.accDoDefaultAction([int]$target.childId)
          Start-Sleep -Milliseconds 250
          $state = [int]$accessible.accState([int]$target.childId)
          $selected = (($state -band 2) -ne 0)
          if (-not $selected) {
            # Some MSAA providers need a selection call in addition to the
            # default action; retry once before reporting failure.
            try { $accessible.accSelect(3, [int]$target.childId) } catch { }
            Start-Sleep -Milliseconds 150
            $state = [int]$accessible.accState([int]$target.childId)
            $selected = (($state -band 2) -ne 0)
          }
          if (-not $selected) {
            $accessible.accDoDefaultAction([int]$target.childId)
            Start-Sleep -Milliseconds 150
            $state = [int]$accessible.accState([int]$target.childId)
            $selected = (($state -band 2) -ne 0)
          }
          $method = 'defaultAction'
          $value = $itemName
        } catch {
          throw "cannot select the list item '$itemName': $(Get-ErrorMessage $_)"
        }
      } else {
        $selection = Get-UiPattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($null -ne $selection) {
          $selection.Select()
          Start-Sleep -Milliseconds 120
          $selected = [bool]$selection.Current.IsSelected
          $method = 'selectionItem'
        } elseif ($null -ne $accessible) {
          try {
            $accessible.accDoDefaultAction(0)
            Start-Sleep -Milliseconds 120
            $state = [int]$accessible.accState(0)
            $selected = (($state -band 2) -ne 0)
            $method = 'defaultAction'
          } catch {
            throw "the control [$($summary.name)] cannot select an item: $(Get-ErrorMessage $_)"
          }
        } else {
          throw "the control [$($summary.name)] supports no SelectionItem pattern"
        }
      }
    }
    'click' {
      $invoke = Get-UiPattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
      $selection = Get-UiPattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $toggle = Get-UiPattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
      if ($null -ne $invoke) {
        $invoke.Invoke()
        $method = 'invoke'
        Start-Sleep -Milliseconds 150
      } elseif ($null -ne $selection) {
        $selection.Select()
        $method = 'selectionItem'
        Start-Sleep -Milliseconds 120
      } elseif ($null -ne $toggle) {
        $toggle.Toggle()
        $method = 'toggle'
        Start-Sleep -Milliseconds 120
      } elseif ($null -ne $accessible) {
        $childId = 0
        if ($null -ne $target.childId) { $childId = [int]$target.childId }
        $role = -1
        $defaultAction = ''
        try { $role = [int]$accessible.accRole($childId) } catch { }
        try { $defaultAction = [string]$accessible.accDefaultAction($childId) } catch { }
        $actionable = @(12, 34, 36, 38, 43, 44, 45, 56, 57, 62, 64) -contains $role
        if ($defaultAction -ne '' -or $actionable) {
          try {
            $accessible.accDoDefaultAction($childId)
            $method = 'defaultAction'
            Start-Sleep -Milliseconds 150
          } catch {
            $accessible = $null
          }
        }
      }
      if ($method -eq '') {
        if ($summary.width -le 0 -or $summary.height -le 0) {
          throw "the control [$($summary.name)] has no clickable area"
        }
        if (-not [ComputerControlNative]::Activate($window.hwnd)) {
          throw "cannot bring window [$($window.title)] to the foreground for a coordinate click"
        }
        [void](Assert-Foreground $payload.expect)
        $clickX = [int]($summary.x + [Math]::Floor($summary.width / 2))
        $clickY = [int]($summary.y + [Math]::Floor($summary.height / 2))
        [ComputerControlNative]::Click($clickX, $clickY, 'left', 1)
        $method = 'coordinate'
        $value = "$clickX,$clickY"
        Start-Sleep -Milliseconds 120
      }
    }
    'focus' {
      try {
        $element.SetFocus()
        $method = 'setFocus'
      } catch {
        if ($null -eq $accessible) { throw "the control [$($summary.name)] cannot take focus: $(Get-ErrorMessage $_)" }
        try {
          $childId = 0
          if ($null -ne $target.childId) { $childId = [int]$target.childId }
          $accessible.accSelect(1, $childId)
          $method = 'msaaFocus'
        } catch {
          throw "the control [$($summary.name)] cannot take focus: $(Get-ErrorMessage $_)"
        }
      }
      Start-Sleep -Milliseconds 120
      try { $focused = [bool]$element.Current.HasKeyboardFocus } catch { $focused = $null }
    }
    default {
      throw "unknown ui op '$operation' (expected list, invoke, setValue, select, click, focus)"
    }
  }

  $result = [pscustomobject]@{
    action  = 'ui'
    op      = $operation
    ok      = $true
    window  = Get-UiWindowSummary $window
    control = $summary
    method  = $method
  }
  if ($value -ne '') { $result | Add-Member -NotePropertyName value -NotePropertyValue $value }
  if ($operation -eq 'select') {
    $result | Add-Member -NotePropertyName item -NotePropertyValue $itemName
    $result | Add-Member -NotePropertyName childId -NotePropertyValue ([int]$target.childId)
  }
  if ($null -ne $matched) { $result | Add-Member -NotePropertyName matched -NotePropertyValue ([bool]$matched) }
  if ($null -ne $selected) { $result | Add-Member -NotePropertyName selected -NotePropertyValue ([bool]$selected) }
  if ($null -ne $focused) { $result | Add-Member -NotePropertyName focused -NotePropertyValue ([bool]$focused) }
  return $result
}

function Invoke-WindowAction([string]$operation, $payload) {
  if ($operation -eq 'window-close') {
    $window = Resolve-WindowTarget $payload -Unique
  } else {
    $window = Resolve-WindowTarget $payload
  }
  switch ($operation) {
    'focus' {
      $activated = [ComputerControlNative]::Activate($window.hwnd)
      $foreground = $false
      for ($i = 0; $i -lt 20; $i++) {
        if ([ComputerControlNative]::GetForegroundWindow().ToInt64() -eq $window.hwnd) {
          $foreground = $true
          break
        }
        Start-Sleep -Milliseconds 50
      }
      return [pscustomobject]@{
        hwnd       = $window.hwnd
        title      = $window.title
        pid        = $window.pid
        process    = $window.process
        activated  = [bool]$activated
        foreground = [bool]$foreground
      }
    }
    'window-move' {
      $x = $window.x
      $y = $window.y
      $width = $window.width
      $height = $window.height
      if ($null -ne $payload.x) { $x = [int]$payload.x }
      if ($null -ne $payload.y) { $y = [int]$payload.y }
      if ($null -ne $payload.width) { $width = [int]$payload.width }
      if ($null -ne $payload.height) { $height = [int]$payload.height }
      if ($width -lt 1 -or $height -lt 1) { throw "window size must be positive (got $($width)x$($height))" }
      if (-not [ComputerControlNative]::MoveWindowTo($window.hwnd, $x, $y, $width, $height)) {
        throw "cannot move window [$($window.title)] (hwnd $($window.hwnd))"
      }
      Start-Sleep -Milliseconds 120
      $rect = [ComputerControlNative]::WindowRect($window.hwnd)
      return [pscustomobject]@{
        hwnd = $window.hwnd
        title = $window.title
        x = $rect[0]
        y = $rect[1]
        width = $rect[2]
        height = $rect[3]
      }
    }
    { $_ -eq 'window-minimize' -or $_ -eq 'window-maximize' -or $_ -eq 'window-restore' } {
      $command = 9
      if ($operation -eq 'window-minimize') { $command = 6 }
      if ($operation -eq 'window-maximize') { $command = 3 }
      [void][ComputerControlNative]::ShowWindowEx($window.hwnd, $command)
      Start-Sleep -Milliseconds 150
      $rect = [ComputerControlNative]::WindowRect($window.hwnd)
      return [pscustomobject]@{
        hwnd      = $window.hwnd
        title     = $window.title
        minimized = [ComputerControlNative]::IsWindowMinimized($window.hwnd)
        maximized = [ComputerControlNative]::IsWindowMaximized($window.hwnd)
        x         = $rect[0]
        y         = $rect[1]
        width     = $rect[2]
        height    = $rect[3]
      }
    }
    'window-close' {
      if (-not [ComputerControlNative]::CloseWindow($window.hwnd)) {
        throw "cannot close window [$($window.title)] (hwnd $($window.hwnd))"
      }
      $closed = $false
      for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 50
        if (-not [ComputerControlNative]::IsWindowVisible($window.hwnd)) {
          $closed = $true
          break
        }
      }
      return [pscustomobject]@{
        hwnd   = $window.hwnd
        title  = $window.title
        closed = [bool]$closed
      }
    }
    default {
      throw "unknown window operation '$operation'"
    }
  }
}

function Invoke-Action([string]$name, $payload) {
  if ($null -eq $payload) { $payload = [pscustomobject]@{} }
  switch ($name) {
    'info' { return Get-ScreenInfo }
    'screenshot' { return Save-Screenshot $payload }
    'move' {
      if ($null -eq $payload.x -or $null -eq $payload.y) { throw "move requires 'x' and 'y'" }
      $x = [int]$payload.x
      $y = [int]$payload.y
      [ComputerControlNative]::Move($x, $y)
      $cursor = [ComputerControlNative]::Cursor()
      return [pscustomobject]@{ x = $cursor[0]; y = $cursor[1] }
    }
    'click' {
      $cursor = [ComputerControlNative]::Cursor()
      $x = $cursor[0]
      $y = $cursor[1]
      if ($null -ne $payload.x) { $x = [int]$payload.x }
      if ($null -ne $payload.y) { $y = [int]$payload.y }
      $button = 'left'
      if ($null -ne $payload.button -and "$($payload.button)" -ne '') { $button = "$($payload.button)" }
      $count = 1
      if ($null -ne $payload.count) { $count = [int]$payload.count }
      if ($count -lt 1) { $count = 1 }
      if ($count -gt 3) { $count = 3 }
      $front = Assert-Foreground $payload.expect
      [ComputerControlNative]::Click($x, $y, $button, $count)
      return [pscustomobject]@{
        x      = $x
        y      = $y
        button = $button
        count  = $count
        window = $front.title
        hwnd   = $front.hwnd
      }
    }
    'scroll' {
      $cursor = [ComputerControlNative]::Cursor()
      $x = $cursor[0]
      $y = $cursor[1]
      if ($null -ne $payload.x) { $x = [int]$payload.x }
      if ($null -ne $payload.y) { $y = [int]$payload.y }
      $amount = 3
      if ($null -ne $payload.amount) { $amount = [int]$payload.amount }
      $horizontal = ($payload.horizontal -eq $true)
      $front = Assert-Foreground $payload.expect
      [ComputerControlNative]::Scroll($x, $y, $amount, $horizontal)
      return [pscustomobject]@{
        x          = $x
        y          = $y
        amount     = $amount
        horizontal = $horizontal
        window     = $front.title
        hwnd       = $front.hwnd
      }
    }
    'drag' {
      foreach ($key in @('fromX', 'fromY', 'toX', 'toY')) {
        if ($null -eq $payload.$key) { throw "drag requires '$key'" }
      }
      $button = 'left'
      if ($null -ne $payload.button -and "$($payload.button)" -ne '') { $button = "$($payload.button)" }
      $duration = 400
      if ($null -ne $payload.durationMs) { $duration = [int]$payload.durationMs }
      if ($duration -lt 50) { $duration = 50 }
      if ($duration -gt 10000) { $duration = 10000 }
      $front = Assert-Foreground $payload.expect
      [ComputerControlNative]::Drag(
        [int]$payload.fromX,
        [int]$payload.fromY,
        [int]$payload.toX,
        [int]$payload.toY,
        $button,
        $duration
      )
      return [pscustomobject]@{
        fromX  = [int]$payload.fromX
        fromY  = [int]$payload.fromY
        toX    = [int]$payload.toX
        toY    = [int]$payload.toY
        button = $button
        window = $front.title
        hwnd   = $front.hwnd
      }
    }
    'type' { return Invoke-KeyboardAction 'type' $payload }
    'key' { return Invoke-KeyboardAction 'key' $payload }
    'foreground' { return Get-ForegroundInfo }
    'windows' {
      $rows = @(Get-WindowRows)
      return [pscustomobject]@{ count = $rows.Count; windows = $rows }
    }
    'focus' { return Invoke-WindowAction 'focus' $payload }
    'window-move' { return Invoke-WindowAction 'window-move' $payload }
    'window-minimize' { return Invoke-WindowAction 'window-minimize' $payload }
    'window-maximize' { return Invoke-WindowAction 'window-maximize' $payload }
    'window-restore' { return Invoke-WindowAction 'window-restore' $payload }
    'window-close' { return Invoke-WindowAction 'window-close' $payload }
    'ui' { return Invoke-Ui $payload }
    default { throw "unknown action '$name'" }
  }
}

function Start-Server {
  Get-Native
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 6 -InputObject ([pscustomobject]@{
    ready       = $true
    pid         = $PID
    dpiAwareness = [ComputerControlNative]::DpiMode
    version     = 1
  })))
  [Console]::Out.Flush()

  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $id = $null
    $response = $null
    try {
      $request = $line | ConvertFrom-Json
      $id = $request.id
      $requestedAction = [string]$request.action
      if ($requestedAction -eq 'shutdown') {
        $response = [pscustomobject]@{ id = $id; ok = $true; result = [pscustomobject]@{ shutdown = $true } }
        [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject $response))
        [Console]::Out.Flush()
        break
      }
      $payload = $request.payload
      if ($null -eq $payload) { $payload = [pscustomobject]@{} }
      $result = Invoke-Action $requestedAction $payload
      $response = [pscustomobject]@{ id = $id; ok = $true; result = $result }
    } catch {
      $response = [pscustomobject]@{ id = $id; ok = $false; error = (Get-ErrorMessage $_) }
    }
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 12 -InputObject $response))
    [Console]::Out.Flush()
  }
}

if ($Server) {
  try {
    Start-Server
    exit 0
  } catch {
    Write-ErrorLine (Get-ErrorMessage $_)
    exit 1
  }
}

if ([string]::IsNullOrWhiteSpace($Action)) {
  Write-ErrorLine 'no action was requested (pass -Action <name> or -Server)'
  exit 2
}

try {
  $payload = Read-Payload $PayloadPath
  Get-Native
  $result = Invoke-Action $Action $payload
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 12 -InputObject $result))
  exit 0
} catch {
  Write-ErrorLine (Get-ErrorMessage $_)
  exit 1
}
