param([int]$OwnerPid, [switch]$Once)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class QuotaTaskbar {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out Rect r, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
  [StructLayout(LayoutKind.Sequential)] public struct Monitor { public int Size; public Rect Bounds, Work; public uint Flags; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr h, ref Monitor m);
}
'@
[void][QuotaTaskbar]::SetThreadDpiAwarenessContext([IntPtr](-4))
function Convert-Rect($r) { @{ x=$r.Left; y=$r.Top; width=($r.Right-$r.Left); height=($r.Bottom-$r.Top) } }
$events = $null
$trigger = 'initial'
if (-not $Once) {
  Add-Type -Path (Join-Path $PSScriptRoot 'taskbar-events.cs')
  $events = New-Object QuotaTaskbarEvents ([uint32]$OwnerPid)
}
try {
while (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue) {
  $bar = [QuotaTaskbar]::FindWindow('Shell_TrayWnd', $null)
  $tray = [QuotaTaskbar]::FindWindowEx($bar, [IntPtr]::Zero, 'TrayNotifyWnd', $null)
  $b = New-Object QuotaTaskbar+Rect
  $t = New-Object QuotaTaskbar+Rect
  $visible = $bar -ne [IntPtr]::Zero -and $tray -ne [IntPtr]::Zero -and [QuotaTaskbar]::IsWindowVisible($bar)
  $visible = $visible -and [QuotaTaskbar]::GetWindowRect($bar, [ref]$b) -and [QuotaTaskbar]::GetWindowRect($tray, [ref]$t)
  if ($visible) {
    $monitor = New-Object QuotaTaskbar+Monitor
    $monitor.Size = [Runtime.InteropServices.Marshal]::SizeOf($monitor)
    [void][QuotaTaskbar]::GetMonitorInfo([QuotaTaskbar]::MonitorFromWindow($bar, 2), [ref]$monitor)
    # An auto-hidden taskbar only leaves a thin strip on the display.
    $visible = [Math]::Min($b.Bottom,$monitor.Bounds.Bottom) - [Math]::Max($b.Top,$monitor.Bounds.Top) -ge 24
    $fg = [QuotaTaskbar]::GetForegroundWindow()
    $className = New-Object Text.StringBuilder 256
    [void][QuotaTaskbar]::GetClassName($fg, $className, 256)
    $f = New-Object QuotaTaskbar+Rect
    if ($fg -ne $bar -and $className.ToString() -notin @('Progman','WorkerW') -and [QuotaTaskbar]::IsWindowVisible($fg) -and -not [QuotaTaskbar]::IsIconic($fg) -and [QuotaTaskbar]::GetWindowRect($fg, [ref]$f)) {
      # Visible frame excludes maximized windows' invisible resize borders.
      # Do not reject IsZoomed: borderless fullscreen games can retain that flag.
      $frame = New-Object QuotaTaskbar+Rect
      if ([QuotaTaskbar]::DwmGetWindowAttribute($fg, 9, [ref]$frame, 16) -eq 0 -and $frame.Right -gt $frame.Left) { $f = $frame }
      if ($f.Left -le $monitor.Bounds.Left -and $f.Top -le $monitor.Bounds.Top -and $f.Right -ge $monitor.Bounds.Right -and $f.Bottom -ge $monitor.Bounds.Bottom) { $visible = $false }
    }
  }
  @{ visible=$visible; taskbar=(Convert-Rect $b); tray=(Convert-Rect $t); trigger=$trigger } | ConvertTo-Json -Compress
  if ($Once) { break }
  $trigger = $events.Wait()
}
} finally { if ($events) { $events.Dispose() } }
