# Native region picker for the Windows Host half.
#
# One borderless, always-on-top window is placed on every display and shows that
# display's frozen capture at its physical size, so the selection happens on the
# real screen - the way a desktop chat app's screenshot tool behaves - instead of
# inside the Harness page. Drag to select, Enter or double-click to accept, Esc,
# a right click, or the Cancel button to discard. The confirmed region is cropped
# from the frozen bitmap at native pixels and written as PNG.
#
# Contract with the Host half:
#   -Config <json>  { output, result, labels: { hint, cancel, confirm } }
#   -Demo <ms>      test hook: accept a centered region after ms, no user input
#   -CompileOnly    compile the C# and exit (fast syntax check)
# Prints one line: __DSH_PICK__<result json>
#
# The C# source stays ASCII: localized labels arrive through the JSON config, so
# the script survives any console code page when loaded with -File.
param(
  [Parameter(Mandatory = $true)][string]$Config,
  [int]$Demo = 0,
  [switch]$CompileOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$signature = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public static class DshScreenPicker
{
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }
    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);

    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    public sealed class Display
    {
        public int Index;
        public int X;
        public int Y;
        public int Width;
        public int Height;
        public bool Primary;
        public bool Cursor;
        public Bitmap Image;
    }

    public static string Run(string outputPath, string resultPath, string hint, string cancelText, string confirmText, int demoMs)
    {
        try
        {
            MakeDpiAware();
            Display[] displays = CaptureAll();
            if (displays.Length == 0) return Failure("no display is available");

            Session session = new Session(outputPath, resultPath);
            int focus = 0;
            for (int i = 0; i < displays.Length; i++) if (displays[i].Cursor) focus = i;

            List<OverlayForm> forms = new List<OverlayForm>();
            for (int i = 0; i < displays.Length; i++)
            {
                OverlayForm form = new OverlayForm(displays[i], session, hint, cancelText, confirmText);
                form.SilentShow = i != focus;
                forms.Add(form);
            }
            session.Forms = forms;
            if (demoMs > 0) forms[focus].ScheduleDemo(demoMs);
            for (int i = 0; i < forms.Count; i++) if (i != focus) forms[i].Show();

            if (!session.Done) Application.Run(forms[focus]);
            for (int i = 0; i < forms.Count; i++)
            {
                try { forms[i].ReleaseImage(); } catch { }
            }
            return session.Done && session.Result != null ? session.Result : "{\"cancelled\":true}";
        }
        catch (Exception error)
        {
            return Failure(error.Message);
        }
    }

    static void MakeDpiAware()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-3))) return; } catch { }
        try { if (SetProcessDpiAwareness(2) == 0) return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    static Display[] CaptureAll()
    {
        List<Display> list = new List<Display>();
        MonitorEnumProc proc = delegate(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data)
        {
            MONITORINFOEX info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            if (GetMonitorInfo(monitor, ref info))
            {
                Display display = new Display();
                display.X = info.rcMonitor.Left;
                display.Y = info.rcMonitor.Top;
                display.Width = info.rcMonitor.Right - info.rcMonitor.Left;
                display.Height = info.rcMonitor.Bottom - info.rcMonitor.Top;
                display.Primary = (info.dwFlags & 1) == 1;
                list.Add(display);
            }
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero);
        if (list.Count == 0) return new Display[0];

        list.Sort(delegate(Display a, Display b)
        {
            int byX = a.X.CompareTo(b.X);
            return byX != 0 ? byX : a.Y.CompareTo(b.Y);
        });

        POINT cursor;
        bool hasCursor = GetCursorPos(out cursor);
        for (int i = 0; i < list.Count; i++)
        {
            Display display = list[i];
            display.Index = i;
            if (hasCursor &&
                cursor.X >= display.X && cursor.X < display.X + display.Width &&
                cursor.Y >= display.Y && cursor.Y < display.Y + display.Height) display.Cursor = true;

            Bitmap bitmap = new Bitmap(display.Width, display.Height);
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(display.X, display.Y, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
            }
            display.Image = bitmap;
        }
        bool anyCursor = false;
        for (int i = 0; i < list.Count; i++) if (list[i].Cursor) anyCursor = true;
        if (!anyCursor) list[0].Cursor = true;
        return list.ToArray();
    }

    public static string Failure(string message)
    {
        return "{\"error\":" + Quote(message) + "}";
    }

    public static string Quote(string text)
    {
        if (text == null) return "null";
        StringBuilder builder = new StringBuilder(text.Length + 8);
        builder.Append('"');
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (c == '"' || c == '\\') builder.Append('\\').Append(c);
            else if (c == '\n') builder.Append("\\n");
            else if (c == '\r') builder.Append("\\r");
            else if (c == '\t') builder.Append("\\t");
            else if (c < ' ') builder.Append(' ');
            else builder.Append(c);
        }
        builder.Append('"');
        return builder.ToString();
    }

    public sealed class Session
    {
        readonly string outputPath;
        readonly string resultPath;
        public List<OverlayForm> Forms = new List<OverlayForm>();
        public bool Done;
        public string Result;

        public Session(string output, string result)
        {
            outputPath = output;
            resultPath = result;
        }

        public void Cancel()
        {
            if (Done) return;
            Done = true;
            Result = "{\"cancelled\":true}";
            Persist();
            CloseAll();
        }

        public void Confirm(OverlayForm form)
        {
            if (Done) return;
            Rectangle source = form.SourceRegion();
            if (source.Width < 1 || source.Height < 1) return;
            try
            {
                using (Bitmap crop = form.Snapshot.Clone(source, PixelFormat.Format32bppArgb))
                {
                    crop.Save(outputPath, ImageFormat.Png);
                }
            }
            catch (Exception error)
            {
                Done = true;
                Result = Failure(error.Message);
                Persist();
                CloseAll();
                return;
            }
            Done = true;
            StringBuilder text = new StringBuilder(160);
            text.Append("{\"cancelled\":false");
            text.Append(",\"file\":").Append(Quote(outputPath));
            text.Append(",\"width\":").Append(source.Width);
            text.Append(",\"height\":").Append(source.Height);
            text.Append(",\"display\":").Append(form.DisplayIndex);
            text.Append(",\"x\":").Append(source.X);
            text.Append(",\"y\":").Append(source.Y);
            text.Append('}');
            Result = text.ToString();
            Persist();
            CloseAll();
        }

        void Persist()
        {
            try { File.WriteAllText(resultPath, Result, new UTF8Encoding(false)); } catch { }
        }

        void CloseAll()
        {
            for (int i = 0; i < Forms.Count; i++)
            {
                try { Forms[i].Hide(); Forms[i].Close(); } catch { }
            }
            Application.Exit();
        }
    }

    public sealed class OverlayForm : Form
    {
        public readonly Bitmap Snapshot;
        public readonly int DisplayIndex;
        public bool SilentShow;

        const int MinimumRegion = 4;
        readonly Session session;
        readonly string hintText;
        readonly string cancelText;
        readonly string confirmText;
        readonly Font font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular, GraphicsUnit.Point);

        Rectangle region = Rectangle.Empty;
        Point anchor;
        bool dragging;
        Rectangle barRect = Rectangle.Empty;
        Rectangle cancelRect = Rectangle.Empty;
        Rectangle confirmRect = Rectangle.Empty;
        int hover;
        bool hintFits;

        public OverlayForm(Display display, Session session, string hint, string cancel, string confirm)
        {
            Snapshot = display.Image;
            DisplayIndex = display.Index;
            this.session = session;
            hintText = hint == null ? "" : hint;
            cancelText = cancel == null ? "" : cancel;
            confirmText = confirm == null ? "" : confirm;

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            TopMost = true;
            BackColor = Color.Black;
            DoubleBuffered = true;
            KeyPreview = true;
            Cursor = Cursors.Cross;
            Text = "dsh-screenshot-overlay";
            Bounds = new Rectangle(display.X, display.Y, display.Width, display.Height);
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        }

        protected override bool ShowWithoutActivation
        {
            get { return SilentShow; }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            SetWindowPos(Handle, new IntPtr(-1), Bounds.X, Bounds.Y, Bounds.Width, Bounds.Height, 0x0040);
            Invalidate();
        }

        public void ReleaseImage()
        {
            if (Snapshot != null) Snapshot.Dispose();
            font.Dispose();
        }

        public bool HasRegion
        {
            get { return region.Width >= MinimumRegion && region.Height >= MinimumRegion; }
        }

        public Rectangle SourceRegion()
        {
            if (!HasRegion) return Rectangle.Empty;
            double scaleX = (double)Snapshot.Width / Math.Max(1, ClientSize.Width);
            double scaleY = (double)Snapshot.Height / Math.Max(1, ClientSize.Height);
            int x = (int)Math.Round(region.X * scaleX);
            int y = (int)Math.Round(region.Y * scaleY);
            int width = (int)Math.Round(region.Width * scaleX);
            int height = (int)Math.Round(region.Height * scaleY);
            x = Math.Max(0, Math.Min(Snapshot.Width - 1, x));
            y = Math.Max(0, Math.Min(Snapshot.Height - 1, y));
            width = Math.Max(1, Math.Min(Snapshot.Width - x, width));
            height = Math.Max(1, Math.Min(Snapshot.Height - y, height));
            return new Rectangle(x, y, width, height);
        }

        public void ScheduleDemo(int delayMs)
        {
            Timer timer = new Timer();
            timer.Interval = Math.Max(200, delayMs);
            timer.Tick += delegate(object sender, EventArgs args)
            {
                timer.Stop();
                timer.Dispose();
                int width = Math.Min(480, Math.Max(80, ClientSize.Width - 200));
                int height = Math.Min(320, Math.Max(80, ClientSize.Height - 200));
                region = new Rectangle((ClientSize.Width - width) / 2, (ClientSize.Height - height) / 2, width, height);
                Invalidate();
                Update();
                System.Threading.Thread.Sleep(900);
                session.Confirm(this);
            };
            timer.Start();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(Snapshot, new Rectangle(0, 0, ClientSize.Width, ClientSize.Height));
            using (SolidBrush dim = new SolidBrush(Color.FromArgb(118, 0, 0, 0)))
            {
                g.FillRectangle(dim, ClientRectangle);
            }
            if (HasRegion)
            {
                Rectangle source = SourceRegion();
                g.DrawImage(Snapshot, region, source, GraphicsUnit.Pixel);
                using (Pen border = new Pen(Color.FromArgb(77, 107, 254), 1f))
                {
                    g.DrawRectangle(border, region.X, region.Y, Math.Max(1, region.Width - 1), Math.Max(1, region.Height - 1));
                }
                DrawSizeBadge(g, source);
            }
            DrawBar(g);
        }

        void DrawSizeBadge(Graphics g, Rectangle source)
        {
            string label = source.Width.ToString() + " " + (char)0x00D7 + " " + source.Height.ToString();
            Size text = TextRenderer.MeasureText(label, font);
            int width = text.Width + 12;
            int height = text.Height + 4;
            int left = region.X;
            int top = region.Y - height - 6;
            if (top < 6) top = Math.Min(ClientSize.Height - height - 6, region.Bottom + 6);
            if (left + width > ClientSize.Width - 6) left = ClientSize.Width - width - 6;
            if (left < 6) left = 6;
            using (GraphicsPath path = Rounded(new Rectangle(left, top, width, height), 4))
            using (SolidBrush fill = new SolidBrush(Color.FromArgb(214, 24, 26, 30)))
            {
                g.FillPath(fill, path);
            }
            TextRenderer.DrawText(g, label, font, new Rectangle(left, top, width, height), Color.White,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }

        void LayoutBar()
        {
            int barHeight = 44;
            int padding = 12;
            int gap = 8;
            int cancelWidth = Math.Max(56, TextRenderer.MeasureText(cancelText, font).Width + 24);
            int confirmWidth = Math.Max(56, TextRenderer.MeasureText(confirmText, font).Width + 24);
            int hintWidth = hintText.Length == 0 ? 0 : TextRenderer.MeasureText(hintText, font).Width;
            int available = ClientSize.Width - 32;
            int content = padding * 2 + cancelWidth + gap + confirmWidth;
            hintFits = hintWidth > 0 && content + hintWidth + gap * 2 <= available;
            if (hintFits) content += hintWidth + gap * 2;
            int width = Math.Min(available, content);
            int left = (ClientSize.Width - width) / 2;
            int top = ClientSize.Height - barHeight - 28;
            barRect = new Rectangle(left, top, width, barHeight);
            confirmRect = new Rectangle(barRect.Right - padding - confirmWidth, barRect.Y + (barHeight - 28) / 2, confirmWidth, 28);
            cancelRect = new Rectangle(confirmRect.X - gap - cancelWidth, confirmRect.Y, cancelWidth, 28);
        }

        void DrawBar(Graphics g)
        {
            LayoutBar();
            using (GraphicsPath shadow = Rounded(new Rectangle(barRect.X, barRect.Y + 3, barRect.Width, barRect.Height), 12))
            using (SolidBrush shadowFill = new SolidBrush(Color.FromArgb(46, 0, 0, 0)))
            {
                g.FillPath(shadowFill, shadow);
            }
            using (GraphicsPath path = Rounded(barRect, 12))
            using (SolidBrush fill = new SolidBrush(Color.FromArgb(248, 250, 251, 253)))
            {
                g.FillPath(fill, path);
            }
            if (hintFits)
            {
                Rectangle hintBounds = new Rectangle(cancelRect.X - 8 - TextRenderer.MeasureText(hintText, font).Width - 4, barRect.Y,
                    TextRenderer.MeasureText(hintText, font).Width + 8, barRect.Height);
                TextRenderer.DrawText(g, hintText, font, hintBounds, Color.FromArgb(96, 98, 104),
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Right | TextFormatFlags.NoPadding);
            }
            DrawButton(g, cancelRect, cancelText, hover == 1, false, true);
            DrawButton(g, confirmRect, confirmText, hover == 2, true, HasRegion);
        }

        void DrawButton(Graphics g, Rectangle bounds, string label, bool hovered, bool primary, bool enabled)
        {
            Color fill;
            Color text;
            if (primary)
            {
                fill = enabled ? (hovered ? Color.FromArgb(66, 96, 250) : Color.FromArgb(77, 107, 254)) : Color.FromArgb(229, 231, 235);
                text = enabled ? Color.White : Color.FromArgb(154, 160, 166);
            }
            else
            {
                fill = hovered ? Color.FromArgb(226, 229, 234) : Color.FromArgb(240, 241, 245);
                text = Color.FromArgb(31, 35, 41);
            }
            using (GraphicsPath path = Rounded(bounds, 8))
            using (SolidBrush brush = new SolidBrush(fill))
            {
                g.FillPath(brush, path);
            }
            TextRenderer.DrawText(g, label, font, bounds, text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }

        static GraphicsPath Rounded(Rectangle bounds, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int size = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
            if (size <= 0)
            {
                path.AddRectangle(bounds);
                return path;
            }
            path.AddArc(bounds.X, bounds.Y, size, size, 180, 90);
            path.AddArc(bounds.Right - size, bounds.Y, size, size, 270, 90);
            path.AddArc(bounds.Right - size, bounds.Bottom - size, size, size, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - size, size, size, 90, 90);
            path.CloseFigure();
            return path;
        }

        Point ClampToClient(Point point)
        {
            return new Point(
                Math.Max(0, Math.Min(ClientSize.Width - 1, point.X)),
                Math.Max(0, Math.Min(ClientSize.Height - 1, point.Y)));
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Right)
            {
                session.Cancel();
                return;
            }
            if (e.Button != MouseButtons.Left) return;
            if (cancelRect.Contains(e.Location))
            {
                session.Cancel();
                return;
            }
            if (confirmRect.Contains(e.Location))
            {
                if (HasRegion) session.Confirm(this);
                return;
            }
            if (barRect.Contains(e.Location)) return;

            for (int i = 0; i < session.Forms.Count; i++)
            {
                if (session.Forms[i] != this) session.Forms[i].ClearRegion();
            }
            dragging = true;
            anchor = ClampToClient(e.Location);
            region = new Rectangle(anchor.X, anchor.Y, 0, 0);
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (dragging)
            {
                Point point = ClampToClient(e.Location);
                region = new Rectangle(
                    Math.Min(anchor.X, point.X),
                    Math.Min(anchor.Y, point.Y),
                    Math.Abs(point.X - anchor.X),
                    Math.Abs(point.Y - anchor.Y));
                Invalidate();
                return;
            }
            int next = cancelRect.Contains(e.Location) ? 1 : confirmRect.Contains(e.Location) ? 2 : 0;
            if (next != hover)
            {
                hover = next;
                Cursor = next == 0 ? Cursors.Cross : Cursors.Hand;
                Invalidate();
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (!dragging) return;
            dragging = false;
            if (!HasRegion) region = Rectangle.Empty;
            Invalidate();
        }

        protected override void OnMouseDoubleClick(MouseEventArgs e)
        {
            base.OnMouseDoubleClick(e);
            if (HasRegion) session.Confirm(this);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape)
            {
                e.Handled = true;
                session.Cancel();
                return;
            }
            if (e.KeyCode == Keys.Enter)
            {
                e.Handled = true;
                if (HasRegion) session.Confirm(this);
            }
        }

        public void ClearRegion()
        {
            if (region.IsEmpty) return;
            region = Rectangle.Empty;
            Invalidate();
        }
    }
}
'@

Add-Type -TypeDefinition $signature -ReferencedAssemblies System.dll, System.Core.dll, System.Drawing.dll, System.Windows.Forms.dll

if ($CompileOnly) {
  [Console]::Out.WriteLine('__DSH_PICK__{"cancelled":true,"compiled":true}')
  exit 0
}

$settings = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$labels = $settings.labels
$hint = if ($null -ne $labels -and $null -ne $labels.hint) { [string]$labels.hint } else { '' }
$cancel = if ($null -ne $labels -and $null -ne $labels.cancel) { [string]$labels.cancel } else { 'Cancel' }
$confirm = if ($null -ne $labels -and $null -ne $labels.confirm) { [string]$labels.confirm } else { 'Done' }

$json = [DshScreenPicker]::Run([string]$settings.output, [string]$settings.result, $hint, $cancel, $confirm, $Demo)
[Console]::Out.WriteLine('__DSH_PICK__' + $json)
exit 0
