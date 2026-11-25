using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Duckling.Shell;

/// <summary>window.DucklingShell for the web app on Windows (web/src/shell.ts is the other side). Synchronous calls
/// return at once; work that takes time (installs, the lockdown, Wi-Fi) runs in the background and reports through
/// window.DucklingWeb. Only the web app's own page may call it: an allowed website open in the same view gets an
/// error.</summary>
[ComVisible(true)]
[ClassInterface(ClassInterfaceType.AutoDual)]
public class ShellBridge(MainForm main)
{
    /// <summary>The methods the web app sees. Exposed through a plain object, so feature checks in shell.ts
    /// (typeof shell.x === 'function') see only what Windows has.</summary>
    public static readonly string[] Methods = {
        "platform", "shellVersion", "getDeviceToken", "setDeviceToken", "pushToken", "installedApps", "installApp", "uninstallApp", "openApp",
        "hasPin", "setPin", "verifyPin", "setPinHash", "lockdownStatus", "requestHomeRole", "openSecuritySettings", "openWifiSettings", "networkStatus",
        "setLockdown", "setAllowedHosts", "setSignInHosts", "setChildInfo", "setChildLevels", "setChildId", "setLanguage", "release", "installedPackages", "launchPackage",
        "canDrawOverlays", "openOverlaySettings", "setAppAccountToken", "takeLocalBackground", "clearWebsiteData",
        "takeBlockedHosts", "setQuietHosts", "shellLog", "signInProviders", "signIn",
        // Windows only
        "setChildAccount", "restartDevice", "restartSession", "wifiNetworks", "connectWifi", "openParentPage", "setOtherApps", "endParent", "exitShell", "isChildSession",
    };

    public static string Wrapper(string origin) => $$"""
(() => {
  if (location.origin !== {{JsonSerializer.Serialize(origin)}} || !window.chrome || !chrome.webview) return;
  const h = chrome.webview.hostObjects.sync.DucklingShell;
  const o = {};
  for (const n of {{JsonSerializer.Serialize(Methods)}}) o[n] = (...a) => h[n](...a);
  window.DucklingShell = Object.freeze(o);
})();
""";

    void Guard() { if (!main.CallerIsWebApp()) throw new UnauthorizedAccessException("Not available to this page."); }
    JsonNode? Call(string op, object? args = null) => main.Service.Call(op, args);
    void Report(string kind, bool ok, string message) => main.Js($"window.DucklingWeb && DucklingWeb.onWindows && DucklingWeb.onWindows({MainForm.Q(kind)}, {(ok ? "true" : "false")}, {MainForm.Q(message)})");
    void Background(string kind, Func<string> work) => Task.Run(() =>
    {
        try { Report(kind, true, work()); }
        catch (Exception e) { Report(kind, false, e is ServiceError ? e.Message : "Something went wrong on this device."); ShellLog.Write($"{kind}: {e.Message}"); }
    });

    string? token;

    // Continue with Microsoft during setup; the result arrives at DucklingWeb.onSignIn(status, idToken, message),
    // on the web app's own page only (main.Js checks).
    public string signInProviders() { Guard(); return "microsoft"; }
    public void signIn(string provider, string nonce, string clientId)
    {
        Guard();
        void Done(string status, string idToken) => main.Js($"window.DucklingWeb && DucklingWeb.onSignIn && DucklingWeb.onSignIn({MainForm.Q(status)}, {MainForm.Q(idToken)}, '')");
        if (provider != "microsoft" || !Guid.TryParse(clientId, out _)) { Done("failed", ""); return; }
        main.BeginInvoke(async () => { var (status, idToken) = await MicrosoftSignIn.Run(main.Handle, clientId); Done(status, idToken); });
    }

    public string platform() => "windows";
    public string shellVersion() => MainForm.Version;
    public string takeLocalBackground() { Guard(); return LocalBackground.Take(); }
    public string getDeviceToken() { Guard(); return token ??= Call("state")?["deviceToken"]?.GetValue<string>() ?? ""; }
    public void setDeviceToken(string t) { Guard(); Call("setDeviceToken", new { token = t }); token = t; }
    public string pushToken() => "";
    public string installedApps() { Guard(); return Call("state")?["installed"]?.ToJsonString() ?? "{}"; }

    public void installApp(string id, string version, string url, string sha256, string signature, string permissions)
    {
        Guard();
        var perms = permissions.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        Task.Run(async () =>
        {
            try { await main.Service.CallAsync("install", new { id, version, url, sha256, signature, permissions = perms }); main.Js($"window.DucklingWeb && DucklingWeb.onInstall({MainForm.Q(id)}, true, '')"); }
            catch (Exception e) { main.Js($"window.DucklingWeb && DucklingWeb.onInstall({MainForm.Q(id)}, false, {MainForm.Q(e is ServiceError ? e.Message : "Install failed")})"); }
        });
    }
    public void uninstallApp(string id) { Guard(); Task.Run(() => { try { Call("uninstall", new { id }); } catch (Exception) { } }); }

    public void openApp(string id)
    {
        Guard();
        var st = Call("state");
        if (st?["installed"]?[id] == null) return;
        var perms = (st["permissions"]?[id] as JsonArray)?.Select(p => p?.GetValue<string>() ?? "").ToArray() ?? Array.Empty<string>();
        main.BeginInvoke(() => main.OpenApp(id, perms));
    }

    public bool hasPin() { Guard(); return Call("state")?["hasPin"]?.GetValue<bool>() == true; }
    public void setPin(string pin) { Guard(); Call("setPin", new { pin }); }
    public bool verifyPin(string pin) { Guard(); return Call("verifyPin", new { pin })?.GetValue<bool>() == true; }
    public void setPinHash(string hash) { Guard(); Call("setPinHash", new { hash }); }
    public void endParent() { Guard(); Task.Run(() => { try { Call("endParent"); } catch (Exception) { } }); }

    // The lockdown status comes from PowerShell on the service side and takes a moment, so the last answer is
    // returned at once and a fresh one is fetched; when it differs, the web app is told to look again (onResume).
    string status = """{"homeRole":false,"deviceSecure":false,"pinned":false,"lockdownOn":false}""";
    DateTime statusAt = DateTime.MinValue;
    int refreshing, generation;
    public string lockdownStatus()
    {
        Guard();
        if (DateTime.UtcNow - statusAt > TimeSpan.FromSeconds(3)) RefreshStatus();
        return status;
    }
    void RefreshStatus()
    {
        if (Interlocked.Exchange(ref refreshing, 1) != 0) return;
        Task.Run(() =>
        {
            try
            {
                // A change made while a read was under way (a step just finished) is read again, so the web app never
                // keeps a status from before the change.
                int gen;
                do
                {
                    gen = Volatile.Read(ref generation);
                    var fresh = Call("lockdownStatus")?.ToJsonString() ?? status;
                    statusAt = DateTime.UtcNow;
                    if (fresh != status) { status = fresh; main.Js("window.DucklingWeb && DucklingWeb.onResume && DucklingWeb.onResume()"); }
                } while (gen != Volatile.Read(ref generation));
            }
            catch (Exception e) { ShellLog.Write($"status: {e.Message}"); }
            finally { refreshing = 0; }
        });
    }
    void StatusChanged() { Interlocked.Increment(ref generation); statusAt = DateTime.MinValue; RefreshStatus(); }

    public void requestHomeRole() { }
    public void openSecuritySettings() { }
    public void openWifiSettings() { }

    /// <summary>Windows' privacy switches for the microphone and camera, as JSON {microphone, camera}: on, or off when
    /// any of them denies it (a group policy, the device-wide switch, this account's switch, or "Let desktop apps
    /// access", which covers Duckling).</summary>
    public string mediaAccess() => new JsonObject { ["microphone"] = MediaSwitch("microphone", "LetAppsAccessMicrophone"), ["camera"] = MediaSwitch("webcam", "LetAppsAccessCamera") }.ToJsonString();

    internal static string MediaSwitch(string store, string policy)
    {
        const string consent = @"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\";
        try
        {
            using (var p = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Policies\Microsoft\Windows\AppPrivacy"))
                if (p?.GetValue(policy) is int forced && forced == 2) return "off";
            foreach (var (root, path) in new[] { (Microsoft.Win32.Registry.LocalMachine, consent + store), (Microsoft.Win32.Registry.CurrentUser, consent + store), (Microsoft.Win32.Registry.CurrentUser, consent + store + @"\NonPackaged") })
                using (var k = root.OpenSubKey(path))
                    if (string.Equals(k?.GetValue("Value") as string, "Deny", StringComparison.OrdinalIgnoreCase)) return "off";
            return "on";
        }
        catch { return "on"; }
    }
    public string networkStatus() => main.NetworkStatus();

    public void setLockdown(bool on) { Guard(); Background("lockdown", () => { Call("setLockdown", new { on }); StatusChanged(); return on ? "on" : "off"; }); }
    public void setChildAccount(string name, string fullName) { Guard(); Background("account", () => { Call("setChildAccount", new { name, fullName }); StatusChanged(); return name; }); }
    public void restartDevice() { Guard(); Background("restart", () => { Call("restartDevice"); return ""; }); }
    public void restartSession() { Guard(); Background("restartSession", () => { Call("restartSession"); return ""; }); }
    public void wifiNetworks() { Guard(); Background("wifi", () => Call("wifiNetworks")?.ToJsonString() ?? "[]"); }
    public void connectWifi(string ssid, string password) { Guard(); Background("wifiConnect", () => { Call("wifiConnect", new { ssid, password }); return ssid; }); }
    public void openParentPage(string url)
    {
        Guard();
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp)) return;
        main.BeginInvoke(() => main.OpenParentPage(url));
    }
    public bool isChildSession() => main.ChildSession;
    public void exitShell() { Guard(); if (!main.ChildSession) main.BeginInvoke(() => main.Quit()); }

    public void setAllowedHosts(string csv)
    {
        Guard();
        var hosts = Hosts.Normalize(csv.Split(','));
        main.AllowedHosts = hosts;
        Task.Run(() => { try { Call("setAllowedHosts", new { hosts }); } catch (Exception) { } });
    }
    /// <summary>Clears what the given websites (a JSON array of hosts) saved on this device: storage, offline files,
    /// service workers and cookies, plus the shared download cache. Duckling's own pages and the apps keep their
    /// data. For a website that stopped loading or keeps showing an old version.</summary>
    public void clearWebsiteData(string hostsJson)
    {
        Guard();
        string[] hosts;
        try { hosts = Hosts.Normalize(JsonSerializer.Deserialize<string[]>(hostsJson) ?? []).Where(h => !Hosts.IsOwn(h)).ToArray(); } catch (JsonException) { return; }
        main.BeginInvoke(async () =>
        {
            var core = main.Web.CoreWebView2; if (core == null) return;
            foreach (var h in hosts)
                foreach (var origin in new[] { "https://" + h, "https://www." + h })
                    try { await core.CallDevToolsProtocolMethodAsync("Storage.clearDataForOrigin", JsonSerializer.Serialize(new { origin, storageTypes = "all" })); }
                    catch (Exception e) { ShellLog.Write($"clearWebsiteData: {e.Message}"); }
            try { await core.Profile.ClearBrowsingDataAsync(Microsoft.Web.WebView2.Core.CoreWebView2BrowsingDataKinds.DiskCache); } catch (Exception) { }
        });
    }
    /// <summary>Sign-in services a website may send a parent to; the shell presents its plain Edge user agent there.</summary>
    public void setSignInHosts(string csv) { Guard(); main.SignInHosts = Hosts.Normalize(csv.Split(',')); }
    public void setChildInfo(string name, string voice) { Guard(); Task.Run(() => { try { Call("setChild", new { name, voice }); } catch (Exception) { } }); }
    public void setChildLevels(string json) { Guard(); Task.Run(() => { try { Call("setChild", new { levels = json }); } catch (Exception) { } }); }
    /// <summary>The tablet's language, for the Home pill's words.</summary>
    public void setLanguage(string lang) { Guard(); HomePill.Label = lang == "es" ? "Inicio" : "Home"; HomePill.VideoLabel = lang == "es" ? "Video bloqueado" : "Video blocked"; }

    /// <summary>Hosts the allowed websites were refused since the last call (JSON [{page, host, media, hits}]).</summary>
    public string takeBlockedHosts() { Guard(); return main.TakeRefused(); }
    /// <summary>Hosts refused without the Video blocked button: advertising and analytics, and those a parent kept blocked.</summary>
    public void setQuietHosts(string csv) { Guard(); main.QuietHosts = Hosts.Normalize(csv.Split(',')); }
    /// <summary>The end of shell.log, for a diagnostics report.</summary>
    public string shellLog() { Guard(); return ShellLog.Tail(); }
    public void setChildId(string id) { Guard(); Task.Run(() => { try { Call("setChild", new { id }); } catch (Exception) { } }); }
    public void setAppAccountToken(string t) { Guard(); Task.Run(() => { try { Call("setAppAccountToken", new { token = t }); } catch (Exception) { } }); }

    public void release()
    {
        Guard();
        Background("release", () => { Call("release"); token = ""; return ""; });
    }

    // ---- Other apps
    string? packagesJson;
    public string installedPackages()
    {
        Guard();
        if (packagesJson != null) return packagesJson;
        try
        {
            var found = OtherApps.Enumerate();
            Task.Run(() => { try { Call("setOtherCatalog", new { apps = found.Select(f => new { target = f.Target, label = f.Label }) }); } catch (Exception) { } });
            packagesJson = JsonSerializer.Serialize(found.Select(f => f.Icon == null ? (object)new { package = f.Id, label = f.Label } : new { package = f.Id, label = f.Label, icon = f.Icon }));
        }
        catch (Exception e) { ShellLog.Write($"other apps: {e.Message}"); packagesJson = "[]"; }
        return packagesJson;
    }

    public void setOtherApps(string csv)
    {
        Guard();
        var ids = csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        Task.Run(() => { try { Call("setOtherApps", new { ids }); } catch (Exception e) { ShellLog.Write($"setOtherApps: {e.Message}"); } });
    }

    public void launchPackage(string pkg, double seconds)
    {
        Guard();
        JsonNode? t;
        try { t = Call("otherAppTarget", new { id = pkg }); } catch (Exception) { t = null; }
        if (t?["allowed"]?.GetValue<bool>() != true) { main.Js($"window.DucklingWeb && DucklingWeb.onOtherApp({MainForm.Q(pkg)}, 0, 'missing')"); return; }
        if (t["restartNeeded"]?.GetValue<bool>() == true) { main.Js($"window.DucklingWeb && DucklingWeb.onOtherApp({MainForm.Q(pkg)}, 0, 'restart')"); return; }
        var target = t["target"]!.GetValue<string>();
        main.BeginInvoke(() => main.BeginOther(pkg, target, (int)seconds));
    }

    public bool canDrawOverlays() => true;
    public void openOverlaySettings() { }
}
