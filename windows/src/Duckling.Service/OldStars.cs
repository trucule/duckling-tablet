using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Duckling.Service;

/// <summary>Brings the child's stars and avatar from the Surface setup that came before Duckling (KidHome) into her
/// profile on the server, once. KidHome kept them in the child's own profile, %LOCALAPPDATA%\KidTablet\avatar:
/// stars.txt (stars earned in all her apps), avatar.json (what My Avatar saved: the design, what she owns, what she
/// spent) and portrait.png.
///
/// The old stars become one more entry in her star list (app id "kidtablet"), so her balance is what it was plus what
/// she has earned since. What she owns is added to what she owns now and what she spent is added to what she has spent,
/// so the balance stays right. Her current avatar and portrait stay; the old ones are used only when she has none.
/// A marker in her owned list keeps a second run from adding the spending twice.</summary>
public static class OldStars
{
    public const string AppId = "kidtablet";
    public const string Marker = "imported-kidtablet";

    public record Found(string Dir, int Earned, JsonObject? Design, List<string> Owned, int Spent, byte[]? Portrait);

    /// <summary>Every profile's old avatar folder under the users folder (C:\Users).</summary>
    public static IEnumerable<string> Folders(string usersRoot)
    {
        IEnumerable<string> users;
        try { users = Directory.EnumerateDirectories(usersRoot).ToList(); } catch (Exception) { yield break; }
        foreach (var u in users)
        {
            var d = Path.Combine(u, "AppData", "Local", "KidTablet", "avatar");
            if (Directory.Exists(d)) yield return d;
        }
    }

    public static Found? Read(string dir)
    {
        int earned = 0;
        try { var t = File.ReadAllText(Path.Combine(dir, "stars.txt")).Trim(); if (int.TryParse(t, out var n) && n > 0) earned = Math.Min(n, 1_000_000); } catch (Exception) { }
        JsonObject? design = null; var owned = new List<string>(); int spent = 0;
        try
        {
            if (JsonNode.Parse(File.ReadAllText(Path.Combine(dir, "avatar.json"), Encoding.UTF8)) is JsonObject a)
            {
                if (a["design"] is JsonObject d) design = (JsonObject)d.DeepClone();
                if (a["owned"] is JsonArray o) owned = o.Select(x => x is JsonValue v && v.TryGetValue<string>(out var s) ? s : null).Where(s => s is { Length: > 0 and <= 64 }).Select(s => s!).Distinct().ToList();
                if (a["spent"] is JsonValue sv && sv.TryGetValue<double>(out var sp) && sp > 0) spent = (int)Math.Min(sp, 1_000_000);
            }
        }
        catch (Exception) { }
        byte[]? portrait = null;
        try
        {
            var p = File.ReadAllBytes(Path.Combine(dir, "portrait.png"));
            if (p.Length is >= 100 and <= 600 * 1024 && p[0] == 0x89 && p[1] == 0x50 && p[2] == 0x4E && p[3] == 0x47) portrait = p;
        }
        catch (Exception) { }
        if (earned == 0 && design == null && spent == 0 && owned.Count == 0) return null;
        return new Found(dir, earned, design, owned, spent, portrait);
    }

    /// <summary>The old folder with the most stars (a tablet normally has one).</summary>
    public static Found? Best(IEnumerable<string> dirs) => dirs.Select(Read).Where(f => f != null).OrderByDescending(f => f!.Earned).ThenByDescending(f => f!.Spent).FirstOrDefault();

    /// <summary>The avatar to save, from what the server has now and what the old setup had; null when there is
    /// nothing to save (already imported, or no avatar on either side). UsedOldDesign says the old portrait goes with it.</summary>
    public static (JsonObject Body, bool UsedOldDesign)? Merge(JsonNode? server, Found old, double nowMs)
    {
        var owned = (server?["owned"] as JsonArray)?.Select(x => x is JsonValue v && v.TryGetValue<string>(out var s) ? s : null).Where(s => s != null).Select(s => s!).ToList() ?? new();
        if (owned.Contains(Marker)) return null;
        var serverDesign = server?["design"] as JsonObject;
        var design = serverDesign ?? old.Design;
        if (design == null) return null;
        var spent = 0;
        if (server?["spent"] is JsonValue sv && sv.TryGetValue<double>(out var s0) && s0 > 0) spent = (int)s0;
        var savedAt = 0.0;
        if (server?["savedAt"] is JsonValue tv && tv.TryGetValue<double>(out var t0)) savedAt = t0;
        var all = owned.Concat(old.Owned).Distinct().Where(x => x != Marker).Take(499).Append(Marker);
        var body = new JsonObject
        {
            ["design"] = design.DeepClone(),
            ["owned"] = new JsonArray(all.Select(x => (JsonNode)JsonValue.Create(x)!).ToArray()),
            ["spent"] = Math.Min(spent + old.Spent, 1_000_000),
            // Later than any save so far, so the server takes it and the other tablets restore it.
            ["savedAt"] = Math.Max(nowMs, savedAt + 1),
        };
        return (body, serverDesign == null);
    }

    /// <summary>Sends the old stars, avatar and portrait. True when the server has them (or there was nothing to
    /// send); false to try again later (no network, or the tablet not yet set up for a child).</summary>
    public static async Task<bool> Import(HttpClient http, string api, string deviceToken, Found old, CancellationToken ct, Func<double>? nowMs = null)
    {
        HttpRequestMessage Req(HttpMethod m, string path, HttpContent? body = null)
        {
            var r = new HttpRequestMessage(m, api + path) { Content = body };
            r.Headers.Authorization = new AuthenticationHeaderValue("Device", deviceToken);
            return r;
        }
        static StringContent Json(JsonNode n) => new(n.ToJsonString(), Encoding.UTF8, "application/json");

        using var get = await http.SendAsync(Req(HttpMethod.Get, "/device/child/avatar"), ct);
        if (!get.IsSuccessStatusCode) return false;
        var server = JsonNode.Parse(await get.Content.ReadAsStringAsync(ct));
        // Stars first, so the balance never drops below zero when the spending is added. A tablet not yet set up for a
        // child gets an error here, and the import is tried again later.
        if (old.Earned > 0)
        {
            using var st = await http.SendAsync(Req(HttpMethod.Post, "/device/child/stars", Json(new JsonObject { ["appId"] = AppId, ["earned"] = old.Earned })), ct);
            if (!st.IsSuccessStatusCode) return false;
        }
        var merged = Merge(server, old, (nowMs ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()))());
        if (merged is { } m)
        {
            using var put = await http.SendAsync(Req(HttpMethod.Put, "/device/child/avatar", Json(m.Body)), ct);
            if (!put.IsSuccessStatusCode) return false;
            if (m.UsedOldDesign && old.Portrait != null)
            {
                using var pic = await http.SendAsync(Req(HttpMethod.Put, "/device/child/portrait", new StringContent("data:image/png;base64," + Convert.ToBase64String(old.Portrait), Encoding.UTF8, "text/plain")), ct);
                if (!pic.IsSuccessStatusCode) Log.Error($"old portrait: {(int)pic.StatusCode}");
            }
        }
        return true;
    }
}
