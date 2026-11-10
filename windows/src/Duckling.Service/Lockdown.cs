using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Duckling.Service;

/// <summary>Runs lockdown\DucklingLockdown.ps1 (Windows PowerShell 5.1, as SYSTEM) and builds the kiosk profile.</summary>
public class Lockdown(Store store, string script)
{
    public JsonNode Run(string action, params (string Name, string Value)[] args)
    {
        var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action }) psi.ArgumentList.Add(a);
        foreach (var (n, v) in args) { psi.ArgumentList.Add("-" + n); psi.ArgumentList.Add(v); }
        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(180_000)) { try { p.Kill(true); } catch (Exception) { } throw new ServiceError($"{action} took too long."); }
        var outText = stdout.Result.Trim();
        var errText = stderr.Result.Trim();
        var last = outText.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.StartsWith('{'));
        if (p.ExitCode != 0 || last == null)
        {
            var msg = FirstErrorLine(errText) ?? $"{action} failed (exit {p.ExitCode}).";
            Log.Error($"lockdown {action}: {msg}");
            throw new ServiceError(msg);
        }
        Log.Info($"lockdown {action}: ok");
        return JsonNode.Parse(last)!;
    }

    // PowerShell's error record: the message is the first line that is not a "+ ..." position marker or "At line".
    static string? FirstErrorLine(string err) =>
        err.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0 && !l.StartsWith('+') && !l.StartsWith("At ") && !l.StartsWith("CategoryInfo") && !l.StartsWith("FullyQualifiedErrorId"));

    public JsonNode Status() => Run("Status");

    /// <summary>Allowed targets for the kiosk: Duckling, the WebView2 runtime, and the other apps a parent allowed that
    /// the device has (packaged apps by AppUserModelID; programs only from Program Files or Windows).</summary>
    public (string Xml, List<string> Targets, List<string> WebView2) BuildKiosk()
    {
        return store.Read(s =>
        {
            var targets = s.OtherAllowed.Select(id => s.OtherCatalog.TryGetValue(id, out var a) ? a.Target : null)
                .Where(t => t != null).Cast<string>().Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(t => t, StringComparer.OrdinalIgnoreCase).ToList();
            var aumids = targets.Where(OtherAppId.IsAumid).ToList();
            var paths = targets.Where(t => !OtherAppId.IsAumid(t) && OtherAppId.IsProtectedPath(t) && File.Exists(t)).ToList();
            var wv2 = Kiosk.WebView2Executables().ToList();
            var startLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu), "Programs", "Duckling Tablet.lnk");
            var xml = Kiosk.Xml($"{Environment.MachineName}\\{s.ChildAccount}", Duckling.Paths.ShellExe, wv2, new Kiosk.Allowed(paths, aumids), File.Exists(startLink) ? startLink : null);
            return (xml, aumids.Concat(paths).ToList(), wv2);
        });
    }

    /// <summary>Applies the kiosk for the child account. Windows reads it at her next sign-in.</summary>
    public void ApplyKiosk()
    {
        var account = store.Read(s => s.ChildAccount);
        if (string.IsNullOrEmpty(account)) throw new ServiceError("Choose the child's Windows account first.");
        var (xml, targets, wv2) = BuildKiosk();
        var file = Path.Combine(Duckling.Paths.StateDir, "AssignedAccess.xml");
        File.WriteAllText(file, xml, new UTF8Encoding(false));
        Run("ApplyKiosk", ("XmlPath", file));
        store.Update(s => { s.KioskTargets = targets; s.KioskWebView2 = wv2; s.LockdownOn = true; });
    }

    public void RemoveKiosk()
    {
        Run("RemoveKiosk");
        store.Update(s => { s.LockdownOn = false; s.KioskTargets = new(); });
    }

    /// <summary>Re-applies the kiosk when what it should allow changed: a parent allowed or removed an app, or the
    /// WebView2 runtime updated into a new folder. Returns whether it was applied.</summary>
    public bool RefreshKioskIfNeeded()
    {
        if (!store.Read(s => s.LockdownOn && s.ChildAccount != "")) return false;
        var (_, targets, wv2) = BuildKiosk();
        var (oldTargets, oldWv2) = store.Read(s => (s.KioskTargets, s.KioskWebView2));
        if (targets.SequenceEqual(oldTargets, StringComparer.OrdinalIgnoreCase) && wv2.SequenceEqual(oldWv2, StringComparer.OrdinalIgnoreCase)) return false;
        ApplyKiosk();
        return true;
    }
}
