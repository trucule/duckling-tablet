using System.IO.Compression;
using System.Text.RegularExpressions;

namespace Duckling;

public class InstallError(string message) : Exception(message);

/// <summary>Installed app packages live under C:\ProgramData\Duckling\apps\&lt;id&gt;\. A package is unpacked only after
/// its SHA-256 matches the catalog and its Ed25519 signature verifies, into a staging folder first, so a failed or
/// tampered download never replaces a working app.</summary>
public partial class Packages(string root, HttpClient http, string publicKeyB64 = Signing.PublicKeyB64)
{
    [GeneratedRegex("^[a-z0-9][a-z0-9-]{1,40}$")] private static partial Regex IdPattern();
    public const long MaxBytes = 200L * 1024 * 1024;
    public const int MaxFiles = 5000;

    public string Root => root;
    public string Dir(string id) => Path.Combine(root, id);
    public bool Has(string id) => IdPattern().IsMatch(id) && File.Exists(Path.Combine(Dir(id), "index.html"));

    public async Task Install(string id, string url, string sha256, string signature, CancellationToken ct = default)
    {
        if (!IdPattern().IsMatch(id)) throw new InstallError("Bad app id.");
        var zip = await Download(url, ct);
        Unpack(id, zip, sha256, signature);
    }

    public void Unpack(string id, byte[] zip, string sha256, string signature)
    {
        if (!IdPattern().IsMatch(id)) throw new InstallError("Bad app id.");
        if (Signing.Sha256Hex(zip) != sha256.ToLowerInvariant()) throw new InstallError("The download did not match. Try again.");
        if (!Signing.Verify(zip, signature, publicKeyB64)) throw new InstallError("This package is not signed by Duckling.");
        Directory.CreateDirectory(root);
        var target = Dir(id);
        var staging = Path.Combine(root, id + ".new");
        if (Directory.Exists(staging)) Directory.Delete(staging, true);
        Directory.CreateDirectory(staging);
        var stagingFull = Path.GetFullPath(staging) + Path.DirectorySeparatorChar;
        using (var archive = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read))
        {
            int count = 0;
            foreach (var entry in archive.Entries)
            {
                var name = entry.FullName.Replace('\\', '/');
                var dest = Path.GetFullPath(Path.Combine(staging, name));
                // Every file stays inside the staging folder: no "../", no absolute names, no drive letters.
                if (!dest.StartsWith(stagingFull, StringComparison.OrdinalIgnoreCase)) throw new InstallError("Bad file name in package.");
                if (name.EndsWith('/')) { Directory.CreateDirectory(dest); continue; }
                if (++count > MaxFiles) throw new InstallError("Package has too many files.");
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                entry.ExtractToFile(dest, true);
            }
        }
        if (!File.Exists(Path.Combine(staging, "index.html"))) { Directory.Delete(staging, true); throw new InstallError("Package has no index.html."); }
        if (Directory.Exists(target))
        {
            // A folder in use (the child has the app open) cannot be deleted; move it aside and clean it up later.
            var old = Path.Combine(root, $"{id}.old-{Guid.NewGuid():N}");
            Directory.Move(target, old);
            try { Directory.Delete(old, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
        Directory.Move(staging, target);
    }

    public void Uninstall(string id)
    {
        if (!IdPattern().IsMatch(id)) return;
        var dir = Dir(id);
        if (!Directory.Exists(dir)) return;
        var old = Path.Combine(root, $"{id}.old-{Guid.NewGuid():N}");
        try { Directory.Move(dir, old); Directory.Delete(old, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    /// <summary>Folders left from replaced apps that were open at the time.</summary>
    public void CleanLeftovers()
    {
        if (!Directory.Exists(root)) return;
        foreach (var d in Directory.GetDirectories(root, "*.old-*")) { try { Directory.Delete(d, true); } catch (Exception) { } }
        foreach (var d in Directory.GetDirectories(root, "*.new")) { try { Directory.Delete(d, true); } catch (Exception) { } }
    }

    async Task<byte[]> Download(string url, CancellationToken ct)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || u.Scheme != Uri.UriSchemeHttps) throw new InstallError("Packages come only over HTTPS.");
        using var r = await http.GetAsync(u, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!r.IsSuccessStatusCode) throw new InstallError($"Download failed ({(int)r.StatusCode}).");
        if (r.Content.Headers.ContentLength > MaxBytes) throw new InstallError("Package is too large.");
        await using var s = await r.Content.ReadAsStreamAsync(ct);
        using var ms = new MemoryStream();
        var buf = new byte[81920];
        int n;
        while ((n = await s.ReadAsync(buf, ct)) > 0)
        {
            ms.Write(buf, 0, n);
            if (ms.Length > MaxBytes) throw new InstallError("Package is too large.");
        }
        return ms.ToArray();
    }
}
