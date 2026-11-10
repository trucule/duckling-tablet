using System.Security.Cryptography;
using System.Text;

namespace Duckling;

/// <summary>Apps already on the device (installed outside Duckling). The server names them like Android packages
/// (letters, digits and dots), so a Windows app's id is "win.app.h" plus a hash of what launches it: a packaged app's
/// AppUserModelID or a desktop app's .exe path. The service keeps the id-to-target map.</summary>
public static class OtherAppId
{
    public static string For(string target) =>
        "win.app.h" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(target.ToLowerInvariant()))).Substring(0, 16);

    /// <summary>A packaged (Store) app's AppUserModelID: PackageFamilyName!AppId.</summary>
    public static bool IsAumid(string target) =>
        !target.Contains('\\') && target.Contains('!') && target.Split('!')[0].Contains('_');

    /// <summary>Only programs the child account cannot replace may be allowed: under Program Files or Windows.</summary>
    public static bool IsProtectedPath(string path)
    {
        string full;
        try { full = Path.GetFullPath(path); } catch (Exception) { return false; }
        foreach (var root in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.Windows) })
        {
            if (string.IsNullOrEmpty(root)) continue;
            if (full.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }
}
