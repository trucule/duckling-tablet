using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Duckling.Shell;

/// <summary>Runs one installed app full screen from https://apps.duckling.example/&lt;id&gt;/ (the apps folder mapped by
/// WebView2), with the Home pill over it. The app reaches only its own files, the API and the CDN. Microphone and
/// camera are granted only to apps whose manifest asks for them.</summary>
public class AppForm : Form
{
    readonly MainForm main;
    readonly string id;
    readonly string[] permissions;
    readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = System.Drawing.Color.White };

    public AppForm(MainForm main, string id, string[] permissions)
    {
        this.main = main; this.id = id; this.permissions = permissions;
        Text = "Duckling Tablet";
        FormBorderStyle = FormBorderStyle.None;
        WindowState = FormWindowState.Maximized;
        ShowInTaskbar = false;
        BackColor = System.Drawing.Color.White;
        Controls.Add(web);
        KeyPreview = true;
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        try
        {
            await web.EnsureCoreWebView2Async(main.Env);
            var core = web.CoreWebView2;
            MainForm.Lock(core.Settings, childSession: main.ChildSession);
            core.Settings.UserAgent += $" DucklingTablet/{MainForm.Version} Windows";
            core.SetVirtualHostNameToFolderMapping(Paths.AppHost, Paths.AppsDir, CoreWebView2HostResourceAccessKind.Allow);
            core.AddHostObjectToScript("DucklingApp", new AppBridge(main, id));
            await core.AddScriptToExecuteOnDocumentCreatedAsync(AppBridge.Wrapper);
            var own = $"https://{Paths.AppHost}/{id}/";
            core.NavigationStarting += (_, ev) => { if (!ev.Uri.StartsWith(own, StringComparison.OrdinalIgnoreCase) && !ev.Uri.StartsWith("about:")) ev.Cancel = true; };
            core.NewWindowRequested += (_, ev) => ev.Handled = true;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, ev) =>
            {
                // Apps are offline; the API and the CDN stay reachable for the narrator voice, stars and the avatar.
                if (Uri.TryCreate(ev.Request.Uri, UriKind.Absolute, out var u) && (u.Scheme is "data" or "blob" || Hosts.IsOwn(u.Host))) return;
                ev.Response = main.Env!.CreateWebResourceResponse(null, 403, "Blocked", "Content-Type: text/plain");
            };
            core.PermissionRequested += (_, ev) =>
            {
                var ok = ev.PermissionKind switch
                {
                    CoreWebView2PermissionKind.Microphone => permissions.Contains("microphone"),
                    CoreWebView2PermissionKind.Camera => permissions.Contains("camera"),
                    CoreWebView2PermissionKind.Autoplay => true,
                    _ => false,
                };
                ev.State = ok ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
            };
            core.DownloadStarting += (_, ev) => ev.Cancel = true;
            core.Navigate($"https://{Paths.AppHost}/{id}/index.html");
        }
        catch (Exception ex) { ShellLog.Write($"app {id}: {ex.Message}"); Close(); }
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        // Escape leaves the app, like the Home pill (a keyboard on a Surface).
        if (e.KeyCode == Keys.Escape) { Close(); e.Handled = true; }
        base.OnKeyDown(e);
    }

    protected override void OnFormClosed(FormClosedEventArgs e) { web.Dispose(); base.OnFormClosed(e); }
}

/// <summary>window.DucklingApp: what duckling-compat.js inside a package needs (the device token for the narrator, the
/// child's name, voice, levels and id). Edge's own speechSynthesis covers the device voice on Windows.</summary>
[ComVisible(true)]
[ClassInterface(ClassInterfaceType.AutoDual)]
public class AppBridge(MainForm main, string id)
{
    public static readonly string Wrapper = $$"""
(() => {
  if (location.host !== {{JsonSerializer.Serialize(Paths.AppHost)}} || !window.chrome || !chrome.webview) return;
  const h = chrome.webview.hostObjects.sync.DucklingApp;
  const o = {};
  for (const n of ["appId", "deviceToken", "apiUrl", "childId", "childName", "voice", "levels"]) o[n] = () => h[n]();
  window.DucklingApp = Object.freeze(o);
})();
""";

    System.Text.Json.Nodes.JsonNode? state;
    System.Text.Json.Nodes.JsonNode? State() => state ??= main.Service.Call("state");

    public string appId() => id;
    public string deviceToken() => State()?["deviceToken"]?.GetValue<string>() ?? "";
    public string apiUrl() => Paths.Api;
    public string childId() => State()?["childId"]?.GetValue<string>() ?? "";
    public string childName() => State()?["childName"]?.GetValue<string>() ?? "";
    public string voice() => State()?["narratorVoice"]?.GetValue<string>() ?? "en-US-AnaNeural";
    public string levels() => State()?["childLevels"]?.GetValue<string>() ?? "{}";
}
