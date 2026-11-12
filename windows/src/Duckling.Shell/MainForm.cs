using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Duckling.Shell;

/// <summary>The home screen: app.ducklingtablet.com in WebView2, with window.DucklingShell. Full screen and not
/// closable in the child's account; a normal window in a parent's account during setup.</summary>
public class MainForm : Form
{
    public readonly WebView2 Web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 253, 246) };
    public readonly ServiceClient Service = new();
    public CoreWebView2Environment? Env;
    public readonly string WebAppUrl;
    public readonly string WebOrigin;
    public volatile IReadOnlyCollection<string> AllowedHosts = Array.Empty<string>();
    public readonly bool ChildSession;
    public readonly AppCloser Closer;
    readonly HomePill pill;
    readonly System.Windows.Forms.Timer pushTimer = new() { Interval = 5 * 60 * 1000 };
    readonly System.Windows.Forms.Timer frontTimer = new() { Interval = 400 };
    AppForm? appForm;
    bool onWebsite;
    ParentBrowser? parentBrowser;
    public static readonly string Version = typeof(MainForm).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    public MainForm(string webAppUrl, bool childSession)
    {
        WebAppUrl = webAppUrl;
        WebOrigin = new Uri(webAppUrl).GetLeftPart(UriPartial.Authority);
        ChildSession = childSession;
        Text = "Duckling Tablet";
        Icon = new System.Drawing.Icon(typeof(MainForm).Assembly.GetManifestResourceStream("Duckling.Shell.duckling.ico")!);
        BackColor = System.Drawing.Color.FromArgb(255, 253, 246);
        Controls.Add(Web);
        if (childSession) { FormBorderStyle = FormBorderStyle.None; WindowState = FormWindowState.Maximized; ShowInTaskbar = true; }
        else { WindowState = FormWindowState.Maximized; MinimumSize = new System.Drawing.Size(900, 640); }
        Closer = new AppCloser(() => new[] { Handle, pill?.Handle ?? IntPtr.Zero, appForm?.Handle ?? IntPtr.Zero, parentBrowser?.Handle ?? IntPtr.Zero });
        pill = new HomePill(GoHome);
        pushTimer.Tick += (_, _) => Js("window.DucklingWeb && DucklingWeb.onPush && DucklingWeb.onPush()");
        frontTimer.Tick += (_, _) => WatchFront();
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        try { await Init(); }
        catch (Exception ex)
        {
            ShellLog.Write($"init: {ex.GetType().Name}: {ex.Message}");
            MessageBox.Show(this, "Duckling could not start its web view. Restart the device, and if this keeps happening, reinstall Duckling.\n\n" + ex.Message, "Duckling Tablet");
        }
    }

    async Task Init()
    {
        var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Duckling", "WebView2");
        Env = await CoreWebView2Environment.CreateAsync(null, dataDir, new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required"));
        await Web.EnsureCoreWebView2Async(Env);
        var core = Web.CoreWebView2;
        Lock(core.Settings, childSession: ChildSession);
        core.Settings.UserAgent += $" DucklingTablet/{Version} Windows";
        try { AllowedHosts = Hosts.Normalize(JsonSerializer.Deserialize<string[]>(Service.Call("state")?["allowedHosts"]?.ToJsonString() ?? "[]") ?? Array.Empty<string>()); }
        catch (Exception) { }

        var bridge = new ShellBridge(this);
        core.AddHostObjectToScript("DucklingShell", bridge);
        await core.AddScriptToExecuteOnDocumentCreatedAsync(ShellBridge.Wrapper(WebOrigin));

        core.NavigationStarting += (_, ev) => { if (!Hosts.IsAllowedUri(ev.Uri, AllowedHosts) && !ev.Uri.StartsWith(WebOrigin, StringComparison.OrdinalIgnoreCase)) ev.Cancel = true; };
        core.FrameNavigationStarting += (_, ev) => { if (!Hosts.IsAllowedUri(ev.Uri, AllowedHosts) && !ev.Uri.StartsWith(WebOrigin, StringComparison.OrdinalIgnoreCase)) ev.Cancel = true; };
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, ev) =>
        {
            var uri = ev.Request.Uri;
            if (uri.StartsWith(WebOrigin, StringComparison.OrdinalIgnoreCase) || Hosts.IsAllowedUri(uri, AllowedHosts)) return;
            ev.Response = Env!.CreateWebResourceResponse(null, 403, "Blocked", "Content-Type: text/plain");
        };
        // A link that opens a new window opens here instead, if the site is allowed.
        core.NewWindowRequested += (_, ev) => { ev.Handled = true; if (Hosts.IsAllowedUri(ev.Uri, AllowedHosts)) core.Navigate(ev.Uri); };
        core.PermissionRequested += (_, ev) => ev.State = CoreWebView2PermissionState.Deny;   // apps run in the app runner
        core.DownloadStarting += (_, ev) => ev.Cancel = true;
        core.ProcessFailed += (_, ev) => { ShellLog.Write($"webview process failed: {ev.ProcessFailedKind}"); if (ev.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) BeginInvoke(() => Application.Restart()); else core.Reload(); };
        // A website from the allowlist opens in this view; the Home pill brings the child back to the home screen.
        core.SourceChanged += (_, _) => { onWebsite = !core.Source.StartsWith(WebOrigin, StringComparison.OrdinalIgnoreCase); if (onWebsite) frontTimer.Start(); };
        core.Navigate(WebAppUrl);
        pushTimer.Start();
    }

    public static void Lock(CoreWebView2Settings s, bool childSession)
    {
        s.AreDevToolsEnabled = !childSession && Environment.GetEnvironmentVariable("DUCKLING_DEVTOOLS") == "1";
        s.AreDefaultContextMenusEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsZoomControlEnabled = false;
        s.IsPinchZoomEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.AreDefaultScriptDialogsEnabled = true;
    }

    /// <summary>Runs script in the home screen from any thread.</summary>
    public void Js(string code)
    {
        if (IsDisposed) return;
        void Run() { try { _ = Web.CoreWebView2?.ExecuteScriptAsync(code); } catch (Exception) { } }
        if (InvokeRequired) BeginInvoke(Run); else Run();
    }
    public static string Q(string s) => JsonSerializer.Serialize(s);

    public bool CallerIsWebApp() => Web.CoreWebView2?.Source?.StartsWith(WebOrigin, StringComparison.OrdinalIgnoreCase) == true;

    // ---- Duckling apps
    public void OpenApp(string id, string[] permissions)
    {
        if (appForm != null && !appForm.IsDisposed) appForm.Close();
        appForm = new AppForm(this, id, permissions);
        appForm.FormClosed += (_, _) => { appForm = null; pill.Hide(); ComeToFront(); Js("window.DucklingWeb && DucklingWeb.onResume && DucklingWeb.onResume()"); };
        appForm.Show();
        frontTimer.Start();
    }

    // ---- Other apps: open for a number of seconds, then back to Duckling.
    string? otherId; DateTime otherStart; DateTime otherEnd;
    public void BeginOther(string id, string target, int seconds)
    {
        if (otherId != null) EndOther("replaced");
        int pid;
        try { pid = OtherApps.Launch(target); }
        catch (Exception ex) { ShellLog.Write($"launch failed: {ex.Message}"); Js($"window.DucklingWeb && DucklingWeb.onOtherApp && DucklingWeb.onOtherApp({Q(id)}, 0, 'failed')"); return; }
        if (pid > 0) Native.AllowSetForegroundWindow(pid);
        otherId = id; otherStart = DateTime.UtcNow; otherEnd = otherStart.AddSeconds(Math.Clamp(seconds, 10, 6 * 3600));
        frontTimer.Start();
    }

    public void EndOther(string reason)
    {
        var id = otherId;
        if (id == null) return;
        otherId = null;
        var secs = (int)(DateTime.UtcNow - otherStart).TotalSeconds;
        pill.Hide();
        Closer.CloseApps();
        var sweep = new System.Windows.Forms.Timer { Interval = 1500 };
        sweep.Tick += (_, _) => { sweep.Stop(); sweep.Dispose(); Closer.ForceCloseApps(); ComeToFront(); };
        sweep.Start();
        ComeToFront();
        Js($"window.DucklingWeb && DucklingWeb.onOtherApp && DucklingWeb.onOtherApp({Q(id)}, {secs}, {Q(reason)})");
    }

    /// <summary>The Home pill, or the screen turning off: leave whatever is in front.</summary>
    public void GoHome()
    {
        if (appForm != null && !appForm.IsDisposed) appForm.Close();
        if (otherId != null) EndOther("returned");
        if (onWebsite) { onWebsite = false; Web.CoreWebView2?.Navigate(WebAppUrl); }
        pill.Hide();
        ComeToFront();
    }

    void WatchFront()
    {
        if (otherId != null && DateTime.UtcNow >= otherEnd) { EndOther("timeup"); return; }
        if (otherId == null && (appForm == null || appForm.IsDisposed) && !onWebsite) { pill.Hide(); frontTimer.Stop(); return; }
        var fg = Native.GetForegroundWindow();
        Native.GetWindowThreadProcessId(fg, out var pid);
        var ours = pid == (uint)Environment.ProcessId;
        if (otherId != null && ours && fg == Handle) { EndOther("returned"); return; }
        // The pill shows over another app, and over a Duckling app (the app runner is ours, the pill sits on it).
        var showOver = otherId != null ? !ours : appForm != null || (onWebsite && ours);
        var cls = fg == IntPtr.Zero ? "" : Native.ClassOf(fg);
        if (cls is "Shell_TrayWnd" or "Shell_SecondaryTrayWnd" or "Progman" or "WorkerW") showOver = false;
        if (showOver) pill.Pin(Screen.FromHandle(fg == IntPtr.Zero ? Handle : fg).Bounds);
        else pill.Hide();
        // New windows of another app open maximized, like the Surface home screen did.
        if (otherId != null && !ours) MaximizeIfNew(fg);
    }

    readonly HashSet<IntPtr> seen = new();
    void MaximizeIfNew(IntPtr h)
    {
        if (h == IntPtr.Zero || seen.Contains(h) || !Native.IsWindowVisible(h) || Native.IsIconic(h)) return;
        if (seen.Count > 500) seen.Clear();
        seen.Add(h);
        if (Native.IsZoomed(h) || Native.GetWindow(h, 4) != IntPtr.Zero) return;
        int style = Native.GetWindowLong(h, -16), ex = Native.GetWindowLong(h, -20);
        if ((style & 0x10000) == 0 || (style & 0x40000) == 0 || (ex & 0x80) != 0) return;
        Native.ShowWindow(h, 3);
    }

    public void ComeToFront()
    {
        if (IsDisposed) return;
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Maximized;
        Show(); Activate(); Native.SetForegroundWindow(Handle);
    }

    // ---- The parent browser (Stripe Checkout and Customer Portal, a Wi-Fi network's sign-in page)
    public void OpenParentPage(string url)
    {
        if (parentBrowser != null && !parentBrowser.IsDisposed) parentBrowser.Close();
        parentBrowser = new ParentBrowser(this, url);
        parentBrowser.Done += (how, final) => Js($"window.DucklingWeb && DucklingWeb.onWindows && DucklingWeb.onWindows('parentPage', {(how == "closed" ? "false" : "true")}, {Q(how + " " + final)})");
        parentBrowser.FormClosed += (_, _) => { parentBrowser = null; ComeToFront(); };
        parentBrowser.Show(this);
    }

    public string NetworkStatus()
    {
        try
        {
            var up = NetworkInterface.GetAllNetworkInterfaces().Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback
                && n.NetworkInterfaceType != NetworkInterfaceType.Tunnel && n.GetIPProperties().GatewayAddresses.Count > 0).ToList();
            if (up.Count == 0) return "none";
            return up.Any(n => n.NetworkInterfaceType == NetworkInterfaceType.Wireless80211) ? "wifi" : "other";
        }
        catch (Exception) { return "other"; }
    }

    protected override void OnActivated(EventArgs e)
    {
        base.OnActivated(e);
        if (otherId != null) EndOther("returned");
        Js("window.DucklingWeb && DucklingWeb.onResume && DucklingWeb.onResume()");
    }

    // Screen off: leave every app and go home, as the Surface home screen did; screen on: make sure Duckling is in front.
    static Guid displayState = new("6fe69556-704a-47a0-8f24-c28d936fda47");
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try { Native.RegisterPowerSettingNotification(Handle, ref displayState, 0); } catch (Exception) { }
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0218 && (int)m.WParam == 0x8013 && m.LParam != IntPtr.Zero && ChildSession)
        {
            var g = Marshal.PtrToStructure<Guid>(m.LParam);
            if (g == displayState)
            {
                int state = Marshal.ReadInt32(m.LParam, 20);
                if (state == 0) GoHome();
                if (state == 1) { ComeToFront(); Js("window.DucklingWeb && DucklingWeb.onPush && DucklingWeb.onPush()"); }
            }
        }
        base.WndProc(ref m);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // In the child's account Duckling stays open; Windows shutting down or signing out still closes it.
        if (ChildSession && e.CloseReason == CloseReason.UserClosing && !allowClose) { e.Cancel = true; return; }
        ShellLog.Write($"closing: {e.CloseReason}{(allowClose ? " (Close Duckling)" : "")}");
        base.OnFormClosing(e);
    }
    bool allowClose;
    public void Quit() { allowClose = true; Close(); }
}
