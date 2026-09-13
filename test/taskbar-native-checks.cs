using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.Windows.Forms;

internal static class TaskbarNativeChecks {
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd,uint command);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd,StringBuilder name,int length);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(NativeTaskbar.Point point);
    private static void CaptureDesktop(string path) {
        IntPtr bar=NativeTaskbar.FindWindow("Shell_TrayWnd",null);
        Check(bar!=IntPtr.Zero,"Desktop taskbar unavailable");
        NativeTaskbar.SetThreadDpiAwarenessContext(NativeTaskbar.GetWindowDpiAwarenessContext(bar));
        NativeTaskbar.Rect bounds; NativeTaskbar.GetWindowRect(bar,out bounds);
        for (IntPtr child=GetWindow(bar,5);child!=IntPtr.Zero;child=GetWindow(child,2)) {
            var cls=new StringBuilder(256); GetClassName(child,cls,256);
            NativeTaskbar.Rect r; NativeTaskbar.GetWindowRect(child,out r);
            NativeTaskbar.Send(new { hwnd=child.ToInt64(), cls=cls.ToString(),visible=NativeTaskbar.IsWindowVisible(child),x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top,
                hit=WindowFromPoint(new NativeTaskbar.Point(r.Left+85,r.Top+12)).ToInt64() });
        }
        var capture=new Rectangle(Math.Max(bounds.Left,bounds.Right-1600),bounds.Top,Math.Min(1600,bounds.Right-bounds.Left),bounds.Bottom-bounds.Top);
        using (var bitmap=new Bitmap(capture.Width,capture.Height)) using (var g=Graphics.FromImage(bitmap)) {
            g.CopyFromScreen(capture.Location,Point.Empty,capture.Size);
            bitmap.Save(path,ImageFormat.Png);
        }
    }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static int TrackSpan(Bitmap surface, int y) {
        int left = -1, right = -1;
        for (int x = 0; x < surface.Width; x++) {
            var p = surface.GetPixel(x, y);
            bool gray = p.A > 180 && Math.Abs(p.R - p.G) < 12 && Math.Abs(p.G - p.B) < 12 && p.R >= 70 && p.R <= 220;
            bool fill = p.A > 180 && (p.B > p.R + 15 || (p.R > 170 && p.G < 160 && p.B < 100) || (p.R > 180 && p.G > 100 && p.B < 80));
            if (gray || fill) { if (left < 0) left = x; right = x; }
        }
        return left < 0 ? 0 : right - left + 1;
    }
    private static bool HasYellow(Bitmap surface, int cx, int cy, int radius) {
        for (int y = cy - radius; y <= cy + radius; y++)
        for (int x = cx - radius; x <= cx + radius; x++) {
            if (x < 0 || y < 0 || x >= surface.Width || y >= surface.Height) continue;
            var p = surface.GetPixel(x, y);
            if (p.A > 80 && p.R > 180 && p.G > 120 && p.B < 90) return true;
        }
        return false;
    }
    [STAThread] private static void Main(string[] args) {
        if (args[0]=="--desktop") { CaptureDesktop(args[1]); return; }
        var bar=new Rectangle(-1920,1032,1920,48); var tray=new Rectangle(-240,1032,240,48);
        var slot=TaskbarHost.FindSlot(bar,tray,new List<Rectangle>(),MeterLayout.Width,MeterLayout.Height,6);
        Check(slot == new Rectangle(-240-6-MeterLayout.Width,1034,MeterLayout.Width,MeterLayout.Height),"Negative monitor coordinates");
        var buttons=new List<Rectangle> { new Rectangle(-570,1032,120,48) };
        slot=TaskbarHost.FindSlot(bar,tray,buttons,MeterLayout.Width,MeterLayout.Height,6);
        Check(slot.Right <= -576 && !slot.IntersectsWith(buttons[0]),"Never overlap task buttons");
        Check(TaskbarHost.FindSlot(new Rectangle(0,0,300,48),new Rectangle(100,0,200,48),buttons,MeterLayout.Width,MeterLayout.Height,6).IsEmpty,"Hide when there is no space");
        Check(TaskbarHost.FindSlot(new Rectangle(0,0,48,1080),new Rectangle(0,900,48,180),buttons,MeterLayout.Width,MeterLayout.Height,6).IsEmpty,"Reject vertical taskbar");
        Check(TaskbarHost.FindSlot(new Rectangle(0,0,1920,2),new Rectangle(1600,0,320,2),buttons,MeterLayout.Width,MeterLayout.Height,6).IsEmpty,"Reject too-small taskbar");
        using (var parent=new Form()) using (var meter=new MeterControl(parent.Handle,1.5f)) {
            parent.Location=new Point(120,180);
            var handle=meter.Handle;
            Check(NativeTaskbar.GetParent(handle)==parent.Handle,"Real child parent");
            Check((NativeTaskbar.GetWindowLong(handle,-16)&0x40000000)!=0,"WS_CHILD required");
            Check((NativeTaskbar.GetWindowLong(handle,-16)&unchecked((int)0x80000000))==0,"WS_POPUP forbidden");
            Check((NativeTaskbar.GetWindowLong(handle,-20)&8)==0,"Topmost forbidden");
            meter.Size=new Size((int)(MeterLayout.Width*1.5f),(int)(MeterLayout.Height*1.5f));
            meter.SetData(new QuotaData { rows=new[] {
                new QuotaRow {label="Cursor",meters=new[]{new QuotaMeter {label="模型",value=82.5,remainingCents=114514.4,pace=70}}},
                new QuotaRow {label="三方",meters=new[]{new QuotaMeter {label="三方",value=12,remainingCents=180,pace=70}}},
                new QuotaRow {label="Codex",meters=new[]{new QuotaMeter {label="周",value=61,remainingCents=19203.41,pace=50},new QuotaMeter {label="5h",value=8,remainingCents=371.84,pace=30}}},
            }});
            // No Show(), message pump or WM_PAINT: initial native composition
            // must be submitted explicitly, even when Explorer owns visibility.
            NativeTaskbar.Rect beforePaint,afterPaint;
            NativeTaskbar.GetWindowRect(handle,out beforePaint);
            meter.Present();
            NativeTaskbar.GetWindowRect(handle,out afterPaint);
            Check(meter.AccessibleDescription.Contains("余$1145.14"),"Remaining dollars use two decimal places");
            Check(meter.AccessibleDescription.Contains("匀速应余 70%"),"Pace is exposed to the tooltip");
            Check(beforePaint.Bounds==afterPaint.Bounds,"Surface upload must not add the parent's offset or move the child");
            Check(meter.PresentedFrames==1,"Initial layered surface was not submitted");
            meter.Present();
            Check(meter.PresentedFrames==1,"Unchanged surface should not be uploaded again");
            var wndProc=typeof(MeterControl).GetMethod("WndProc",BindingFlags.NonPublic|BindingFlags.Instance);
            for (int i=0;i<100;i++) {
                var message=Message.Create(handle,0x0F,IntPtr.Zero,IntPtr.Zero);
                wndProc.Invoke(meter,new object[]{message});
                typeof(Control).GetMethod("OnMouseEnter",BindingFlags.NonPublic|BindingFlags.Instance).Invoke(meter,new object[]{EventArgs.Empty});
                typeof(Control).GetMethod("OnMouseLeave",BindingFlags.NonPublic|BindingFlags.Instance).Invoke(meter,new object[]{EventArgs.Empty});
            }
            Check(meter.PresentedFrames==1,"Paint/enter/leave storms must not resubmit the surface");
            var output=Console.Out;
            using (var protocol=new StringWriter()) {
                try {
                    Console.SetOut(protocol);
                    typeof(Control).GetMethod("OnClick",BindingFlags.NonPublic|BindingFlags.Instance).Invoke(meter,new object[]{EventArgs.Empty});
                    Check(protocol.ToString()=="","Single click must not open details");
                    var doubleClick=typeof(MeterControl).GetMethod("OnMouseDoubleClick",BindingFlags.NonPublic|BindingFlags.Instance);
                    doubleClick.Invoke(meter,new object[]{new MouseEventArgs(MouseButtons.Left,2,10,10,0)});
                    doubleClick.Invoke(meter,new object[]{new MouseEventArgs(MouseButtons.Right,2,10,10,0)});
                    typeof(MeterControl).GetMethod("OnMouseUp",BindingFlags.NonPublic|BindingFlags.Instance).Invoke(meter,new object[]{new MouseEventArgs(MouseButtons.Right,1,10,10,0)});
                    var lines=protocol.ToString().Split(new[]{'\r','\n'},StringSplitOptions.RemoveEmptyEntries);
                    Check(lines.Length==2 && lines[0].Contains("open") && lines[1].Contains("menu") && lines[1].Contains("\"x\"") && lines[1].Contains("\"y\""),"Double-left opens once; right-up sends screen coordinates for the menu");
                } finally { Console.SetOut(output); }
            }
            float scale=1.5f; int surfaceWidth=(int)(MeterLayout.Width*scale), surfaceHeight=(int)(MeterLayout.Height*scale);
            float rowHeight=(surfaceHeight-4*scale)/3f;
            var cursorBar=MeterLayout.Bar(MeterLayout.MeterLeft*scale,2*scale,MeterLayout.Segment(surfaceWidth,1,scale),rowHeight,scale);
            var otherBar=MeterLayout.Bar(MeterLayout.MeterLeft*scale,2*scale+rowHeight,MeterLayout.Segment(surfaceWidth,1,scale),rowHeight,scale);
            Check(Math.Abs(cursorBar.Width-otherBar.Width)<0.01f,"Cursor and third-party tracks share one reserved value column");
            using (var image=new Bitmap(surfaceWidth+40,192,PixelFormat.Format32bppPArgb)) using (var graphics=Graphics.FromImage(image)) {
                graphics.Clear(Color.FromArgb(115,115,115));
                for (int i=0;i<2;i++) {
                    bool light=i==1;
                    typeof(MeterControl).GetField("light",BindingFlags.NonPublic|BindingFlags.Instance).SetValue(meter,light);
                    using (var surface=new Bitmap(surfaceWidth,surfaceHeight,PixelFormat.Format32bppPArgb)) using (var g=Graphics.FromImage(surface)) {
                        meter.Render(g);
                        Check(surface.GetPixel(0,0).A <= 1,"Background must preserve taskbar acrylic");
                        int trackY=(int)(cursorBar.Y+cursorBar.Height/2);
                        Check(Math.Abs(TrackSpan(surface,trackY)-TrackSpan(surface,(int)(otherBar.Y+otherBar.Height/2)))<=2,"Rendered tracks stay the same length when right-side text differs");
                        Check(HasYellow(surface,(int)(cursorBar.X+cursorBar.Width*0.7f),(int)(cursorBar.Bottom+2*scale),4),"Pace arrow marks the even-spend remainder");
                        using (var brush=new SolidBrush(light ? Color.FromArgb(243,243,243) : Color.FromArgb(36,36,36))) graphics.FillRectangle(brush,0,i*96,surfaceWidth+40,96);
                        graphics.DrawImageUnscaled(surface,20,i*96+15);
                    }
                }
                image.Save(args[0],ImageFormat.Png);
            }
        }
        Console.WriteLine("Native layout, child styles and transparent dark/light rendering passed.");
    }
}
