using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace Duckling.Shell;

/// <summary>Apps already on the device. Listed from the Start menu's app list (shell:AppsFolder) in the current
/// account; a parent allows them in the portal. Shells, settings, browsers and installers are left out, and so are
/// programs outside Program Files and Windows, which the child account could replace.</summary>
public static class OtherApps
{
    public record Found(string Id, string Target, string Label, string? Icon);

    static readonly string[] DeniedExes = { "cmd.exe", "powershell.exe", "powershell_ise.exe", "pwsh.exe", "wt.exe", "regedit.exe", "taskmgr.exe", "mmc.exe",
        "control.exe", "explorer.exe", "msiexec.exe", "msedge.exe", "chrome.exe", "firefox.exe", "brave.exe", "opera.exe", "iexplore.exe",
        "duckling.exe", "ducklingservice.exe", "msedgewebview2.exe", "runas.exe", "mstsc.exe", "cleanmgr.exe", "dfrgui.exe", "resmon.exe",
        "perfmon.exe", "eventvwr.exe", "msconfig.exe", "msinfo32.exe", "odbcad32.exe", "recoverydrive.exe", "regedt32.exe", "wscript.exe", "cscript.exe",
        "magnify.exe", "narrator.exe", "osk.exe", "psr.exe", "quickassist.exe", "wf.msc", "unins000.exe" };
    static readonly string[] DeniedAumidPrefixes = { "windows.immersivecontrolpanel", "Microsoft.WindowsStore", "Microsoft.WindowsTerminal", "Microsoft.Windows.SecHealthUI",
        "Microsoft.MicrosoftEdge", "Microsoft.Windows.Explorer", "Microsoft.WindowsAlarms_x", "Microsoft.GetHelp", "Microsoft.WindowsFeedbackHub", "MicrosoftCorporationII.QuickAssist",
        "Microsoft.DevHome", "Microsoft.PowerShell", "Microsoft.Windows.Search", "MicrosoftWindows.Client.CBS", "Microsoft.Windows.ShellExperienceHost", "Microsoft.AAD.BrokerPlugin",
        "Microsoft.Windows.CloudExperienceHost", "Microsoft.Windows.ContentDeliveryManager", "Microsoft.CompanyPortal", "Microsoft.Windows.ParentalControls", "MicrosoftCorporationII.MicrosoftFamily" };

    public static List<Found> Enumerate()
    {
        var list = new List<Found>();
        var t = Type.GetTypeFromProgID("Shell.Application");
        if (t == null) return list;
        dynamic shell = Activator.CreateInstance(t)!;
        dynamic folder = shell.NameSpace("shell:::{4234d49b-0245-4df3-b780-3893943456e1}");
        if (folder == null) return list;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (dynamic item in folder.Items())
        {
            string name, path;
            try { name = (string)item.Name; path = (string)item.Path; } catch (Exception) { continue; }
            if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(path)) continue;
            var target = Resolve(path);
            if (target == null || !seen.Add(target)) continue;
            string? icon = null;
            try { icon = IconOf(path); } catch (Exception) { }
            list.Add(new Found(OtherAppId.For(target), target, name.Length > 80 ? name[..80] : name, icon));
        }
        return list.OrderBy(f => f.Label, StringComparer.CurrentCultureIgnoreCase).ToList();
    }

    /// <summary>What launches an AppsFolder item: a packaged app's AppUserModelID, or a program's full path (known
    /// folder GUIDs like {6D809377-...} expanded). Null for anything Duckling will not offer.</summary>
    public static string? Resolve(string path)
    {
        if (OtherAppId.IsAumid(path))
            return DeniedAumidPrefixes.Any(p => path.StartsWith(p, StringComparison.OrdinalIgnoreCase)) ? null : path;
        var full = path;
        if (path.StartsWith('{'))
        {
            var close = path.IndexOf('}');
            if (close < 0 || !Guid.TryParse(path[..(close + 1)], out var g)) return null;
            if (ShellItems.SHGetKnownFolderPath(g, 0, IntPtr.Zero, out var p) != 0) return null;
            var root = Marshal.PtrToStringUni(p); Marshal.FreeCoTaskMem(p);
            full = root + path[(close + 1)..];
        }
        if (!full.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) return null;
        if (DeniedExes.Contains(Path.GetFileName(full), StringComparer.OrdinalIgnoreCase)) return null;
        return OtherAppId.IsProtectedPath(full) ? Path.GetFullPath(full) : null;
    }

    /// <summary>A 48-pixel PNG of the app's icon as a data URL (under 9 KB, the server's limit), or null.</summary>
    static string? IconOf(string parsingName)
    {
        ShellItems.SHCreateItemFromParsingName("shell:AppsFolder\\" + parsingName, IntPtr.Zero, ShellItems.IShellItemImageFactoryId, out var obj);
        var factory = (IShellItemImageFactory)obj;
        if (factory.GetImage(new SIZE(48, 48), 0x4 /* SIIGBF_ICONONLY */, out var hbm) != 0 || hbm == IntPtr.Zero) return null;
        try
        {
            using var bmp = FromHbitmapWithAlpha(hbm);
            using var ms = new MemoryStream();
            bmp.Save(ms, ImageFormat.Png);
            return ms.Length < 9000 ? "data:image/png;base64," + Convert.ToBase64String(ms.ToArray()) : null;
        }
        finally { ShellItems.DeleteObject(hbm); }
    }

    [StructLayout(LayoutKind.Sequential)] struct BITMAP { public int bmType, bmWidth, bmHeight, bmWidthBytes; public ushort bmPlanes, bmBitsPixel; public IntPtr bmBits; }
    [DllImport("gdi32.dll")] static extern int GetObject(IntPtr h, int size, ref BITMAP bm);

    // Image.FromHbitmap drops the alpha channel; icons need it, so the 32-bit pixels are copied as they are.
    static Bitmap FromHbitmapWithAlpha(IntPtr hbm)
    {
        var bm = new BITMAP();
        GetObject(hbm, Marshal.SizeOf<BITMAP>(), ref bm);
        if (bm.bmBitsPixel != 32 || bm.bmBits == IntPtr.Zero) return Image.FromHbitmap(hbm);
        var w = bm.bmWidth; var h = Math.Abs(bm.bmHeight);
        var outBmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        var data = outBmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try
        {
            var row = new byte[w * 4];
            for (int y = 0; y < h; y++)
            {
                // DIB sections from the shell are bottom-up.
                Marshal.Copy(bm.bmBits + (h - 1 - y) * bm.bmWidthBytes, row, 0, row.Length);
                Marshal.Copy(row, 0, data.Scan0 + y * data.Stride, row.Length);
            }
        }
        finally { outBmp.UnlockBits(data); }
        return outBmp;
    }

    /// <summary>Starts an app; returns its process id when Windows says (0 when it does not).</summary>
    public static int Launch(string target)
    {
        if (OtherAppId.IsAumid(target))
        {
            var mgr = (IApplicationActivationManager)new ApplicationActivationManager();
            int hr = mgr.ActivateApplication(target, null, 0, out var pid);
            if (hr >= 0) return (int)pid;
            Process.Start(new ProcessStartInfo("explorer.exe", "shell:AppsFolder\\" + target) { UseShellExecute = true });
            return 0;
        }
        var p = Process.Start(new ProcessStartInfo(target) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(target)! });
        return p?.Id ?? 0;
    }
}

/// <summary>Leaving other apps: every app window in this session is asked to close (as if its X was pressed), and
/// anything still open 1.5 seconds later is ended. Taken from the Surface home screen, where it was proven with Store
/// apps, full-screen games and Edge windows.</summary>
public class AppCloser(Func<IntPtr[]> ownWindows)
{
    static readonly HashSet<string> ShellProcesses = new(StringComparer.OrdinalIgnoreCase) {
        "explorer", "ShellExperienceHost", "StartMenuExperienceHost", "SearchHost", "SearchApp", "TextInputHost",
        "LockApp", "ShellHost", "TabTip", "SystemSettings", "ctfmon", "dwm", "csrss", "winlogon", "sihost", "taskhostw", "RuntimeBroker",
        "msedgewebview2", "Duckling", "DucklingService" };
    readonly HashSet<int> closing = new();

    public void CloseApps()
    {
        int me = Environment.ProcessId;
        int session = Process.GetCurrentProcess().SessionId;
        var own = new HashSet<IntPtr>(ownWindows());
        Native.EnumWindows((h, _) =>
        {
            if (own.Contains(h) || !Native.IsWindowVisible(h) || Native.GetWindow(h, 4) != IntPtr.Zero) return true;
            Native.GetWindowThreadProcessId(h, out var pid);
            if (pid == 0 || pid == me) return true;
            var c = Native.ClassOf(h);
            if (c is "Shell_TrayWnd" or "Shell_SecondaryTrayWnd" or "Progman" or "WorkerW") return true;
            string name;
            try { using var p = Process.GetProcessById((int)pid); if (p.SessionId != session) return true; name = p.ProcessName; } catch (Exception) { return true; }
            if (c == "Windows.UI.Core.CoreWindow") { if (!ShellProcesses.Contains(name)) closing.Add((int)pid); return true; }
            bool storeApp = c == "ApplicationFrameWindow";
            if (!storeApp && ShellProcesses.Contains(name)) return true;
            if (!storeApp && name.Equals("ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) return true;
            Native.PostMessage(h, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            if (!storeApp) closing.Add((int)pid);
            else { int app = HostedAppPid(h, pid); if (app != 0) closing.Add(app); }
            return true;
        }, IntPtr.Zero);
    }

    static int HostedAppPid(IntPtr frame, uint framePid)
    {
        int found = 0;
        Native.EnumChildWindows(frame, (c, _) =>
        {
            Native.GetWindowThreadProcessId(c, out var p);
            if (p != 0 && p != framePid) { found = (int)p; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public void ForceCloseApps()
    {
        int session = Process.GetCurrentProcess().SessionId;
        var pids = new HashSet<int>(closing);
        closing.Clear();
        foreach (var pid in pids)
        {
            try { using var p = Process.GetProcessById(pid); if (p.SessionId == session && !p.HasExited && !ShellProcesses.Contains(p.ProcessName)) p.Kill(); } catch (Exception) { }
        }
        CloseApps();
        closing.Clear();
    }
}
