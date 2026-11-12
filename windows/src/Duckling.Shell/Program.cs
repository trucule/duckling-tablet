using System.Security.Principal;

namespace Duckling.Shell;

static class Program
{
    /// <summary>One Duckling per session. A second start (the Start menu tile, the kiosk's AutoLaunch after a crash)
    /// brings the running one to the front.</summary>
    [STAThread]
    static int Main(string[] args)
    {
        var me = System.Diagnostics.Process.GetCurrentProcess();
        ShellLog.Write($"start {Paths.ShellExe} pid {me.Id} session {me.SessionId}");
        AppDomain.CurrentDomain.UnhandledException += (_, e) => ShellLog.Write($"crash: {e.ExceptionObject}");
        Application.ThreadException += (_, e) => ShellLog.Write($"error: {e.Exception}");
        using var mutex = new Mutex(true, @"Local\DucklingTabletShell", out var created);
        using var show = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\DucklingTabletShellShow");
        if (!created)
        {
            // Another Duckling in this session has the window: bring it to the front. With no other Duckling running the
            // marker is stale (abandoned, or held by something that outlived it), and this copy opens anyway, so a
            // stale marker can never leave the child with no Duckling.
            var other = System.Diagnostics.Process.GetProcessesByName("Duckling").Any(p => p.Id != me.Id && p.SessionId == me.SessionId);
            if (other) { ShellLog.Write("already open in this session: brought it to the front"); show.Set(); return 0; }
            ShellLog.Write("the open-window marker was held with no Duckling running: opening anyway");
        }

        ApplicationConfiguration.Initialize();
        // --web-app=<url> points the shell at another copy of the web app (tests); production uses app.ducklingtablet.com.
        var webApp = args.FirstOrDefault(a => a.StartsWith("--web-app="))?["--web-app=".Length..] ?? Paths.WebApp;
        var form = new MainForm(webApp, IsChildSession());
        var waiter = new Thread(() => { while (show.WaitOne()) { try { form.BeginInvoke(form.ComeToFront); } catch (Exception) { return; } } }) { IsBackground = true };
        waiter.Start();
        Application.Run(form);
        ShellLog.Write("closed");
        return 0;
    }

    /// <summary>Whether this is the child's account (the kiosk), from the service; false when the service does not
    /// answer, so a parent can always close the window.</summary>
    static bool IsChildSession()
    {
        try
        {
            var child = new ServiceClient(timeoutMs: 3000).Call("state")?["childAccount"]?.GetValue<string>() ?? "";
            var me = WindowsIdentity.GetCurrent().Name.Split('\\').Last();
            return child.Length > 0 && child.Equals(me, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception) { return false; }
    }
}
