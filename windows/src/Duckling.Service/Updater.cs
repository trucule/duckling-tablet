using System.Diagnostics;
using System.Net.Http.Json;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;

namespace Duckling.Service;

/// <summary>Keeps Duckling current: every 4 hours it asks the API for the newest installer for this device's
/// architecture, downloads it, checks its SHA-256 and that it carries a valid Authenticode signature from ET Ducky LLC,
/// and installs it with msiexec when nobody is using the device: the screen just turned off (the shell reports it), no
/// one is signed in, or between 2 and 5 at night. A kiosk tablet is always signed in and asleep at night, so the
/// screen turning off is the moment that actually comes. A verified installer is kept on disk, so a restart does not
/// lose it.</summary>
public class Updater(Store store, HttpClient http)
{
    public const string Publisher = "ET Ducky LLC";
    public static string Arch => RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "arm64" : "x64";
    public static string Current => (Assembly.GetEntryAssembly()?.GetName().Version ?? new Version(0, 0, 0)).ToString(3);

    record Release(string Version, string Url, string Sha256, long Size);
    string? ready; // a verified installer waiting for a quiet moment
    readonly SemaphoreSlim busy = new(1, 1); // one check or download at a time (the worker and screen-on both ask)

    /// <summary>How long after a completed check the next one waits. A failed check or download is not counted, so it
    /// is tried again at the next tick (every 5 minutes while the device is awake).</summary>
    public static readonly TimeSpan CheckEvery = TimeSpan.FromHours(1);
    /// <summary>At screen on the check runs early, unless one completed this recently.</summary>
    public static readonly TimeSpan ScreenOnGap = TimeSpan.FromMinutes(10);

    public static bool Due(string last, DateTime now, TimeSpan gap) =>
        !DateTime.TryParse(last, null, System.Globalization.DateTimeStyles.RoundtripKind, out var at) || now - at.ToUniversalTime() >= gap;

    public Task Tick(CancellationToken ct) => Check(CheckEvery, ct);

    /// <summary>The screen turned on: a tablet used for an hour at a time looks for an update at the start of each
    /// use, so it is downloaded during that use and installed when the screen turns off.</summary>
    public Task ScreenOn() => Check(ScreenOnGap, CancellationToken.None);

    async Task Check(TimeSpan gap, CancellationToken ct)
    {
        if (!await busy.WaitAsync(0, ct)) return;
        try
        {
            ready ??= Waiting();
            if (ready == null)
            {
                if (!Due(store.Read(s => s.LastUpdateCheck), DateTime.UtcNow, gap)) return;
                var r = await http.GetFromJsonAsync<Release>($"{Duckling.Paths.Api}/windows/release?arch={Arch}", ct);
                if (r != null && Versions.Compare(r.Version, Current) > 0)
                {
                    ready = await Download(r, ct);
                    Log.Info($"update {r.Version} downloaded and verified");
                }
                // Counted only once the check and any download finished: a tablet that slept mid-download tries again.
                store.Update(s => s.LastUpdateCheck = DateTime.UtcNow.ToString("o"));
            }
            if (ready != null && Quiet()) InstallReady("quiet");
        }
        catch (HttpRequestException) { }
        catch (OperationCanceledException) { }
        catch (Exception e) { Log.Error($"update: {e.GetType().Name}: {e.Message}"); ready = null; }
        finally { busy.Release(); }
    }

    /// <summary>The screen turned off in the child's session: the moment to install a waiting update.</summary>
    public void ScreenOff()
    {
        try { ready ??= Waiting(); if (ready != null) InstallReady("screen off"); }
        catch (Exception e) { Log.Error($"update at screen off: {e.GetType().Name}: {e.Message}"); }
    }

    void InstallReady(string why)
    {
        var msi = ready!; ready = null;
        Log.Info($"installing {Path.GetFileName(msi)} ({why})");
        Install(msi);
    }

    /// <summary>An installer downloaded earlier and still on disk: newer than this version and signed by the publisher.</summary>
    static string? Waiting()
    {
        if (!Directory.Exists(Duckling.Paths.UpdatesDir)) return null;
        string? best = null, bestVersion = null;
        foreach (var f in Directory.GetFiles(Duckling.Paths.UpdatesDir, $"DucklingTablet-*-{Arch}.msi"))
        {
            var v = Path.GetFileName(f)["DucklingTablet-".Length..^($"-{Arch}.msi".Length)];
            if (Versions.Compare(v, Current) <= 0 || (bestVersion != null && Versions.Compare(v, bestVersion) <= 0)) continue;
            if (!Authenticode.IsSignedBy(f, Publisher)) continue;
            best = f; bestVersion = v;
        }
        return best;
    }

    static bool Quiet()
    {
        var h = DateTime.Now.Hour;
        return Sessions.List().Count(s => s.Active) == 0 || (h >= 2 && h < 5);
    }

    async Task<string> Download(Release r, CancellationToken ct)
    {
        if (!Uri.TryCreate(r.Url, UriKind.Absolute, out var u) || u.Scheme != Uri.UriSchemeHttps) throw new ServiceError("Update URL is not HTTPS.");
        Directory.CreateDirectory(Duckling.Paths.UpdatesDir);
        foreach (var old in Directory.GetFiles(Duckling.Paths.UpdatesDir, "*.msi")) { try { File.Delete(old); } catch (Exception) { } }
        var bytes = await http.GetByteArrayAsync(u, ct);
        if (bytes.LongLength != r.Size || Signing.Sha256Hex(bytes) != r.Sha256.ToLowerInvariant()) throw new ServiceError("The update did not match its checksum.");
        var file = Path.Combine(Duckling.Paths.UpdatesDir, $"DucklingTablet-{r.Version}-{Arch}.msi");
        await File.WriteAllBytesAsync(file, bytes, ct);
        if (!Authenticode.IsSignedBy(file, Publisher)) { File.Delete(file); throw new ServiceError("The update is not signed by " + Publisher + "."); }
        return file;
    }

    static void Install(string msi)
    {
        // Duckling may be open in the child's session (the screen is off, nobody is using it). Its files must be free for
        // the upgrade to replace them now rather than at the next restart; the new service opens it again when the
        // child's session is in use.
        foreach (var p in Process.GetProcessesByName("Duckling")) { try { p.Kill(true); p.WaitForExit(5000); } catch (Exception) { } finally { p.Dispose(); } }
        var log = Path.Combine(Duckling.Paths.LogsDir, "update-msi.log");
        // msiexec stops this service as part of the upgrade, so it runs on its own.
        Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "msiexec.exe"), $"/i \"{msi}\" /qn /norestart /l*v \"{log}\"") { UseShellExecute = false, CreateNoWindow = true });
    }
}

/// <summary>Authenticode: the file's signature is valid and chains to a trusted root (WinVerifyTrust), and the signing
/// certificate names the expected organization.</summary>
public static class Authenticode
{
    [DllImport("wintrust.dll", CharSet = CharSet.Unicode)]
    static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid action, ref WINTRUST_DATA data);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WINTRUST_FILE_INFO { public uint cbStruct; public string pcwszFilePath; public IntPtr hFile; public IntPtr pgKnownSubject; }

    [StructLayout(LayoutKind.Sequential)]
    struct WINTRUST_DATA
    {
        public uint cbStruct; public IntPtr pPolicyCallbackData; public IntPtr pSIPClientData; public uint dwUIChoice; public uint fdwRevocationChecks;
        public uint dwUnionChoice; public IntPtr pFile; public uint dwStateAction; public IntPtr hWVTStateData; public IntPtr pwszURLReference;
        public uint dwProvFlags; public uint dwUIContext; public IntPtr pSignatureSettings;
    }

    static readonly Guid GenericVerifyV2 = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    public static bool IsSignedBy(string file, string organization)
    {
        var fi = new WINTRUST_FILE_INFO { cbStruct = (uint)Marshal.SizeOf<WINTRUST_FILE_INFO>(), pcwszFilePath = file };
        var pFile = Marshal.AllocHGlobal(Marshal.SizeOf(fi));
        try
        {
            Marshal.StructureToPtr(fi, pFile, false);
            var data = new WINTRUST_DATA
            {
                cbStruct = (uint)Marshal.SizeOf<WINTRUST_DATA>(), dwUIChoice = 2 /* none */, fdwRevocationChecks = 0,
                dwUnionChoice = 1 /* file */, pFile = pFile, dwStateAction = 0, dwProvFlags = 0x00000080 /* revocation check: chain excluding root */,
            };
            if (WinVerifyTrust(new IntPtr(-1), GenericVerifyV2, ref data) != 0) return false;
        }
        finally { Marshal.FreeHGlobal(pFile); }
#pragma warning disable SYSLIB0057
        using var cert = new X509Certificate2(X509Certificate.CreateFromSignedFile(file));
#pragma warning restore SYSLIB0057
        var org = cert.GetNameInfo(X509NameType.SimpleName, false);
        return cert.Subject.Contains($"O={organization}", StringComparison.OrdinalIgnoreCase) || string.Equals(org, organization, StringComparison.OrdinalIgnoreCase)
            || cert.Subject.Contains($"O=\"{organization}\"", StringComparison.OrdinalIgnoreCase);
    }
}
