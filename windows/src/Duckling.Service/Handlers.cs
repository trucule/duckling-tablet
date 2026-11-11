using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Duckling.Service;

/// <summary>Every operation the shell can ask of the service. Changes that weaken the lockdown (turning it off,
/// removing Duckling, restarting into another account, choosing the child account) need a parent: they are accepted
/// for 30 minutes after the parent PIN was entered on this device, or before any PIN exists (first setup).</summary>
public class Handlers(Store store, Packages packages, Lockdown lockdown, Func<DateTime>? clock = null)
{
    readonly Func<DateTime> now = clock ?? (() => DateTime.UtcNow);
    DateTime parentUntil = DateTime.MinValue;
    public static readonly TimeSpan ParentWindow = TimeSpan.FromMinutes(30);
    /// <summary>Set by the worker: what to do once the parent confirmed a removal (lockdown off, uninstall).</summary>
    public Action<string>? OnReleased;

    bool ParentPresent => store.Read(s => s.PinHash == "") || now() < parentUntil;
    void NeedParent() { if (!ParentPresent) throw new ServiceError("Enter the parent PIN first."); }

    static string Str(JsonNode? a, string name, int max = 4000)
    {
        var v = a?[name]?.GetValue<string>() ?? "";
        if (v.Length > max) throw new ServiceError($"{name} is too long.");
        return v;
    }

    public object? Handle(string op, JsonNode? a)
    {
        switch (op)
        {
            case "hello":
                return new { version = Updater.Current, arch = Updater.Arch, pipe = Paths.PipeName };

            case "state":
                return store.Read(s => new
                {
                    deviceToken = s.DeviceToken, hasPin = s.PinHash != "", installed = s.Installed.Where(kv => packages.Has(kv.Key)).ToDictionary(kv => kv.Key, kv => kv.Value),
                    permissions = s.Permissions, allowedHosts = s.AllowedHosts, childName = s.ChildName, childId = s.ChildId, childLevels = s.ChildLevels,
                    narratorVoice = s.NarratorVoice, appAccountToken = s.AppAccountToken, lockdownOn = s.LockdownOn, childAccount = s.ChildAccount,
                });

            case "setDeviceToken":
                store.Update(s => s.DeviceToken = Str(a, "token", 200));
                return null;

            // ---- PIN: the same SHA-256 form the server and the other shells keep.
            case "setPin":
            {
                var pin = Str(a, "pin", 12);
                if (pin.Length < 4 || !pin.All(char.IsAsciiDigit)) throw new ServiceError("The PIN is 4 to 12 digits.");
                // Changing an existing PIN needs the parent, like everything else that loosens the device.
                NeedParent();
                store.Update(s => s.PinHash = Pin.Hash(pin));
                parentUntil = now() + ParentWindow;
                return null;
            }
            case "setPinHash":
            {
                var h = Str(a, "hash", 64);
                if (Pin.IsHash(h)) store.Update(s => s.PinHash = h);
                return null;
            }
            case "verifyPin":
            {
                var ok = store.Read(s => s.PinHash != "" && s.PinHash == Pin.Hash(Str(a, "pin", 12)));
                if (ok) parentUntil = now() + ParentWindow;
                return ok;
            }
            case "endParent":
                parentUntil = DateTime.MinValue;
                return null;

            // ---- App packages
            case "install":
            {
                var id = Str(a, "id", 41); var version = Str(a, "version", 20);
                var perms = (a?["permissions"] as JsonArray)?.Select(p => p?.GetValue<string>() ?? "").Where(p => p.Length > 0 && p.Length < 40).Take(10).ToList() ?? new();
                packages.Install(id, Str(a, "url", 2000), Str(a, "sha256", 64), Str(a, "signature", 200)).GetAwaiter().GetResult();
                store.Update(s => { s.Installed[id] = version; s.Permissions[id] = perms; });
                return null;
            }
            case "uninstall":
            {
                var id = Str(a, "id", 41);
                packages.Uninstall(id);
                store.Update(s => { s.Installed.Remove(id); s.Permissions.Remove(id); });
                return null;
            }

            // ---- From the device config
            case "setChild":
                store.Update(s =>
                {
                    if (a?["name"] != null) s.ChildName = Str(a, "name", 80);
                    if (a?["voice"] is JsonNode v && v.GetValue<string>() is { Length: > 0 } vs && vs.Length < 80) s.NarratorVoice = vs;
                    if (a?["levels"] != null) { var l = Str(a, "levels", 2000); try { JsonDocument.Parse(l).Dispose(); s.ChildLevels = l; } catch (JsonException) { } }
                    if (a?["id"] != null) s.ChildId = Str(a, "id", 60);
                });
                return null;
            case "setAppAccountToken":
                store.Update(s => s.AppAccountToken = Str(a, "token", 60));
                return null;
            case "setAllowedHosts":
            {
                var hosts = (a?["hosts"] as JsonArray)?.Select(h => h?.GetValue<string>() ?? "").Where(h => h.Length is > 0 and < 254).Take(500) ?? Array.Empty<string>();
                store.Update(s => s.AllowedHosts = Hosts.Normalize(hosts).ToList());
                return null;
            }

            // ---- Other apps: what the shell found on the device, and what a parent allowed.
            case "setOtherCatalog":
            {
                var apps = (a?["apps"] as JsonArray) ?? new JsonArray();
                store.Update(s =>
                {
                    foreach (var x in apps.Take(400))
                    {
                        var target = x?["target"]?.GetValue<string>() ?? "";
                        var label = x?["label"]?.GetValue<string>() ?? "";
                        if (target.Length is 0 or > 400 || label.Length is 0 or > 80) continue;
                        s.OtherCatalog[OtherAppId.For(target)] = new OtherApp(target, label);
                    }
                });
                return null;
            }
            case "setOtherApps":
            {
                var ids = (a?["ids"] as JsonArray)?.Select(i => i?.GetValue<string>() ?? "").Where(i => i.StartsWith("win.app.h") && i.Length < 40).Distinct().Take(200).ToList() ?? new();
                var changed = store.Update(s => { var c = !s.OtherAllowed.OrderBy(x => x).SequenceEqual(ids.OrderBy(x => x)); s.OtherAllowed = ids; return c; });
                var applied = changed && lockdown.RefreshKioskIfNeeded();
                return new { applied };
            }
            case "otherAppTarget":
            {
                // What the shell launches for an allowed app, and whether Windows already allows it in this session
                // (the kiosk profile is read at sign-in, so an app allowed since then needs the child signed in again).
                var id = Str(a, "id", 40);
                return store.Read(s =>
                {
                    if (!s.OtherAllowed.Contains(id) || !s.OtherCatalog.TryGetValue(id, out var app)) return (object)new { allowed = false };
                    var inSession = !s.LockdownOn || s.SessionKioskTargets.Contains(app.Target, StringComparer.OrdinalIgnoreCase);
                    return new { allowed = true, target = app.Target, label = app.Label, restartNeeded = !inSession };
                });
            }
            case "restartSession":
            {
                // Signs the child out; automatic sign-in brings her back with the current kiosk profile. Harmless,
                // so it does not need the PIN (the home screen offers it when a newly allowed app needs it).
                var account = store.Read(s => s.ChildAccount);
                var session = account == "" ? null : Sessions.Of(account);
                if (session == null) return new { signedOut = false };
                return new { signedOut = Sessions.Logoff(session.Id) };
            }

            // ---- Lockdown
            case "lockdownStatus":
            {
                var st = lockdown.Status();
                return store.Read(s =>
                {
                    var auto = st["autoSignInUser"]?.GetValue<string>() ?? "";
                    var kiosk = st["kioskApplied"]?.GetValue<bool>() == true;
                    var supported = st["kioskSupported"]?.GetValue<bool>() == true;
                    var current = Sessions.List().FirstOrDefault(x => x.Active);
                    return new
                    {
                        homeRole = s.ChildAccount != "" && auto.Equals(s.ChildAccount, StringComparison.OrdinalIgnoreCase),
                        deviceSecure = supported,
                        pinned = s.ChildAccount != "" && current != null && current.User.Equals(s.ChildAccount, StringComparison.OrdinalIgnoreCase),
                        lockdownOn = s.LockdownOn && kiosk,
                        windows = new
                        {
                            edition = st["edition"]?.GetValue<string>(), productName = st["productName"]?.GetValue<string>(), build = st["build"]?.GetValue<int>(),
                            kioskSupported = supported, accounts = st["accounts"], childAccount = s.ChildAccount, autoSignInUser = auto,
                            kioskApplied = kiosk, otherKiosk = st["otherKiosk"]?.GetValue<bool>() == true, oldKidTablet = st["oldKidTablet"]?.GetValue<bool>() == true,
                            currentUser = current?.User ?? "", parentPresent = ParentPresent,
                        },
                    };
                });
            }
            case "setChildAccount":
            {
                NeedParent();
                var name = Str(a, "name", 20).Trim();
                var full = Str(a, "fullName", 64).Trim();
                if (name.Length == 0) throw new ServiceError("Give the account a name.");
                var current = Sessions.List().FirstOrDefault(x => x.Active);
                if (current != null && current.User.Equals(name, StringComparison.OrdinalIgnoreCase) && store.Read(s => s.ChildAccount) == "")
                    throw new ServiceError("That is the account in use right now. Choose or create the child's own account.");
                var r = lockdown.Run("EnsureChild", ("UserName", name), ("FullName", full.Length > 0 ? full : name));
                store.Update(s => s.ChildAccount = name);
                try { lockdown.Run("ChildSettings", ("UserName", name)); } catch (ServiceError) { /* no profile yet: applied at her first sign-in */ }
                return r;
            }
            case "setLockdown":
            {
                var on = a?["on"]?.GetValue<bool>() == true;
                if (on)
                {
                    if (store.Read(s => s.ChildAccount) == "") throw new ServiceError("Choose the child's Windows account first.");
                    var st = lockdown.Status();
                    if (st["oldKidTablet"]?.GetValue<bool>() == true) lockdown.Run("MigrateKidTablet", ("Destination", Paths.OldKidTabletDir), ("UserName", store.Read(s => s.ChildAccount)));
                    lockdown.ApplyKiosk();
                }
                else { NeedParent(); lockdown.RemoveKiosk(); }
                return null;
            }
            case "restartDevice":
                NeedParent();
                Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "shutdown.exe"), "/r /t 5 /c \"Duckling is restarting into the child's account.\"") { UseShellExecute = false, CreateNoWindow = true });
                return null;

            // ---- Wi-Fi (parent area)
            case "wifiNetworks":
                return Wifi.Scan().Select(n => new { ssid = n.Ssid, signal = n.Signal, secured = n.Secured, connected = n.Connected });
            case "wifiConnect":
                NeedParent();
                Wifi.Connect(Str(a, "ssid", 32), Str(a, "password", 63));
                return null;

            // ---- Removal: lockdown off, automatic sign-in off, state and apps gone, then the MSI uninstalls itself.
            case "release":
            {
                NeedParent();
                var account = store.Read(s => s.ChildAccount);
                try { lockdown.Run("Release", ("UserName", account)); } catch (ServiceError e) { Log.Error("release: " + e.Message); }
                foreach (var id in store.Read(s => s.Installed.Keys.ToList())) packages.Uninstall(id);
                store.Reset();
                parentUntil = DateTime.MinValue;
                OnReleased?.Invoke(account);
                return null;
            }

            default:
                throw new ServiceError($"Unknown request {op}.");
        }
    }
}
