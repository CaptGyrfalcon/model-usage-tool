using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class NativeTaskbar {
    [StructLayout(LayoutKind.Sequential)] internal struct Rect {
        public int Left, Top, Right, Bottom;
        public Rectangle Bounds { get { return Rectangle.FromLTRB(Left, Top, Right, Bottom); } }
    }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] internal static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] internal static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] internal static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] internal static extern bool ValidateRect(IntPtr hwnd,IntPtr rect);
    [DllImport("user32.dll")] internal static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] internal static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] internal static extern int GetWindowLong(IntPtr hwnd, int index);
    [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X,Y; public Point(int x,int y) { X=x; Y=y; } }
    [StructLayout(LayoutKind.Sequential)] internal struct Size { public int Width,Height; public Size(int w,int h) { Width=w; Height=h; } }
    [StructLayout(LayoutKind.Sequential, Pack=1)] internal struct Blend { public byte Op,Flags,Alpha,Format; }
    [DllImport("user32.dll",SetLastError=true)] internal static extern bool UpdateLayeredWindow(IntPtr hwnd,IntPtr target,IntPtr position,ref Size size,IntPtr source,ref Point origin,uint key,ref Blend blend,uint flags);
    [DllImport("gdi32.dll")] internal static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] internal static extern IntPtr SelectObject(IntPtr dc,IntPtr obj);
    [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] internal static extern bool DeleteDC(IntPtr dc);
    internal static void Send(object value) {
        lock (typeof(NativeTaskbar)) { Console.WriteLine(new JavaScriptSerializer().Serialize(value)); Console.Out.Flush(); }
    }
}

public sealed class QuotaMeter { public string label; public double? value; public double? remainingCents; public double? pace; }
public sealed class QuotaRow { public string label; public QuotaMeter[] meters; }
public sealed class QuotaData { public bool stale; public double? sampledAt; public QuotaRow[] rows; }

internal static class MeterLayout {
    internal const int Width = 376;
    internal const int Height = 44;
    internal const float NameLeft = 7f;
    internal const float NameWidth = 43f;
    internal const float MeterLeft = 51f;
    internal const float RightPad = 7f;
    internal const float ValueWidth = 112f;
    internal const float MeterGap = 5f;
    internal const float BarHeight = 3f;
    internal static float Segment(float width, int meters, float scale) {
        return (width - MeterLeft * scale - RightPad * scale) / Math.Max(1, meters);
    }
    internal static RectangleF Bar(float x, float y, float segment, float rowHeight, float scale) {
        return new RectangleF(x, y + rowHeight * 0.36f,
            Math.Max(3 * scale, segment - ValueWidth * scale - MeterGap * scale), BarHeight * scale);
    }
}

// This is a WS_CHILD control created directly inside Shell_TrayWnd, never a
// top-level/always-on-top window. Explorer's visibility and z-order govern it.
internal sealed class MeterControl : Control {
    private readonly IntPtr shell;
    private readonly ToolTip tip = new ToolTip();
    private readonly System.Windows.Forms.Timer hoverTimer = new System.Windows.Forms.Timer();
    private QuotaData data;
    private bool light, hover;
    private bool dirty = true;
    internal int PresentedFrames { get; private set; }
    private float scale;
    internal MeterControl(IntPtr parent, float dpiScale) {
        shell = parent; scale = dpiScale;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true);
        SetStyle(ControlStyles.OptimizedDoubleBuffer, false);
        SetStyle(ControlStyles.StandardClick | ControlStyles.StandardDoubleClick, true);
        Text = "AI 用量 · 任务栏";
        AccessibleName = "AI 用量，双击打开详情，右键打开菜单";
        AccessibleRole = AccessibleRole.PushButton;
        Cursor = Cursors.Hand;
        TabStop = false;
        tip.ShowAlways = true;
        tip.InitialDelay = 500;
        hoverTimer.Interval = 100;
        hoverTimer.Tick += (s,e) => {
            NativeTaskbar.Point cursor;
            if (IsHandleCreated && NativeTaskbar.GetCursorPos(out cursor)) UpdateHover(cursor);
        };
        hoverTimer.Start();
        RefreshTheme();
    }
    protected override CreateParams CreateParams {
        get {
            var cp = base.CreateParams;
            cp.Parent = shell;
            cp.ClassStyle |= 0x0008; // CS_DBLCLKS
            cp.Style = unchecked((int)0x46000000); // CHILD | CLIPSIBLINGS | CLIPCHILDREN; initially hidden
            cp.ExStyle = 0x08080080; // NOACTIVATE | LAYERED | TOOLWINDOW; no TOPMOST
            return cp;
        }
    }
    internal void RefreshTheme() {
        bool next = false;
        using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")) {
            next = Convert.ToInt32(key == null ? 0 : key.GetValue("SystemUsesLightTheme", 0)) != 0;
        }
        if (next != light || Font.Size != 9) {
            light = next;
            var old = Font;
            Font = new Font("Segoe UI", 9, FontStyle.Regular, GraphicsUnit.Point);
            if (old != Control.DefaultFont) old.Dispose();
        }
        Color background = SystemInformation.HighContrast ? SystemColors.Control : (light ? Color.FromArgb(243,243,243) : Color.FromArgb(36,36,36));
        if (BackColor != background) { BackColor = background; dirty = true; Invalidate(); }
    }
    internal void SetData(QuotaData next) {
        data = next;
        var description = new StringBuilder("剩余额度 · 双击打开详情 · 右键打开菜单");
        if (data != null && data.rows != null) foreach (var row in data.rows) {
            if (row.meters == null) continue;
            description.Append("\n" + row.label + "  ");
            foreach (var meter in row.meters) {
                description.Append(meter.label + " " + Value(meter));
                if (meter.pace.HasValue) description.Append(" 匀速应余 " + meter.pace.Value.ToString("0.#") + "%");
                description.Append("  ");
            }
        }
        if (data != null && data.stale) description.Append("\n同步失败，显示缓存数据");
        if (data != null && data.sampledAt.HasValue) {
            try { description.Append("\nCodex 采样：" + new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc).AddMilliseconds(data.sampledAt.Value).ToLocalTime().ToString("g")); } catch (ArgumentOutOfRangeException) {}
        }
        tip.SetToolTip(this, description.ToString());
        AccessibleDescription = description.ToString();
        dirty = true; Invalidate();
    }
    private static string Money(QuotaMeter meter) {
        if (!meter.remainingCents.HasValue) return "";
        return " 余$" + (Math.Max(0, meter.remainingCents.Value) / 100.0).ToString("0.00", CultureInfo.InvariantCulture);
    }
    private static string Value(QuotaMeter meter) {
        return (meter.value.HasValue ? Math.Max(0, Math.Min(100, meter.value.Value)).ToString("0.#") + "%" : "—") + Money(meter);
    }
    private static void DrawPace(Graphics g, RectangleF bar, double pace, float scale) {
        float x = bar.X + bar.Width * (float)Math.Max(0, Math.Min(100, pace)) / 100f;
        float top = bar.Bottom + 0.5f * scale, half = 3.2f * scale, height = 3.6f * scale;
        using (var path = new GraphicsPath()) {
            path.AddPolygon(new[] { new PointF(x, top), new PointF(x - half, top + height), new PointF(x + half, top + height) });
            using (var brush = new SolidBrush(SystemInformation.HighContrast ? Color.Yellow : Color.FromArgb(255, 196, 0)))
                g.FillPath(brush, path);
        }
    }
    private static GraphicsPath Rounded(RectangleF r, float radius) {
        var p = new GraphicsPath(); float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        p.AddArc(r.Left,r.Top,d,d,180,90); p.AddArc(r.Right-d,r.Top,d,d,270,90);
        p.AddArc(r.Right-d,r.Bottom-d,d,d,0,90); p.AddArc(r.Left,r.Bottom-d,d,d,90,90); p.CloseFigure(); return p;
    }
    protected override void OnPaintBackground(PaintEventArgs e) { }
    // Layered child windows do not reliably receive an initial WM_PAINT.
    // Explicitly submit their surface after native layout and every data change.
    internal void Present() {
        if (!dirty || !IsHandleCreated) return;
        if (Width < 1 || Height < 1) return;
        using (var bitmap = new Bitmap(Width,Height,System.Drawing.Imaging.PixelFormat.Format32bppPArgb)) {
            using (var graphics = Graphics.FromImage(bitmap)) Render(graphics);
            IntPtr dc=NativeTaskbar.CreateCompatibleDC(IntPtr.Zero), image=bitmap.GetHbitmap(Color.FromArgb(0));
            IntPtr old=NativeTaskbar.SelectObject(dc,image);
            try {
                var origin=new NativeTaskbar.Point(0,0);
                var size=new NativeTaskbar.Size(Width,Height); var blend=new NativeTaskbar.Blend { Alpha=255,Format=1 };
                // Layout exclusively owns position. Passing screen coordinates
                // here moves WS_CHILD windows by the parent's offset a second
                // time, making every hover repaint jump outside the taskbar.
                if (!NativeTaskbar.UpdateLayeredWindow(Handle,IntPtr.Zero,IntPtr.Zero,ref size,dc,ref origin,0,ref blend,2))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Cannot compose taskbar meters");
                dirty = false; PresentedFrames++;
            } finally { NativeTaskbar.SelectObject(dc,old); NativeTaskbar.DeleteObject(image); NativeTaskbar.DeleteDC(dc); }
        }
    }
    internal void Render(Graphics g) {
        // A nearly transparent hit surface keeps the whole control clickable;
        // Explorer's real acrylic remains visible instead of a simulated panel.
        g.Clear(SystemInformation.HighContrast ? SystemColors.Control : Color.FromArgb(1,light ? Color.White : Color.Black));
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        if (hover) using (var brush = new SolidBrush(light ? Color.FromArgb(14,0,0,0) : Color.FromArgb(20,255,255,255)))
            using (var shape = Rounded(new RectangleF(0,0,Width-1,Height-1), 4*scale)) g.FillPath(brush,shape);
        if (data == null || data.rows == null) return;
        var fg = SystemInformation.HighContrast ? SystemColors.ControlText : light ? Color.FromArgb(35,35,35) : Color.FromArgb(242,242,242);
        var track = SystemInformation.HighContrast ? SystemColors.GrayText : light ? Color.FromArgb(210,210,210) : Color.FromArgb(77,77,77);
        float rowHeight = (Height - 4*scale) / 3f;
        using (var nameFont = new Font("Segoe UI", 9.5f * scale, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var valueFont = new Font("Microsoft YaHei UI", 8.5f * scale, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var text = new SolidBrush(fg))
        using (var format = new StringFormat { LineAlignment = StringAlignment.Center, FormatFlags = StringFormatFlags.NoWrap, Trimming = StringTrimming.EllipsisCharacter }) {
            for (int i = 0; i < Math.Min(3, data.rows.Length); i++) {
                var row = data.rows[i]; float y = 2*scale + i*rowHeight;
                g.DrawString(row.label, nameFont, text, new RectangleF(MeterLayout.NameLeft*scale,y,MeterLayout.NameWidth*scale,rowHeight),format);
                if (row.meters == null || row.meters.Length == 0) continue;
                float start = MeterLayout.MeterLeft*scale, segment = MeterLayout.Segment(Width, row.meters.Length, scale);
                for (int j = 0; j < row.meters.Length; j++) {
                    var meter = row.meters[j]; float x = start + j*segment;
                    var bar = MeterLayout.Bar(x, y, segment, rowHeight, scale);
                    using (var brush = new SolidBrush(track)) using (var shape = Rounded(bar,1.5f*scale)) g.FillPath(brush,shape);
                    if (meter.value.HasValue && meter.value.Value > 0) {
                        double v = Math.Max(0,Math.Min(100,meter.value.Value));
                        Color fill = SystemInformation.HighContrast ? SystemColors.Highlight : v <= 10 ? Color.FromArgb(225,83,83) : v <= 25 ? Color.FromArgb(218,149,40) : (light ? Color.FromArgb(0,103,192) : Color.FromArgb(96,205,255));
                        var used = bar; used.Width = Math.Max(scale, bar.Width*(float)v/100);
                        using (var brush = new SolidBrush(fill)) using (var shape = Rounded(used,1.5f*scale)) g.FillPath(brush,shape);
                    }
                    if (meter.pace.HasValue) DrawPace(g, bar, meter.pace.Value, scale);
                    var valueRect = new RectangleF(bar.Right+MeterLayout.MeterGap*scale,y,MeterLayout.ValueWidth*scale,rowHeight);
                    var state = g.Save();
                    g.SetClip(valueRect);
                    g.DrawString((row.label == "Codex" ? meter.label + " " : "") + Value(meter), valueFont, text, valueRect, format);
                    g.Restore(state);
                }
            }
        }
        if (data.stale) using (var brush = new SolidBrush(Color.FromArgb(218,149,40))) g.FillEllipse(brush,1*scale,Height/2f-1.5f*scale,3*scale,3*scale);
    }
    protected override void OnSizeChanged(EventArgs e) { dirty=true; base.OnSizeChanged(e); }
    internal void UpdateHover(NativeTaskbar.Point cursor) {
        NativeTaskbar.Rect rect;
        bool next = IsHandleCreated && NativeTaskbar.IsWindowVisible(Handle) && NativeTaskbar.GetWindowRect(Handle,out rect) && rect.Bounds.Contains(cursor.X,cursor.Y);
        // Layered updates and tooltips can generate synthetic enter/leave pairs.
        // Only the actual cursor crossing the bounds changes the hover surface.
        if (next == hover) return;
        hover=next; dirty=true; Present();
    }
    protected override void OnMouseDoubleClick(MouseEventArgs e) {
        if (e.Button == MouseButtons.Left) NativeTaskbar.Send(new { type="open" });
        base.OnMouseDoubleClick(e);
    }
    protected override void OnMouseUp(MouseEventArgs e) {
        if (e.Button == MouseButtons.Right) {
            var at = PointToScreen(e.Location);
            NativeTaskbar.Send(new { type="menu", x=at.X, y=at.Y });
        }
        base.OnMouseUp(e);
    }
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x21) { m.Result = new IntPtr(3); return; } // MA_NOACTIVATE
        if (m.Msg == 0x7B) { m.Result=IntPtr.Zero; return; } // The right-button handler owns our menu.
        if (m.Msg == 0x0F) { // WM_PAINT: never blit a WinForms buffer over the alpha surface.
            NativeTaskbar.ValidateRect(Handle,IntPtr.Zero); Present(); m.Result=IntPtr.Zero; return;
        }
        if (m.Msg == 0x14) { m.Result=new IntPtr(1); return; } // WM_ERASEBKGND
        base.WndProc(ref m);
    }
    protected override void Dispose(bool disposing) { if (disposing) { hoverTimer.Dispose(); tip.Dispose(); } base.Dispose(disposing); }
}

internal sealed class TaskbarHost : ApplicationContext {
    private readonly Process owner;
    private readonly Control dispatcher = new Control();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private MeterControl meter;
    private IntPtr shell;
    private QuotaData data;
    private string pending, lastStatus;
    private volatile bool eof, stopped;
    private Task<List<Rectangle>> scan;
    private IntPtr scanShell;
    private List<Rectangle> occupied;
    private DateTime scannedAt = DateTime.MinValue, nextScan = DateTime.MinValue;
    private uint currentDpi;
    internal TaskbarHost(int ownerPid) {
        owner = Process.GetProcessById(ownerPid);
        var unused = dispatcher.Handle;
        Task.Run(() => {
            try { string line; while ((line = Console.ReadLine()) != null) Interlocked.Exchange(ref pending,line); }
            finally { eof=true; }
        });
        Task.Run(() => {
            try {
                using (var events = new QuotaTaskbarEvents((uint)Process.GetCurrentProcess().Id)) {
                    while (!stopped) { events.Wait(); if (!stopped) dispatcher.BeginInvoke((Action)(() => { nextScan=DateTime.MinValue; Tick(); })); }
                }
            } catch (Exception) { /* The timer still handles Explorer recovery. */ }
        });
        timer.Interval=1000; timer.Tick += (s,e) => Tick(); timer.Start();
        Tick();
    }
    // UI Automation runs off the UI thread: a stalled shell provider cannot
    // freeze painting, stdin handling, shutdown or the visibility safety check.
    private static List<Rectangle> ScanButtons(IntPtr bar) {
        var root = AutomationElement.FromHandle(bar);
        var elements = root.FindAll(TreeScope.Descendants, new OrCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button),
            new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.CheckBox),
            new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.ListItem),
            new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.MenuItem)));
        var result = new List<Rectangle>();
        int pid = Process.GetCurrentProcess().Id;
        foreach (AutomationElement item in elements) {
            var current = item.Current;
            if (current.ProcessId == pid || current.IsOffscreen) continue;
            var r = current.BoundingRectangle;
            if (!r.IsEmpty && r.Width > 0 && r.Height > 0) result.Add(Rectangle.FromLTRB((int)Math.Floor(r.Left),(int)Math.Floor(r.Top),(int)Math.Ceiling(r.Right),(int)Math.Ceiling(r.Bottom)));
        }
        if (result.Count == 0) throw new InvalidOperationException("Taskbar buttons are not exposed yet");
        return result;
    }
    internal static Rectangle FindSlot(Rectangle bar, Rectangle tray, IList<Rectangle> buttons, int width, int height, int gap) {
        if (bar.Height < height || bar.Height > bar.Width || tray.Width <= 0) return Rectangle.Empty;
        int right = tray.Left-gap, left=bar.Left+gap;
        var sorted = new List<Rectangle>(buttons); sorted.Sort((a,b) => b.Right.CompareTo(a.Right));
        foreach (var r in sorted) {
            if (r.Bottom <= bar.Top || r.Top >= bar.Bottom || r.Left >= right || r.Right <= left) continue;
            if (right-Math.Max(left,r.Right+gap) >= width) break;
            right=Math.Min(right,r.Left-gap);
        }
        return right-left >= width ? new Rectangle(right-width,bar.Top+(bar.Height-height)/2,width,height) : Rectangle.Empty;
    }
    private void Status(string state) {
        long hwnd=meter == null || !meter.IsHandleCreated ? 0 : meter.Handle.ToInt64();
        string key=state+":"+hwnd;
        if (lastStatus == key) return;
        lastStatus=key;
        NativeTaskbar.Rect bounds = new NativeTaskbar.Rect();
        if (hwnd != 0) NativeTaskbar.GetWindowRect(meter.Handle,out bounds);
        NativeTaskbar.Send(new { type="status", state=state, hwnd=hwnd, parent=hwnd == 0 ? 0 : NativeTaskbar.GetParent(meter.Handle).ToInt64(),
            child=hwnd != 0 && (NativeTaskbar.GetWindowLong(meter.Handle,-16)&0x40000000)!=0,
            topmost=hwnd != 0 && (NativeTaskbar.GetWindowLong(meter.Handle,-20)&8)!=0,
            frames=meter == null ? 0 : meter.PresentedFrames,
            bounds=new { x=bounds.Left,y=bounds.Top,width=bounds.Right-bounds.Left,height=bounds.Bottom-bounds.Top } });
    }
    private void Hide(string reason) { if (meter != null && meter.IsHandleCreated) NativeTaskbar.ShowWindow(meter.Handle,0); Status(reason); }
    private void Tick() {
        if (stopped) return;
        if (eof || owner.HasExited) { ExitThread(); return; }
        string input=Interlocked.Exchange(ref pending,null);
        if (input != null) {
            if (input == "quit") { ExitThread(); return; }
            try { data=new JavaScriptSerializer().Deserialize<QuotaData>(input); if (meter!=null) meter.SetData(data); }
            catch (ArgumentException) { NativeTaskbar.Send(new { type="error", message="Invalid meter data" }); }
        }
        IntPtr bar=NativeTaskbar.FindWindow("Shell_TrayWnd",null);
        if (bar == IntPtr.Zero) { Hide("waiting-for-explorer"); return; }
        NativeTaskbar.SetThreadDpiAwarenessContext(NativeTaskbar.GetWindowDpiAwarenessContext(bar));
        if (bar != shell || currentDpi != NativeTaskbar.GetDpiForWindow(bar) || meter == null || !meter.IsHandleCreated || !NativeTaskbar.IsWindow(meter.Handle)) {
            if (meter != null) meter.Dispose();
            shell=bar; occupied=null; scannedAt=DateTime.MinValue; nextScan=DateTime.MinValue;
            currentDpi=NativeTaskbar.GetDpiForWindow(bar);
            float scale=currentDpi/96f;
            meter=new MeterControl(bar,scale);
            var handle=meter.Handle;
            if (NativeTaskbar.GetParent(handle)!=bar || (NativeTaskbar.GetWindowLong(handle,-16)&0x40000000)==0) {
                meter.Dispose(); meter=null; Status("attach-failed"); return;
            }
            meter.SetData(data);
        }
        meter.RefreshTheme();
        if (scan != null && scan.IsCompleted) {
            if (scan.Status == TaskStatus.RanToCompletion && scanShell == shell) { occupied=scan.Result; scannedAt=DateTime.UtcNow; }
            else { var ignored=scan.Exception; occupied=null; }
            scan=null;
        }
        if (scan == null && DateTime.UtcNow >= nextScan) {
            scanShell=shell; var target=shell;
            scan=Task.Run(() => ScanButtons(target)); nextScan=DateTime.UtcNow.AddSeconds(2);
        }
        NativeTaskbar.Rect b,t,client;
        IntPtr tray=NativeTaskbar.FindWindowEx(bar,IntPtr.Zero,"TrayNotifyWnd",null);
        if (!NativeTaskbar.IsWindowVisible(bar) || !NativeTaskbar.GetWindowRect(bar,out b) || !NativeTaskbar.GetWindowRect(tray,out t) || !NativeTaskbar.GetClientRect(bar,out client)) { Hide("taskbar-hidden"); return; }
        if (occupied == null || DateTime.UtcNow-scannedAt > TimeSpan.FromSeconds(8)) { Hide("waiting-for-layout"); return; }
        // Never extend the desktop work area or resize Explorer's own controls.
        float dpi=NativeTaskbar.GetDpiForWindow(bar)/96f;
        int width=(int)Math.Round(MeterLayout.Width*dpi), height=Math.Min((int)Math.Round(MeterLayout.Height*dpi),client.Bottom-4);
        var slot=FindSlot(b.Bounds,t.Bounds,occupied,width,height,(int)Math.Ceiling(6*dpi));
        if (slot.IsEmpty) { Hide("no-free-space"); return; }
        // HWND_TOP is sibling order within Shell_TrayWnd, NOT HWND_TOPMOST.
        NativeTaskbar.Rect previous;
        if (!NativeTaskbar.GetWindowRect(meter.Handle,out previous) || previous.Bounds != slot || !NativeTaskbar.IsWindowVisible(meter.Handle)) {
            if (!NativeTaskbar.SetWindowPos(meter.Handle,IntPtr.Zero,slot.X-b.Left,slot.Y-b.Top,slot.Width,slot.Height,0x0010|0x0040)) { Hide("position-failed"); return; }
        }
        meter.Present();
        Status(meter.PresentedFrames > 0 ? "embedded" : "waiting-for-surface");
    }
    protected override void ExitThreadCore() {
        stopped=true; timer.Stop(); timer.Dispose();
        if (meter != null) meter.Dispose(); dispatcher.Dispose(); owner.Dispose();
        base.ExitThreadCore();
    }
}

internal static class TaskbarProgram {
    [STAThread] private static int Main(string[] args) {
        try {
            Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TaskbarHost(int.Parse(args[0]))); return 0;
        } catch (Exception error) { NativeTaskbar.Send(new { type="error",message=error.Message }); return 1; }
    }
}
