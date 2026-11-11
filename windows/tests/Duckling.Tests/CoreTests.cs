using System.IO.Compression;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Duckling;
using Duckling.Service;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;
using Xunit;

namespace Duckling.Tests;

// A publishing key made for the tests; packages are signed with it the way tools/publish.mjs signs real ones.
public sealed class TestKey
{
    public readonly Ed25519PrivateKeyParameters Private;
    public readonly string PublicB64;
    public TestKey()
    {
        var g = new Ed25519KeyPairGenerator(); g.Init(new Ed25519KeyGenerationParameters(new SecureRandom()));
        var kp = g.GenerateKeyPair();
        Private = (Ed25519PrivateKeyParameters)kp.Private;
        PublicB64 = Convert.ToBase64String(((Ed25519PublicKeyParameters)kp.Public).GetEncoded());
    }
    public string Sign(byte[] data) { var s = new Ed25519Signer(); s.Init(true, Private); s.BlockUpdate(data, 0, data.Length); return Convert.ToBase64String(s.GenerateSignature()); }

    public static byte[] Zip(params (string Name, string Text)[] files)
    {
        using var ms = new MemoryStream();
        using (var z = new ZipArchive(ms, ZipArchiveMode.Create, true))
            foreach (var (n, t) in files) { using var w = new StreamWriter(z.CreateEntry(n).Open()); w.Write(t); }
        return ms.ToArray();
    }
}

class FakeHttp(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct) => Task.FromResult(answer(r));
}

public class CoreTests : IDisposable
{
    readonly string dir = Path.Combine(Path.GetTempPath(), "duckling-test-" + Guid.NewGuid().ToString("N"));
    readonly TestKey key = new();
    public void Dispose() { try { Directory.Delete(dir, true); } catch (Exception) { } }

    [Fact]
    public void Hosts_allow_own_listed_and_subdomains_only()
    {
        var allowed = Hosts.Normalize(new[] { "*.pbskids.org", " Epic.com ", "" });
        Assert.Equal(new[] { "pbskids.org", "epic.com" }, allowed);
        Assert.True(Hosts.IsAllowed("api.ducklingtablet.com", allowed));
        Assert.True(Hosts.IsAllowed("www.getepic.com".Replace("getepic", "epic"), allowed));
        Assert.True(Hosts.IsAllowed("pbskids.org", allowed));
        Assert.False(Hosts.IsAllowed("notepic.com", allowed));
        Assert.False(Hosts.IsAllowed("epic.com.evil.net", allowed));
        Assert.True(Hosts.IsAllowed("anything.example", new[] { "*" }));
        Assert.True(Hosts.IsAllowedUri("https://www.epic.com/app", allowed));
        Assert.False(Hosts.IsAllowedUri("file:///C:/Windows/win.ini", allowed));
        Assert.False(Hosts.IsAllowedUri("ftp://epic.com/", allowed));
    }

    [Fact]
    public void Pin_hash_matches_the_other_shells()
    {
        // SHA-256 of "duckling:1234", the value the Android shell and the server compute.
        Assert.Equal(Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes("duckling:1234"))), Pin.Hash("1234"));
        Assert.True(Pin.IsHash(Pin.Hash("0000")));
        Assert.False(Pin.IsHash("XYZ"));
    }

    [Fact]
    public void Production_key_verifies_nothing_unsigned_and_test_key_round_trips()
    {
        var data = Encoding.UTF8.GetBytes("package");
        Assert.True(Signing.Verify(data, key.Sign(data), key.PublicB64));
        Assert.False(Signing.Verify(data, key.Sign(data)));          // the production key did not sign it
        Assert.False(Signing.Verify(data, "not base64", key.PublicB64));
        Assert.Equal(32, Convert.FromBase64String(Signing.PublicKeyB64).Length);
    }

    [Fact]
    public void Packages_install_only_matching_signed_zips_and_stay_inside_their_folder()
    {
        var pk = new Packages(dir, new HttpClient(), key.PublicB64);
        var good = TestKey.Zip(("index.html", "<h1>hi</h1>"), ("js/app.js", "1"));
        pk.Unpack("word-wizard", good, Signing.Sha256Hex(good), key.Sign(good));
        Assert.True(pk.Has("word-wizard"));
        Assert.True(File.Exists(Path.Combine(dir, "word-wizard", "js", "app.js")));

        var e = Assert.Throws<InstallError>(() => pk.Unpack("word-wizard", good, new string('0', 64), key.Sign(good)));
        Assert.Contains("did not match", e.Message);
        Assert.Throws<InstallError>(() => pk.Unpack("word-wizard", good, Signing.Sha256Hex(good), new TestKey().Sign(good)));
        var evil = TestKey.Zip(("index.html", "x"), ("../escape.txt", "x"));
        Assert.Throws<InstallError>(() => pk.Unpack("evil-app", evil, Signing.Sha256Hex(evil), key.Sign(evil)));
        Assert.False(File.Exists(Path.Combine(Path.GetDirectoryName(dir)!, "escape.txt")));
        var noIndex = TestKey.Zip(("readme.txt", "x"));
        Assert.Throws<InstallError>(() => pk.Unpack("no-index", noIndex, Signing.Sha256Hex(noIndex), key.Sign(noIndex)));
        Assert.False(pk.Has("no-index"));
        Assert.Throws<InstallError>(() => pk.Unpack("../bad", good, Signing.Sha256Hex(good), key.Sign(good)));

        // A new version replaces the old one in place.
        var v2 = TestKey.Zip(("index.html", "<h1>v2</h1>"));
        pk.Unpack("word-wizard", v2, Signing.Sha256Hex(v2), key.Sign(v2));
        Assert.Equal("<h1>v2</h1>", File.ReadAllText(Path.Combine(dir, "word-wizard", "index.html")));
        Assert.False(File.Exists(Path.Combine(dir, "word-wizard", "js", "app.js")));
        pk.Uninstall("word-wizard");
        Assert.False(pk.Has("word-wizard"));
    }

    [Fact]
    public async Task Packages_download_over_https_only()
    {
        var zip = TestKey.Zip(("index.html", "ok"));
        var http = new HttpClient(new FakeHttp(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(zip) }));
        var pk = new Packages(dir, http, key.PublicB64);
        await pk.Install("count-with-me", "https://cdn.example/p.zip", Signing.Sha256Hex(zip), key.Sign(zip));
        Assert.True(pk.Has("count-with-me"));
        await Assert.ThrowsAsync<InstallError>(() => pk.Install("count-with-me", "http://cdn.example/p.zip", Signing.Sha256Hex(zip), key.Sign(zip)));
    }

    [Fact]
    public void Kiosk_profile_allows_duckling_webview2_and_allowed_apps_and_hides_the_taskbar()
    {
        var xml = Kiosk.Xml(@"SURFACE\Scarlett", @"C:\Program Files\Duckling Tablet\Duckling.exe",
            new[] { @"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\131.0.2903.70\msedgewebview2.exe" },
            new Kiosk.Allowed(new[] { @"C:\Program Files\Tux Paint\tuxpaint.exe" }, new[] { "Microsoft.Paint_8wekyb3d8bbwe!App" }),
            @"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Duckling Tablet.lnk");
        var doc = XDocument.Parse(xml);
        XNamespace ns = "http://schemas.microsoft.com/AssignedAccess/2017/config", rs5 = "http://schemas.microsoft.com/AssignedAccess/201810/config";
        var apps = doc.Descendants(ns + "App").ToList();
        Assert.Equal(4, apps.Count);
        var duck = apps.Single(a => (string?)a.Attribute("DesktopAppPath") == @"C:\Program Files\Duckling Tablet\Duckling.exe");
        Assert.Equal("true", (string?)duck.Attribute(rs5 + "AutoLaunch"));
        Assert.Contains(apps, a => (string?)a.Attribute("AppUserModelId") == "Microsoft.Paint_8wekyb3d8bbwe!App");
        Assert.Equal(@"SURFACE\Scarlett", doc.Descendants(ns + "Account").Single().Value);
        Assert.Equal("false", (string?)doc.Descendants(ns + "Taskbar").Single().Attribute("ShowTaskbar"));
        Assert.Contains("Duckling Tablet.lnk", xml);
        // Names with XML characters are escaped.
        Assert.Contains("&amp;", Kiosk.Xml(@"PC\A&B", @"C:\D.exe", Array.Empty<string>(), new Kiosk.Allowed(Array.Empty<string>(), Array.Empty<string>()), null));
    }

    [Fact]
    public void WebView2_runtime_folders_are_found_by_version()
    {
        foreach (var v in new[] { "130.0.1.2", "131.0.2903.70", "SetupMetrics" }) Directory.CreateDirectory(Path.Combine(dir, v));
        File.WriteAllText(Path.Combine(dir, "130.0.1.2", "msedgewebview2.exe"), "");
        File.WriteAllText(Path.Combine(dir, "131.0.2903.70", "msedgewebview2.exe"), "");
        Assert.Equal(2, Kiosk.WebView2Executables(dir).Count);
    }

    [Fact]
    public void Other_app_ids_fit_the_server_pattern_and_targets_are_classified()
    {
        var id = OtherAppId.For(@"C:\Program Files\Tux Paint\tuxpaint.exe");
        Assert.Matches(@"^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$", id);
        Assert.Equal(id, OtherAppId.For(@"c:\program files\tux paint\TUXPAINT.EXE"));
        Assert.True(OtherAppId.IsAumid("Microsoft.Paint_8wekyb3d8bbwe!App"));
        Assert.False(OtherAppId.IsAumid(@"C:\Program Files\x!y_z\a.exe"));
        Assert.True(OtherAppId.IsProtectedPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "App", "a.exe")));
        Assert.False(OtherAppId.IsProtectedPath(Path.Combine(Path.GetTempPath(), "a.exe")));
    }

    [Fact]
    public void Wifi_profiles_are_valid_xml_with_the_password_escaped()
    {
        var x = XDocument.Parse(Wifi.ProfileXml("Cafe & Co", "WPA2PSK", "pa<ss>&word"));
        XNamespace ns = "http://www.microsoft.com/networking/WLAN/profile/v1";
        Assert.Equal("Cafe & Co", x.Descendants(ns + "name").First().Value);
        Assert.Equal("pa<ss>&word", x.Descendants(ns + "keyMaterial").Single().Value);
        Assert.Equal("WPA2PSK", x.Descendants(ns + "authentication").Single().Value);
        Assert.Equal("open", XDocument.Parse(Wifi.ProfileXml("Plane", "open", null)).Descendants(ns + "authentication").Single().Value);
        Assert.Equal("WPA3SAE", XDocument.Parse(Wifi.ProfileXml("Home", "WPA3SAE", "secret12")).Descendants(ns + "authentication").Single().Value);
    }

    [Fact]
    public void Versions_compare_numerically()
    {
        Assert.True(Versions.Compare("1.0.10", "1.0.9") > 0);
        Assert.Equal(0, Versions.Compare("1.2", "1.2.0"));
        Assert.True(Versions.Compare("0.9.9", "1.0.0") < 0);
    }
}

public class HandlerTests : IDisposable
{
    readonly string dir = Path.Combine(Path.GetTempPath(), "duckling-handlers-" + Guid.NewGuid().ToString("N"));
    readonly TestKey key = new();
    DateTime now = new(2026, 11, 10, 12, 0, 0, DateTimeKind.Utc);
    public void Dispose() { try { Directory.Delete(dir, true); } catch (Exception) { } }

    (Handlers h, Store store) Make(byte[]? zip = null)
    {
        var store = new Store(Path.Combine(dir, "state", "state.json"));
        var http = new HttpClient(new FakeHttp(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(zip ?? Array.Empty<byte>()) }));
        var packages = new Packages(Path.Combine(dir, "apps"), http, key.PublicB64);
        return (new Handlers(store, packages, new Lockdown(store, Path.Combine(dir, "none.ps1")), () => now), store);
    }
    static JsonNode Args(object o) => JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(o))!;

    [Fact]
    public void Pin_opens_a_parent_window_that_gates_what_loosens_the_device()
    {
        var (h, store) = Make();
        // No PIN yet (first setup): the parent is the one holding the device.
        h.Handle("setPin", Args(new { pin = "2468" }));
        Assert.Equal(Pin.Hash("2468"), store.Read(s => s.PinHash));
        now = now.AddHours(1);
        var e = Assert.Throws<ServiceError>(() => h.Handle("setPin", Args(new { pin = "1111" })));
        Assert.Contains("parent PIN", e.Message);
        Assert.Throws<ServiceError>(() => h.Handle("release", null));
        Assert.Throws<ServiceError>(() => h.Handle("setLockdown", Args(new { on = false })));
        Assert.False((bool)h.Handle("verifyPin", Args(new { pin = "0000" }))!);
        Assert.True((bool)h.Handle("verifyPin", Args(new { pin = "2468" }))!);
        h.Handle("setPin", Args(new { pin = "1111" }));
        Assert.Equal(Pin.Hash("1111"), store.Read(s => s.PinHash));
        // The window lasts 30 minutes, and leaving the parent area ends it.
        now = now.AddMinutes(31);
        Assert.Throws<ServiceError>(() => h.Handle("setPin", Args(new { pin = "2222" })));
        h.Handle("verifyPin", Args(new { pin = "1111" }));
        h.Handle("endParent", null);
        Assert.Throws<ServiceError>(() => h.Handle("setPin", Args(new { pin = "2222" })));
        // The server's PIN replaces the device's (only a well-formed hash).
        h.Handle("setPinHash", Args(new { hash = Pin.Hash("9999") }));
        h.Handle("setPinHash", Args(new { hash = "nonsense" }));
        Assert.Equal(Pin.Hash("9999"), store.Read(s => s.PinHash));
        Assert.Throws<ServiceError>(() => h.Handle("setPin", Args(new { pin = "12" })));
    }

    [Fact]
    public void Installs_record_versions_and_permissions_and_state_reports_only_apps_on_disk()
    {
        var zip = TestKey.Zip(("index.html", "<p>app</p>"));
        var (h, store) = Make(zip);
        h.Handle("install", Args(new { id = "camera-fun", version = "1.0.2", url = "https://cdn.example/c.zip", sha256 = Signing.Sha256Hex(zip), signature = key.Sign(zip), permissions = new[] { "camera" } }));
        h.Handle("setDeviceToken", Args(new { token = "dev-token" }));
        h.Handle("setChild", Args(new { name = "Scarlett", levels = "{\"math\":2}", id = "chd_1", voice = "en-US-AnaNeural" }));
        h.Handle("setChild", Args(new { levels = "{not json" }));
        h.Handle("setAllowedHosts", Args(new { hosts = new[] { "*.pbskids.org", "epic.com" } }));
        var st = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(h.Handle("state", null)))!;
        Assert.Equal("1.0.2", st["installed"]!["camera-fun"]!.GetValue<string>());
        Assert.Equal("camera", st["permissions"]!["camera-fun"]![0]!.GetValue<string>());
        Assert.Equal("dev-token", st["deviceToken"]!.GetValue<string>());
        Assert.Equal("Scarlett", st["childName"]!.GetValue<string>());
        Assert.Equal("{\"math\":2}", st["childLevels"]!.GetValue<string>());
        Assert.Equal(new[] { "pbskids.org", "epic.com" }, st["allowedHosts"]!.AsArray().Select(x => x!.GetValue<string>()));
        Directory.Delete(Path.Combine(dir, "apps", "camera-fun"), true);
        st = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(h.Handle("state", null)))!;
        Assert.Null(st["installed"]!["camera-fun"]);
        Assert.Throws<ServiceError>(() => h.Handle("nope", null));
    }

    [Fact]
    public void Other_apps_need_the_catalog_and_the_parent_and_a_new_one_needs_a_new_sign_in_under_the_kiosk()
    {
        var (h, store) = Make();
        var paint = "Microsoft.Paint_8wekyb3d8bbwe!App";
        h.Handle("setOtherCatalog", Args(new { apps = new[] { new { target = paint, label = "Paint" } } }));
        var id = OtherAppId.For(paint);
        var t = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(h.Handle("otherAppTarget", Args(new { id }))))!;
        Assert.False(t["allowed"]!.GetValue<bool>());
        h.Handle("setOtherApps", Args(new { ids = new[] { id, "bogus" } }));
        Assert.Equal(new[] { id }, store.Read(s => s.OtherAllowed));
        t = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(h.Handle("otherAppTarget", Args(new { id }))))!;
        Assert.Equal(paint, t["target"]!.GetValue<string>());
        Assert.False(t["restartNeeded"]!.GetValue<bool>());   // no kiosk: launches at once
        store.Update(s => { s.LockdownOn = true; s.SessionKioskTargets = new(); });
        t = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(h.Handle("otherAppTarget", Args(new { id }))))!;
        Assert.True(t["restartNeeded"]!.GetValue<bool>());
        store.Update(s => s.SessionKioskTargets = new() { paint });
        t = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(h.Handle("otherAppTarget", Args(new { id }))))!;
        Assert.False(t["restartNeeded"]!.GetValue<bool>());
    }
}

public class OldStarsTests : IDisposable
{
    readonly string users = Path.Combine(Path.GetTempPath(), "duckling-users-" + Guid.NewGuid().ToString("N"));
    public void Dispose() { try { Directory.Delete(users, true); } catch (Exception) { } }

    string OldFolder(string user, int stars, string avatarJson, bool portrait)
    {
        var d = Path.Combine(users, user, "AppData", "Local", "KidTablet", "avatar");
        Directory.CreateDirectory(d);
        File.WriteAllText(Path.Combine(d, "stars.txt"), stars.ToString());
        File.WriteAllText(Path.Combine(d, "avatar.json"), avatarJson);
        if (portrait) { var png = new byte[200]; new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }.CopyTo(png, 0); File.WriteAllBytes(Path.Combine(d, "portrait.png"), png); }
        return d;
    }

    [Fact]
    public void Finds_the_old_folder_with_the_most_stars()
    {
        OldFolder("Kid", 412, """{"design":{"hair":"curly"},"owned":["hat-crown","pet-cat"],"spent":150,"earned":412}""", true);
        OldFolder("Chris", 3, """{"design":{}}""", false);
        Directory.CreateDirectory(Path.Combine(users, "Public"));
        var f = OldStars.Best(OldStars.Folders(users))!;
        Assert.Equal(412, f.Earned);
        Assert.Equal(150, f.Spent);
        Assert.Equal(new[] { "hat-crown", "pet-cat" }, f.Owned);
        Assert.Equal("curly", f.Design!["hair"]!.GetValue<string>());
        Assert.NotNull(f.Portrait);
        Assert.Null(OldStars.Best(OldStars.Folders(Path.Combine(users, "missing"))));
    }

    [Fact]
    public void Merge_keeps_the_current_avatar_adds_spending_once()
    {
        var old = new OldStars.Found("x", 412, new JsonObject { ["hair"] = "curly" }, new() { "hat-crown", "pet-cat" }, 150, null);
        var server = JsonNode.Parse("""{"design":{"hair":"bun"},"owned":["pet-cat","shoes-red"],"spent":20,"savedAt":5000,"earned":90}""");
        var (body, usedOld) = OldStars.Merge(server, old, 1000).Value;
        Assert.False(usedOld);
        Assert.Equal("bun", body["design"]!["hair"]!.GetValue<string>());
        Assert.Equal(170, body["spent"]!.GetValue<int>());
        Assert.Equal(new[] { "pet-cat", "shoes-red", "hat-crown", OldStars.Marker }, body["owned"]!.AsArray().Select(x => x!.GetValue<string>()));
        Assert.Equal(5001, body["savedAt"]!.GetValue<double>());
        // A second run (the marker is on the server now) changes nothing.
        Assert.Null(OldStars.Merge(JsonNode.Parse(body.ToJsonString()), old, 9000));
        // No avatar on the server yet: the old one is used, with its portrait.
        var (fresh, usedOld2) = OldStars.Merge(JsonNode.Parse("""{"design":null,"owned":[],"spent":0,"savedAt":0}"""), old, 1000).Value;
        Assert.True(usedOld2);
        Assert.Equal("curly", fresh["design"]!["hair"]!.GetValue<string>());
        Assert.Equal(150, fresh["spent"]!.GetValue<int>());
    }

    [Fact]
    public async Task Import_sends_stars_before_the_avatar_and_retries_on_failure()
    {
        var calls = new List<string>();
        var fail = true;
        var http = new HttpClient(new FakeHttp(r =>
        {
            Assert.Equal("Device tok", r.Headers.Authorization!.ToString());
            var body = r.Content?.ReadAsStringAsync().Result ?? "";
            calls.Add($"{r.Method} {r.RequestUri!.AbsolutePath} {body}");
            if (r.Method == HttpMethod.Get) return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("""{"design":null,"owned":[],"spent":0,"savedAt":0,"earned":0,"earnedByApp":{}}""") };
            if (fail) return new HttpResponseMessage(HttpStatusCode.Conflict);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") };
        }));
        var d = OldFolder("Kid", 412, """{"design":{"hair":"curly"},"owned":["hat-crown"],"spent":150}""", true);
        var old = OldStars.Read(d)!;
        Assert.False(await OldStars.Import(http, "https://api.test", "tok", old, CancellationToken.None, () => 1000));
        Assert.Equal(2, calls.Count);
        calls.Clear(); fail = false;
        Assert.True(await OldStars.Import(http, "https://api.test", "tok", old, CancellationToken.None, () => 1000));
        Assert.Equal(4, calls.Count);
        Assert.StartsWith("POST /device/child/stars {\"appId\":\"kidtablet\",\"earned\":412}", calls[1]);
        Assert.StartsWith("PUT /device/child/avatar", calls[2]);
        Assert.Contains("\"spent\":150", calls[2]);
        Assert.StartsWith("PUT /device/child/portrait data:image/png;base64,", calls[3]);
    }
}
