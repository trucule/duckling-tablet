namespace Duckling;

/// <summary>Where Duckling keeps things on the device.</summary>
public static class Paths
{
    /// <summary>C:\ProgramData\Duckling: written by the service only (SYSTEM and Administrators).</summary>
    public static string Root => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Duckling");
    /// <summary>The device state: token, PIN hash, installed versions, child settings. SYSTEM and Administrators only.</summary>
    public static string StateDir => Path.Combine(Root, "state");
    public static string StateFile => Path.Combine(StateDir, "state.json");
    /// <summary>Unpacked app packages, readable by every account (the shell maps them to https://apps.duckling.example/).</summary>
    public static string AppsDir => Path.Combine(Root, "apps");
    public static string LogsDir => Path.Combine(Root, "logs");
    public static string UpdatesDir => Path.Combine(Root, "updates");
    /// <summary>The old Surface setup (KidTablet), moved here on migration rather than deleted.</summary>
    public static string OldKidTabletDir => Path.Combine(Root, "old-kidtablet");

    /// <summary>Program Files\Duckling Tablet: the shell, the service and the lockdown script.</summary>
    public static string InstallDir => AppContext.BaseDirectory;
    public static string ShellExe => Path.Combine(InstallDir, "Duckling.exe");
    public static string LockdownScript => Path.Combine(InstallDir, "lockdown", "DucklingLockdown.ps1");

    public const string PipeName = "DucklingTablet";
    public const string AppHost = "apps.duckling.example";
    public const string WebApp = "https://app.ducklingtablet.com/";
    public const string Api = "https://api.ducklingtablet.com";
    public const string Site = "https://ducklingtablet.com";

    /// <summary>Hosts the shell always reaches: the web app, the API, the CDN for packages and voice clips.</summary>
    public static readonly string[] OwnHosts = { "app.ducklingtablet.com", "api.ducklingtablet.com", "duckling.nyc3.cdn.digitaloceanspaces.com", AppHost };
}
