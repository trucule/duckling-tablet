using System.Text.Json;

namespace Duckling.Service;

/// <summary>What the device remembers, kept by the service in C:\ProgramData\Duckling\state\state.json, which only
/// SYSTEM and Administrators can read: the child account cannot read the device token or the PIN hash.</summary>
public class DeviceState
{
    public string DeviceToken { get; set; } = "";
    public string PinHash { get; set; } = "";
    public Dictionary<string, string> Installed { get; set; } = new();
    public Dictionary<string, List<string>> Permissions { get; set; } = new();
    public List<string> AllowedHosts { get; set; } = new();
    public string ChildName { get; set; } = "";
    public string ChildId { get; set; } = "";
    public string ChildLevels { get; set; } = "{}";
    public string NarratorVoice { get; set; } = "en-US-AnaNeural";
    public string AppAccountToken { get; set; } = "";

    /// <summary>The Windows account the child uses (local, standard), signed in automatically.</summary>
    public string ChildAccount { get; set; } = "";
    /// <summary>The parent turned the lockdown on: the kiosk profile is applied for the child account.</summary>
    public bool LockdownOn { get; set; }

    /// <summary>Other apps the shell found on the device, by Duckling id: what launches them and their name.</summary>
    public Dictionary<string, OtherApp> OtherCatalog { get; set; } = new();
    /// <summary>The ids a parent allowed (from the device config).</summary>
    public List<string> OtherAllowed { get; set; } = new();
    /// <summary>Targets in the kiosk profile last applied, and in the one Windows read at the child's current sign-in.</summary>
    public List<string> KioskTargets { get; set; } = new();
    public List<string> SessionKioskTargets { get; set; } = new();
    public List<string> KioskWebView2 { get; set; } = new();

    public string LastUpdateCheck { get; set; } = "";
}

public record OtherApp(string Target, string Label);

public class Store
{
    readonly string file;
    readonly object gate = new();
    DeviceState state;

    public Store(string file)
    {
        this.file = file;
        state = Load();
    }

    DeviceState Load()
    {
        try { if (File.Exists(file)) return JsonSerializer.Deserialize<DeviceState>(File.ReadAllText(file)) ?? new(); }
        catch (Exception e) { Log.Error($"state unreadable, starting empty: {e.GetType().Name}"); }
        return new();
    }

    public T Read<T>(Func<DeviceState, T> f) { lock (gate) return f(state); }

    public T Update<T>(Func<DeviceState, T> f)
    {
        lock (gate)
        {
            var r = f(state);
            Save();
            return r;
        }
    }
    public void Update(Action<DeviceState> f) => Update(s => { f(s); return 0; });

    public void Reset() { lock (gate) { state = new DeviceState(); Save(); } }

    void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var tmp = file + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(state, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(tmp, file, true);
    }
}
