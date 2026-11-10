using System.Drawing;
using System.Drawing.Drawing2D;

namespace Duckling.Shell;

/// <summary>The large Home pill over the top-right corner while an app is in front (a Duckling app or another app).
/// One tap leaves the app and returns to the home screen. It never takes focus from the app under it, and touch is
/// read as pointer input so a finger that drifts during the tap still counts. From the Surface home screen.</summary>
public class HomePill : Form
{
    readonly Action onHome;
    bool down, pointerDown;
    float scale = 1f;

    public HomePill(Action onHome)
    {
        this.onHome = onHome;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(36, 36, 56);
        DoubleBuffered = true;
        Cursor = Cursors.Hand;
        AccessibleName = "Home";
        AccessibleRole = AccessibleRole.PushButton;
    }

    int S(int v) => (int)(v * scale);
    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get { var cp = base.CreateParams; cp.ExStyle |= 0x08000000 | 0x80; return cp; }   // WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW
    }

    void Place(Rectangle screen)
    {
        scale = DeviceDpi / 96f;
        int w = S(176), h = S(56);
        var want = new Rectangle(screen.Right - w - S(8), screen.Top + S(6), w, h);
        if (Bounds == want && Region != null) return;
        Bounds = want;
        using var path = Rounded(new Rectangle(0, 0, w, h), h / 2);
        Region = new Region(path);
    }

    /// <summary>Shown over the app in front and re-asserted on every check, since an app that makes itself topmost
    /// would otherwise bury it.</summary>
    public void Pin(Rectangle screen)
    {
        Place(screen);
        if (!Visible) Show();
        Native.SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    }

    const int WM_POINTERDOWN = 0x0246, WM_POINTERUP = 0x0247, WM_POINTERCAPTURECHANGED = 0x024C, WM_MOUSEACTIVATE = 0x0021;

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            case WM_MOUSEACTIVATE: m.Result = new IntPtr(3); return;
            case WM_POINTERDOWN: pointerDown = true; down = true; Invalidate(); m.Result = IntPtr.Zero; return;
            case WM_POINTERUP:
            {
                bool hit = pointerDown && Hit(m.LParam);
                pointerDown = false; down = false; Invalidate(); m.Result = IntPtr.Zero;
                if (hit) onHome();
                return;
            }
            case WM_POINTERCAPTURECHANGED: pointerDown = false; down = false; Invalidate(); break;
        }
        base.WndProc(ref m);
    }

    bool Hit(IntPtr lParam)
    {
        int v = unchecked((int)lParam.ToInt64());
        var pt = new Point((short)(v & 0xFFFF), (short)((v >> 16) & 0xFFFF));
        var r = Bounds; r.Inflate(S(24), S(24));
        return r.Contains(pt);
    }

    static GraphicsPath Rounded(Rectangle r, int radius)
    {
        var path = new GraphicsPath(); int d = radius * 2;
        path.AddArc(r.X, r.Y, d, d, 180, 90); path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure(); return path;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.Clear(down ? Color.FromArgb(92, 92, 140) : Color.FromArgb(36, 36, 56));
        using (var path = Rounded(new Rectangle(S(1), S(1), Width - S(3), Height - S(3)), (Height - S(3)) / 2))
        using (var edge = new Pen(Color.FromArgb(200, 255, 255, 255), S(2)))
            g.DrawPath(edge, path);
        int cx = S(34), cy = Height / 2, r = S(12);
        using (var pen = new Pen(Color.White, S(3)) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round })
        {
            g.DrawLines(pen, new[] { new Point(cx - r, cy), new Point(cx, cy - r), new Point(cx + r, cy) });
            g.DrawRectangle(pen, cx - r + S(4), cy, 2 * r - S(8), r);
        }
        using var f = new Font("Segoe UI", 15f, FontStyle.Bold);
        TextRenderer.DrawText(g, "Home", f, new Rectangle(S(58), 0, Width - S(58), Height), Color.White, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
    }

    protected override void OnMouseDown(MouseEventArgs e) { down = true; Invalidate(); }
    protected override void OnMouseUp(MouseEventArgs e)
    {
        bool hit = down && ClientRectangle.Contains(e.Location);
        down = false; Invalidate();
        if (hit) onHome();
    }
}
