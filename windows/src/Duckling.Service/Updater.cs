using System.Diagnostics;
using System.Net.Http.Json;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;

namespace Duckling.Service;

/// <summary>Keeps Duckling current: once a day it asks the API for the newest installer for this device's
/// architecture, downloads it, checks its SHA-256 and that it carries a valid Authenticode signature from ET Ducky LLC,
/// and installs it with msiexec when nobody is using the device (no one signed in, or between 2 and 5 at night).</summary>
public class Updater(Store store, HttpClient http)
{
    public const string Publisher = "ET Ducky LLC";
    public static string Arch => RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "arm64" : "x64";
    public static string Current => (Assembly.GetEntryAssembly()?.GetName().Version ?? new Version(0, 0, 0)).ToString(3);

    record Release(string Version, string Url, string Sha256, long Size);
    string? ready; // a verified installer waiting for a quiet moment

    public async Task Tick(CancellationToken ct)
    {
        try
        {
            if (ready == null)
            {
                var last = store.Read(s => s.LastUpdateCheck);
                if (DateTime.TryParse(last, out var at) && DateTime.UtcNow - at.ToUniversalTime() < TimeSpan.FromHours(20)) return;
                store.Update(s => s.LastUpdateCheck = DateTime.UtcNow.ToString("o"));
                var r = await http.GetFromJsonAsync<Release>($"{Duckling.Paths.Api}/windows/release?arch={Arch}", ct);
                if (r == null || Versions.Compare(r.Version, Current) <= 0) return;
                ready = await Download(r, ct);
                Log.Info($"update {r.Version} downloaded and verified");
            }
            if (ready != null && Quiet()) { Install(ready); ready = null; }
        }
        catch (HttpRequestException) { }
        catch (Exception e) { Log.Error($"update: {e.GetType().Name}: {e.Message}"); ready = null; }
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
        Log.Info($"installing {Path.GetFileName(msi)}");
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
