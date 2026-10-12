using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

// Out-of-context hooks: no DLL injection into Explorer or games. The caller
// pumps messages on the registering thread while waiting, rather than sleeping.
public sealed class QuotaTaskbarEvents : IDisposable {
    private delegate void WinEventProc(IntPtr hook, uint kind, IntPtr hwnd,
        int objectId, int childId, uint thread, uint time);
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Message {
        public IntPtr Hwnd; public uint Id; public UIntPtr WParam; public IntPtr LParam;
        public uint Time; public Point Position; public uint Private;
    }
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint first, uint last,
        IntPtr module, WinEventProc callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message msg);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message msg);
    [DllImport("user32.dll")] private static extern uint MsgWaitForMultipleObjectsEx(uint count,
        IntPtr handles, uint timeout, uint wakeMask, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hwnd, int index);
    private readonly List<IntPtr> hooks = new List<IntPtr>();
    private readonly HashSet<IntPtr> taskWindows = new HashSet<IntPtr>();
    private readonly WinEventProc callback;
    private readonly uint owner;
    private readonly Stopwatch clock = Stopwatch.StartNew();
    private long settleAt = -1;
    private bool changed, disposed;
    private IntPtr foreground;

    public QuotaTaskbarEvents(uint ownerPid) {
        owner = ownerPid;
        foreground = GetForegroundWindow();
        callback = OnEvent; // Keep delegate rooted until all hooks are removed.
        try {
            Hook(0x0003, 0x0003); // foreground
            Hook(0x0016, 0x0017); // minimize start/end
            Hook(0x8000, 0x8004); // create/destroy/show/hide/reorder
            Hook(0x800B, 0x800B); // location change
            Hook(0x8017, 0x8018); // cloak/uncloak (virtual desktops)
        } catch { Dispose(); throw; }
    }
    private void Hook(uint first, uint last) {
        var hook = SetWinEventHook(first, last, IntPtr.Zero, callback, 0, 0, 2); // skip helper's own process
        if (hook == IntPtr.Zero) throw new Win32Exception("Cannot register taskbar window event hook");
        hooks.Add(hook);
    }
    private void OnEvent(IntPtr hook, uint kind, IntPtr hwnd, int objectId, int childId, uint thread, uint time) {
        if (disposed) return;
        // Taskbar accessibility children report button create/reorder/location
        // events too. Retain those, while rejecting unrelated text/caret churn.
        bool childEvent=kind >= 0x8000 && (objectId != 0 || childId != 0);
        if (childEvent) {
            if (hwnd == IntPtr.Zero) return;
            var root=GetAncestor(hwnd, 2);
            var rootName=new StringBuilder(64);
            GetClassName(root, rootName, rootName.Capacity);
            if (rootName.ToString() != "Shell_TrayWnd" && rootName.ToString() != "Shell_SecondaryTrayWnd") return;
            changed=true; return;
        }
        var current = GetForegroundWindow();
        bool relevant = kind == 3;
        if (!relevant && hwnd != IntPtr.Zero && objectId == 0 && childId == 0) {
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            // Raising/redrawing our own meter must not cause an event feedback loop.
            if (pid != owner) {
                var name = new StringBuilder(64);
                GetClassName(hwnd, name, name.Capacity);
                string cls = name.ToString();
                bool shell = cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd" || cls == "TrayNotifyWnd";
                // Games may reorder their windows repeatedly without changing
                // fullscreen state. Only shell reorders require raising meters.
                // Background top-level windows can add/remove task buttons
                // without becoming foreground. Ignore their location churn.
                var root=GetAncestor(hwnd, 2);
                bool appears=kind == 0x8000 || kind == 0x8002 || kind == 0x8018;
                bool disappears=kind == 0x8001 || kind == 0x8003 || kind == 0x8017;
                // UI Automation / console workers create hidden top-level
                // windows. Treating those as task buttons creates a scan loop.
                bool taskWindow=appears && root == hwnd && IsWindowVisible(hwnd)
                    && (GetWindowLong(hwnd, -20) & 0x80) == 0;
                if (taskWindow) taskWindows.Add(hwnd);
                if (disappears) taskWindow=taskWindows.Remove(hwnd);
                var rootName=new StringBuilder(64);
                GetClassName(root, rootName, rootName.Capacity);
                bool shellChild=rootName.ToString() == "Shell_TrayWnd" || rootName.ToString() == "Shell_SecondaryTrayWnd";
                relevant = shell || shellChild || taskWindow || (kind != 0x8004 && (hwnd == current || hwnd == foreground));
            }
        }
        foreground = current;
        if (relevant) changed = true;
    }
    public string Wait() {
        if (disposed) throw new ObjectDisposedException("QuotaTaskbarEvents");
        long fallbackAt = clock.ElapsedMilliseconds + 5000;
        while (true) {
            Message message;
            // Bound draining so an event storm cannot starve the state update.
            for (int i = 0; i < 128 && PeekMessage(out message, IntPtr.Zero, 0, 0, 1); i++) {
                TranslateMessage(ref message); DispatchMessage(ref message);
            }
            long now = clock.ElapsedMilliseconds;
            if (changed) {
                changed = false;
                settleAt = now + 180; // one trailing check after shell transition animations
                return "event";
            }
            if (settleAt >= 0 && now >= settleAt) { settleAt = -1; return "settle"; }
            if (now >= fallbackAt) return "fallback";
            long deadline = settleAt >= 0 ? Math.Min(settleAt, fallbackAt) : fallbackAt;
            uint result = MsgWaitForMultipleObjectsEx(0, IntPtr.Zero, (uint)Math.Max(1, deadline - now), 0x04FF, 4);
            if (result == 0xFFFFFFFF) throw new Win32Exception("Taskbar event message wait failed");
        }
    }
    public void Dispose() {
        disposed = true;
        foreach (var hook in hooks) UnhookWinEvent(hook);
        hooks.Clear();
        GC.KeepAlive(callback);
    }
}
