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
    public volatile IReadOnlyCollection<string> SignInHosts = Array.Empty<string>();
    /// <summary>Hosts refused without the Video blocked button (ShellBridge.setQuietHosts).</summary>
    public volatile IReadOnlyCollection<string> QuietHosts = Array.Empty<string>();
    public readonly bool ChildSession;
    public readonly AppCloser Closer;
    readonly HomePill pill;
    readonly HomePill videoPill;
    bool videoRefused;
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
        Closer = new AppCloser(() => new[] { Handle, pill?.Handle ?? IntPtr.Zero, videoPill?.Handle ?? IntPtr.Zero, appForm?.Handle ?? IntPtr.Zero, parentBrowser?.Handle ?? IntPtr.Zero });
        pill = new HomePill(() => GoHome());
        videoPill = new HomePill(() => GoHome(WebAppUrl + "#/parent-blocked"), video: true);
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
        // Duckling's own agent everywhere, and the plain Edge one on the sign-in services, which refuse agents they do
        // not know (Google's disallowed_useragent).
        var browserAgent = core.Settings.UserAgent;
        var ducklingAgent = $"{browserAgent} DucklingTablet/{Version} Windows";
        core.Settings.UserAgent = ducklingAgent;
        try { AllowedHosts = Hosts.Normalize(JsonSerializer.Deserialize<string[]>(Service.Call("state")?["allowedHosts"]?.ToJsonString() ?? "[]") ?? Array.Empty<string>()); }
        catch (Exception) { }

        var bridge = new ShellBridge(this);
        core.AddHostObjectToScript("DucklingShell", bridge);
        await core.AddScriptToExecuteOnDocumentCreatedAsync(ShellBridge.Wrapper(WebOrigin));

        core.NavigationStarting += (_, ev) =>
        {
            if (!Hosts.IsAllowedUri(ev.Uri, AllowedHosts) && !ev.Uri.StartsWith(WebOrigin, StringComparison.OrdinalIgnoreCase)) { ev.Cancel = true; return; }
            // A standard browser while signing in, Duckling's own agent again on the way back to the site.
            var agent = Uri.TryCreate(ev.Uri, UriKind.Absolute, out var u) && Hosts.IsAllowed(u.Host, SignInHosts) && !Hosts.IsOwn(u.Host) ? browserAgent : ducklingAgent;
            // The agent applies to navigations started after it is set; this one is restarted with it.
            if (core.Settings.UserAgent != agent) { core.Settings.UserAgent = agent; ev.Cancel = true; var uri = ev.Uri; BeginInvoke(() => core.Navigate(uri)); }
        };
        core.FrameNavigationStarting += (_, ev) => { if (!Hosts.IsAllowedUri(ev.Uri, AllowedHosts) && !ev.Uri.StartsWith(WebOrigin, StringComparison.OrdinalIgnoreCase)) ev.Cancel = true; };
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, ev) =>
        {
            var uri = ev.Request.Uri;
            if (uri.StartsWith(WebOrigin, StringComparison.OrdinalIgnoreCase) || Hosts.IsAllowedUri(uri, AllowedHosts)) return;
            NoteRefused(uri, ev.ResourceContext == CoreWebView2WebResourceContext.Media);
            ev.Response = Env!.CreateWebResourceResponse(null, 403, "Blocked", "Content-Type: text/plain");
        };
        // A website's new window (its "Sign in with Google" window) opens over it as a real window, so the sign-in can
        // report back to the page that opened it and close itself. Opened in place, as before, the report had nowhere
        // to go and the sign-in ended on a blank page.
        core.NewWindowRequested += async (_, ev) =>
        {
            if (!Hosts.IsAllowedUri(ev.Uri, AllowedHosts) && ev.Uri != "about:blank") { ev.Handled = true; return; }
            var deferral = ev.GetDeferral();
            try
            {
                var popup = await OpenPopup(Uri.TryCreate(ev.Uri, UriKind.Absolute, out var pu) && Hosts.IsAllowed(pu.Host, SignInHosts) ? browserAgent : ducklingAgent);
                ev.NewWindow = popup.CoreWebView2;
                ev.Handled = true;
            }
            catch (Exception e) { ShellLog.Write($"popup failed: {e.Message}"); ev.Handled = true; }
            finally { deferral.Complete(); }
        };
        core.PermissionRequested += (_, ev) => ev.State = CoreWebView2PermissionState.Deny;   // apps run in the app runner
        core.DownloadStarting += (_, ev) => ev.Cancel = true;
        core.ProcessFailed += (_, ev) => { ShellLog.Write($"webview process failed: {ev.ProcessFailedKind}"); if (ev.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) BeginInvoke(() => Application.Restart()); else core.Reload(); };
        // A website from the allowlist opens in this view; the Home pill brings the child back to the home screen.
        core.SourceChanged += (_, _) => { onWebsite = !core.Source.StartsWith(WebOrigin, StringComparison.OrdinalIgnoreCase); if (onWebsite) frontTimer.Start(); };
        core.Navigate(WebAppUrl);
        pushTimer.Start();
    }

    readonly List<WebView2> popups = new();

    /// <summary>A window a website opened, over the home screen view: the same host rules, no DucklingShell, and it
    /// goes away when the page closes it or the child presses Home.</summary>
    async Task<WebView2> OpenPopup(string agent)
    {
        var popup = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = System.Drawing.Color.White };
        Controls.Add(popup);
        popup.BringToFront();
        popups.Add(popup);
        await popup.EnsureCoreWebView2Async(Env);
        var c = popup.CoreWebView2;
        Lock(c.Settings, childSession: ChildSession);
        c.Settings.UserAgent = agent;
        c.NavigationStarting += (_, ev) => { if (!Hosts.IsAllowedUri(ev.Uri, AllowedHosts) && ev.Uri != "about:blank") ev.Cancel = true; };
        c.FrameNavigationStarting += (_, ev) => { if (!Hosts.IsAllowedUri(ev.Uri, AllowedHosts) && ev.Uri != "about:blank") ev.Cancel = true; };
        c.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        c.WebResourceRequested += (_, ev) =>
        {
            if (Hosts.IsAllowedUri(ev.Request.Uri, AllowedHosts)) return;
            NoteRefused(ev.Request.Uri, ev.ResourceContext == CoreWebView2WebResourceContext.Media);
            ev.Response = Env!.CreateWebResourceResponse(null, 403, "Blocked", "Content-Type: text/plain");
        };
        c.NewWindowRequested += (_, ev) => { ev.Handled = true; if (Hosts.IsAllowedUri(ev.Uri, AllowedHosts)) c.Navigate(ev.Uri); };
        c.WindowCloseRequested += (_, _) => BeginInvoke(() => ClosePopup(popup));
        c.PermissionRequested += (_, ev) => ev.State = CoreWebView2PermissionState.Deny;
        c.DownloadStarting += (_, ev) => ev.Cancel = true;
        return popup;
    }

    void ClosePopup(WebView2 popup)
    {
        if (!popups.Remove(popup)) return;
        Controls.Remove(popup);
        popup.Dispose();
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

    /// <summary>Runs script in the home screen from any thread; while a website is showing, nothing is sent to it.</summary>
    public void Js(string code)
    {
        if (IsDisposed) return;
        void Run() { try { if (CallerIsWebApp()) _ = Web.CoreWebView2?.ExecuteScriptAsync(code); } catch (Exception) { } }
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

    /// <summary>The Home pill, or the screen turning off: leave whatever is in front. The Video blocked button comes
    /// here too, with the parent area's list of refused hosts as the page to open.</summary>
    public void GoHome(string? to = null)
    {
        if (appForm != null && !appForm.IsDisposed) appForm.Close();
        if (otherId != null) EndOther("returned");
        foreach (var p in popups.ToArray()) ClosePopup(p);
        if (onWebsite || to != null) { onWebsite = false; Web.CoreWebView2?.Navigate(to ?? WebAppUrl); }
        videoRefused = false;
        pill.Hide();
        videoPill.Hide();
        ComeToFront();
    }

    // ---- Hosts a website was refused, for the parent area (ShellBridge.takeBlockedHosts) and the Video blocked button.
    record Refused(string Page, string Host) { public bool Media; public int Hits; }
    readonly Dictionary<string, Refused> refused = new();
    /// <summary>A video playlist, segment or media file, by its address. Same list in the Android and iPad shells.</summary>
    static readonly System.Text.RegularExpressions.Regex MediaPath = new(@"\.(m3u8|mpd|ts|m4s|mp4|m4v|m4a|mp3|aac|webm|ogg|ogv|cmfv|cmfa|vtt)$|/(hls|dash)/|\.ism/", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    void NoteRefused(string uri, bool mediaContext)
    {
        if (!onWebsite || !Uri.TryCreate(uri, UriKind.Absolute, out var u) || string.IsNullOrEmpty(u.Host)) return;
        var page = Uri.TryCreate(Web.CoreWebView2?.Source, UriKind.Absolute, out var p) ? p.Host.ToLowerInvariant() : "";
        if (page.Length == 0) return;
        var host = u.Host.ToLowerInvariant();
        var media = mediaContext || MediaPath.IsMatch(u.AbsolutePath) || u.Query.Contains(".m3u8", StringComparison.OrdinalIgnoreCase);
        lock (refused)
        {
            if (refused.TryGetValue(page + " " + host, out var r)) { r.Hits++; r.Media |= media; }
            else if (refused.Count < 200) refused[page + " " + host] = new Refused(page, host) { Media = media, Hits = 1 };
        }
        if (media && !Hosts.IsAllowed(host, QuietHosts)) { videoRefused = true; frontTimer.Start(); }
    }

    /// <summary>The refused hosts since the last call, as JSON [{page, host, media, hits}], and the list starts again.</summary>
    public string TakeRefused()
    {
        lock (refused)
        {
            var list = refused.Values.Select(r => new { page = r.Page, host = r.Host, media = r.Media, hits = r.Hits }).ToList();
            refused.Clear();
            return JsonSerializer.Serialize(list);
        }
    }

    void WatchFront()
    {
        if (otherId != null && DateTime.UtcNow >= otherEnd) { EndOther("timeup"); return; }
        if (otherId == null && (appForm == null || appForm.IsDisposed) && !onWebsite) { pill.Hide(); videoPill.Hide(); videoRefused = false; frontTimer.Stop(); return; }
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
        if (showOver && onWebsite && videoRefused && otherId == null) videoPill.Pin(Screen.FromHandle(fg == IntPtr.Zero ? Handle : fg).Bounds);
        else videoPill.Hide();
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
                if (state == 0)
                {
                    ShellLog.Write("screen off");
                    GoHome();
                    // The service installs a waiting update now, while nobody is using the tablet.
                    _ = Task.Run(() => { try { Service.Call("screen", new { on = false }); } catch (Exception) { } });
                }
                if (state == 1)
                {
                    ShellLog.Write("screen on");
                    ComeToFront();
                    ResetInput();
                    Js("window.DucklingWeb && DucklingWeb.onPush && DucklingWeb.onPush()");
                    // The service looks for an update now, so it downloads while the tablet is in use.
                    _ = Task.Run(() => { try { Service.Call("screen", new { on = true }); } catch (Exception) { } });
                }
            }
        }
        base.WndProc(ref m);
    }

    // After the screen turned off and on, the page could scroll under a finger but took no taps, though nothing was
    // busy. Hiding and showing the browser control makes WebView2 set up its input again, and the page gets focus.
    void ResetInput()
    {
        try
        {
            if (Web.CoreWebView2 == null) return;
            Web.Visible = false;
            Web.Visible = true;
            Web.Focus();
        }
        catch (Exception e) { ShellLog.Write($"input reset: {e.Message}"); }
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
