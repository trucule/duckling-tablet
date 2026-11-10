using System.Security;
using System.Text;
using System.Text.Json;

namespace Duckling;

/// <summary>The Assigned Access (multi-app kiosk) profile for the child's account: Duckling starts at sign-in and is
/// the only app on Start, the taskbar is hidden, and only Duckling, the WebView2 runtime it draws with, and the other
/// apps a parent allowed can run. Applied through the MDM bridge by the service (as SYSTEM); Windows reads it at the
/// child's next sign-in. The same layout the Surface setup used, with Duckling in place of KidHome.</summary>
public static class Kiosk
{
    public const string ProfileId = "{8E1D6B52-4C3A-4F0E-9B7D-2A6C5E8F1D30}";

    public record Allowed(IReadOnlyList<string> DesktopPaths, IReadOnlyList<string> Aumids);

    /// <summary>Every msedgewebview2.exe on the device. The Evergreen runtime lives in a folder named after its
    /// version, so the service rebuilds the profile when a new version appears (before the child's next sign-in).</summary>
    public static IReadOnlyList<string> WebView2Executables(string? root = null)
    {
        var roots = root != null ? new[] { root } : new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "EdgeWebView", "Application"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "EdgeWebView", "Application"),
        };
        var found = new List<string>();
        foreach (var r in roots.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!Directory.Exists(r)) continue;
            foreach (var d in Directory.GetDirectories(r))
            {
                var exe = Path.Combine(d, "msedgewebview2.exe");
                if (File.Exists(exe)) found.Add(exe);
            }
        }
        return found.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    static string Attr(string s) => SecurityElement.Escape(s) ?? "";

    public static string Xml(string account, string shellExe, IEnumerable<string> webView2Exes, Allowed others, string? startLink)
    {
        var apps = new StringBuilder();
        foreach (var a in others.Aumids.Distinct(StringComparer.OrdinalIgnoreCase))
            apps.AppendLine($"          <App AppUserModelId=\"{Attr(a)}\" />");
        foreach (var p in webView2Exes.Concat(others.DesktopPaths).Distinct(StringComparer.OrdinalIgnoreCase))
            if (!p.Equals(shellExe, StringComparison.OrdinalIgnoreCase)) apps.AppendLine($"          <App DesktopAppPath=\"{Attr(p)}\" />");
        apps.AppendLine($"          <App DesktopAppPath=\"{Attr(shellExe)}\" rs5:AutoLaunch=\"true\" />");

        var pins = new List<object>();
        if (!string.IsNullOrEmpty(startLink)) pins.Add(new Dictionary<string, string> { ["desktopAppLink"] = startLink });
        var pinsJson = JsonSerializer.Serialize(new { pinnedList = pins });

        return $"""
<?xml version="1.0" encoding="utf-8"?>
<AssignedAccessConfiguration
  xmlns="http://schemas.microsoft.com/AssignedAccess/2017/config"
  xmlns:rs5="http://schemas.microsoft.com/AssignedAccess/201810/config"
  xmlns:v3="http://schemas.microsoft.com/AssignedAccess/2020/config"
  xmlns:win11="http://schemas.microsoft.com/AssignedAccess/2022/config">
  <Profiles>
    <Profile Id="{ProfileId}">
      <AllAppsList>
        <AllowedApps>
{apps.ToString().TrimEnd()}
        </AllowedApps>
      </AllAppsList>
      <win11:StartPins><![CDATA[{pinsJson}]]></win11:StartPins>
      <Taskbar ShowTaskbar="false" />
    </Profile>
  </Profiles>
  <Configs>
    <Config>
      <Account>{Attr(account)}</Account>
      <DefaultProfile Id="{ProfileId}" />
    </Config>
  </Configs>
</AssignedAccessConfiguration>
""";
    }
}
