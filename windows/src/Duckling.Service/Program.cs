using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Win32;

namespace Duckling.Service;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        // The MSI runs this once on uninstall (not on upgrade): lockdown and automatic sign-in off, the device state
        // and the apps gone. The child's account stays.
        if (args.Contains("--uninstall-cleanup")) return Cleanup();

        var builder = Host.CreateApplicationBuilder(args);
        builder.Services.AddWindowsService(o => o.ServiceName = "DucklingTablet");
        builder.Services.AddHostedService<Worker>();
        await builder.Build().RunAsync();
        return 0;
    }

    static int Cleanup()
    {
        try
        {
            var store = new Store(Duckling.Paths.StateFile);
            var lockdown = new Lockdown(store, Duckling.Paths.LockdownScript);
            var account = store.Read(s => s.ChildAccount);
            try { if (account != "") lockdown.Run("Release", ("UserName", account)); else lockdown.Run("Release"); } catch (Exception e) { Log.Error("uninstall release: " + e.Message); }
            try { Directory.Delete(Duckling.Paths.AppsDir, true); } catch (Exception) { }
            try { Directory.Delete(Duckling.Paths.StateDir, true); } catch (Exception) { }
            try { Directory.Delete(Duckling.Paths.UpdatesDir, true); } catch (Exception) { }
            Log.Info("uninstalled: lockdown off, state and apps removed");
        }
        catch (Exception e) { Log.Error("uninstall cleanup: " + e.Message); }
        return 0;
    }
}

/// <summary>Folder permissions: the state folder for SYSTEM and Administrators only, the apps folder readable by
/// everyone signed in, so the shell in the child's session can show the apps but change nothing.</summary>
public static class Folders
{
    public static void Prepare()
    {
        Lock(Duckling.Paths.Root, readers: true);
        Lock(Duckling.Paths.StateDir, readers: false);
        Lock(Duckling.Paths.AppsDir, readers: true);
        Lock(Duckling.Paths.LogsDir, readers: false);
        Lock(Duckling.Paths.UpdatesDir, readers: false);
    }

    static void Lock(string path, bool readers)
    {
        var dir = Directory.CreateDirectory(path);
        var acl = new DirectorySecurity();
        acl.SetAccessRuleProtection(true, false);
        var inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        if (readers) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
        try { dir.SetAccessControl(acl); } catch (Exception e) { Log.Error($"acl {path}: {e.Message}"); }
    }
}

public class Worker : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        Folders.Prepare();
        Log.Info($"service {Updater.Current} ({Updater.Arch}) starting");
        var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd($"DucklingTablet-Windows/{Updater.Current}");
        var store = new Store(Duckling.Paths.StateFile);
        var packages = new Packages(Duckling.Paths.AppsDir, http);
        packages.CleanLeftovers();
        var lockdown = new Lockdown(store, Duckling.Paths.LockdownScript);
        var handlers = new Handlers(store, packages, lockdown) { OnReleased = account => _ = Task.Run(() => Uninstall(account)) };
        var updater = new Updater(store, http);
        var pipe = new PipeServer(handlers);
        var pipeTask = pipe.Run(ct);

        // Every 3 seconds: notice the child signing in (her settings, and which kiosk profile Windows read), keep the
        // kiosk in step with the WebView2 runtime, and every few minutes see whether an update is due.
        string? lastChildSession = null;
        int missing = 0;
        string? watchedSession = null;
        bool seenRunning = false;
        int notStarted = 0;
        int ticks = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var account = store.Read(s => s.ChildAccount);
                if (account != "")
                {
                    var session = Sessions.Of(account);
                    var key = session == null ? null : $"{session.Id}";
                    if (key != null && key != lastChildSession)
                    {
                        store.Update(s => s.SessionKioskTargets = s.LockdownOn ? s.KioskTargets.ToList() : new());
                        try { lockdown.Run("ChildSettings", ("UserName", account)); } catch (ServiceError) { }
                    }
                    lastChildSession = key;
                    // Duckling is the child's whole screen. If it ran in her session and then stopped (closed by an update,
                    // or it crashed) and is still gone 45 seconds later, she is signed out and automatic sign-in starts it
                    // again. Only after it has run: a first sign-in can take minutes before the kiosk starts Duckling.
                    if (session is { Active: true } && store.Read(s => s.LockdownOn))
                    {
                        if (key != watchedSession) { watchedSession = key; seenRunning = false; missing = 0; notStarted = 0; }
                        var running = System.Diagnostics.Process.GetProcessesByName("Duckling").Any(p => { try { return p.SessionId == session.Id; } catch (Exception) { return false; } });
                        if (running) { if (!seenRunning) Log.Info("Duckling is running in the child's session"); seenRunning = true; missing = 0; notStarted = 0; }
                        else if (seenRunning && ++missing >= 15) { Log.Info("Duckling stopped in the child's session: signing her out to start it again"); Sessions.Logoff(session.Id); missing = 0; seenRunning = false; }
                        // On the Surface neither the kiosk's AutoLaunch nor the Run entry starts Duckling, so the service
                        // starts it in her session itself 6 seconds after she signs in, and again every 30 seconds until it
                        // runs. Duckling is single-instance, so a start that races another opens nothing twice.
                        else if (!seenRunning && ++notStarted >= 2 && notStarted % 10 == 2)
                        {
                            var pid = Sessions.StartInSession(session.Id, Duckling.Paths.ShellExe);
                            Log.Info(pid > 0 ? "Duckling had not started in the child's session: started it" : $"could not start Duckling in the child's session (error {System.Runtime.InteropServices.Marshal.GetLastPInvokeError()})");
                        }
                    }
                    else missing = 0;
                }
                if (ticks % 200 == 0) { try { lockdown.RefreshKioskIfNeeded(); } catch (ServiceError) { } }
                if (ticks % 100 == 25) await updater.Tick(ct);
                if (ticks % 100 == 50) await ImportOldStars(store, http, ct);
            }
            catch (Exception e) { Log.Error($"worker: {e.GetType().Name}: {e.Message}"); }
            ticks++;
            // Every 3 seconds: the child's sign-in is seen at once. The periodic work counts in these ticks.
            try { await Task.Delay(TimeSpan.FromSeconds(3), ct); } catch (OperationCanceledException) { break; }
        }
        await pipeTask;
    }

    /// <summary>Every 5 minutes until done: the stars and avatar from the setup before Duckling go to the child's
    /// profile on the server, once the tablet is set up for her.</summary>
    static async Task ImportOldStars(Store store, HttpClient http, CancellationToken ct)
    {
        var (done, token) = store.Read(s => (s.OldStarsImported, s.DeviceToken));
        if (done || token == "") return;
        var users = Path.Combine(Path.GetPathRoot(Environment.SystemDirectory) ?? @"C:\", "Users");
        var old = OldStars.Best(OldStars.Folders(users));
        if (old == null) { store.Update(s => s.OldStarsImported = true); return; }
        try
        {
            if (!await OldStars.Import(http, Duckling.Paths.Api, token, old, ct)) return;
            store.Update(s => s.OldStarsImported = true);
            Log.Info($"brought over {old.Earned} stars, {old.Spent} spent and {old.Owned.Count} owned items from {old.Dir}");
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException) { Log.Error($"old stars: {e.Message}"); }
    }

    /// <summary>After a parent removed Duckling: the child is signed out (the kiosk ends with her session, and with
    /// automatic sign-in off the device stops at the sign-in screen), then the MSI uninstalls itself. The ProductCode
    /// is written by the installer.</summary>
    static void Uninstall(string account)
    {
        try
        {
            Thread.Sleep(8000);
            if (account != "" && Sessions.Of(account) is { } session) Sessions.Logoff(session.Id);
            var code = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\ET Ducky\Duckling Tablet")?.GetValue("ProductCode") as string;
            if (code == null) { Log.Error("uninstall: ProductCode not found"); return; }
            Log.Info("released by a parent: uninstalling");
            Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "msiexec.exe"), $"/x {code} /qn /norestart") { UseShellExecute = false, CreateNoWindow = true });
        }
        catch (Exception e) { Log.Error($"uninstall: {e.Message}"); }
    }
}
