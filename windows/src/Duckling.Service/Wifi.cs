using System.Runtime.InteropServices;
using System.Security;
using System.Text;

namespace Duckling.Service;

/// <summary>Wi-Fi from the parent area (Native Wifi API, as SYSTEM): the networks in range, and joining one with its
/// password. The kiosk keeps Windows' own network settings out of reach, so this is how a parent joins a hotel's or
/// a plane's network. A network that needs a sign-in page opens in the parent browser afterwards.</summary>
public static class Wifi
{
    [DllImport("wlanapi.dll")] static extern int WlanOpenHandle(uint clientVersion, IntPtr reserved, out uint negotiated, out IntPtr handle);
    [DllImport("wlanapi.dll")] static extern int WlanCloseHandle(IntPtr handle, IntPtr reserved);
    [DllImport("wlanapi.dll")] static extern int WlanEnumInterfaces(IntPtr handle, IntPtr reserved, out IntPtr list);
    [DllImport("wlanapi.dll")] static extern int WlanScan(IntPtr handle, ref Guid iface, IntPtr ssid, IntPtr ie, IntPtr reserved);
    [DllImport("wlanapi.dll")] static extern int WlanGetAvailableNetworkList(IntPtr handle, ref Guid iface, uint flags, IntPtr reserved, out IntPtr list);
    [DllImport("wlanapi.dll", CharSet = CharSet.Unicode)] static extern int WlanSetProfile(IntPtr handle, ref Guid iface, uint flags, string xml, string? security, bool overwrite, IntPtr reserved, out uint reason);
    [DllImport("wlanapi.dll")] static extern int WlanConnect(IntPtr handle, ref Guid iface, ref WLAN_CONNECTION_PARAMETERS p, IntPtr reserved);
    [DllImport("wlanapi.dll")] static extern void WlanFreeMemory(IntPtr memory);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WLAN_CONNECTION_PARAMETERS { public int wlanConnectionMode; [MarshalAs(UnmanagedType.LPWStr)] public string strProfile; public IntPtr pDot11Ssid; public IntPtr pDesiredBssidList; public int dot11BssType; public uint dwFlags; }

    public record Network(string Ssid, int Signal, bool Secured, bool Connected, string Auth);

    static IntPtr Open() { if (WlanOpenHandle(2, IntPtr.Zero, out _, out var h) != 0) throw new ServiceError("This device has no Wi-Fi."); return h; }

    static List<Guid> Interfaces(IntPtr h)
    {
        var ids = new List<Guid>();
        if (WlanEnumInterfaces(h, IntPtr.Zero, out var list) != 0) return ids;
        try
        {
            int n = Marshal.ReadInt32(list);
            // WLAN_INTERFACE_INFO_LIST: dwNumberOfItems, dwIndex, then items of { GUID, WCHAR[256], state } (532 bytes).
            for (int i = 0; i < n; i++) ids.Add(Marshal.PtrToStructure<Guid>(list + 8 + i * 532));
        }
        finally { WlanFreeMemory(list); }
        return ids;
    }

    // dot11 auth algorithms: 1 open, 2 shared key, 3 WPA, 4 WPA-PSK, 6 RSNA, 7 RSNA-PSK (WPA2), 8 WPA3, 9 WPA3-SAE, 10 OWE.
    static string AuthName(int a) => a switch { 1 => "open", 4 => "WPA-PSK", 7 => "WPA2PSK", 9 => "WPA3SAE", 8 => "WPA3", 6 => "WPA2", 3 => "WPA", 10 => "OWE", 2 => "shared", _ => "other" };

    public static List<Network> Scan()
    {
        var h = Open();
        try
        {
            var found = new Dictionary<string, Network>();
            foreach (var iface in Interfaces(h))
            {
                var id = iface;
                WlanScan(h, ref id, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
                Thread.Sleep(2500);
                if (WlanGetAvailableNetworkList(h, ref id, 0, IntPtr.Zero, out var list) != 0) continue;
                try
                {
                    int n = Marshal.ReadInt32(list);
                    // WLAN_AVAILABLE_NETWORK (628 bytes): profile name WCHAR[256] at 0, DOT11_SSID (length, 32 bytes) at
                    // 512, bss type 548, BSSID count 552, connectable 556, reason 560, phy type count 564, phy types
                    // 568 (8 x 4), more phy types 600, signal quality 604, security enabled 608, auth 612, cipher 616,
                    // flags 620 (1 = connected), reserved 624.
                    for (int i = 0; i < n; i++)
                    {
                        var p = list + 8 + i * 628;
                        int ssidLen = Marshal.ReadInt32(p + 512);
                        var bytes = new byte[Math.Clamp(ssidLen, 0, 32)];
                        Marshal.Copy(p + 516, bytes, 0, bytes.Length);
                        var ssid = Encoding.UTF8.GetString(bytes);
                        if (ssid.Length == 0) continue;
                        int signal = Marshal.ReadInt32(p + 604);
                        bool secured = Marshal.ReadInt32(p + 608) != 0;
                        int auth = Marshal.ReadInt32(p + 612);
                        int flags = Marshal.ReadInt32(p + 620);
                        bool connected = (flags & 1) != 0;
                        var net = new Network(ssid, signal, secured, connected, AuthName(auth));
                        if (!found.TryGetValue(ssid, out var prev) || prev.Signal < signal || connected) found[ssid] = net with { Connected = connected || (prev?.Connected ?? false) };
                    }
                }
                finally { WlanFreeMemory(list); }
            }
            return found.Values.OrderByDescending(n => n.Connected).ThenByDescending(n => n.Signal).ToList();
        }
        finally { WlanCloseHandle(h, IntPtr.Zero); }
    }

    public static string ProfileXml(string ssid, string auth, string? password)
    {
        var name = SecurityElement.Escape(ssid);
        var hex = Convert.ToHexString(Encoding.UTF8.GetBytes(ssid));
        string security;
        if (auth == "open" || string.IsNullOrEmpty(password))
            security = "<authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption>";
        else
        {
            var a = auth is "WPA3SAE" or "WPA3" ? "WPA3SAE" : auth == "WPA-PSK" ? "WPAPSK" : "WPA2PSK";
            security = $"<authEncryption><authentication>{a}</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>" +
                       $"<sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>{SecurityElement.Escape(password)}</keyMaterial></sharedKey>";
        }
        return $"<?xml version=\"1.0\"?><WLANProfile xmlns=\"http://www.microsoft.com/networking/WLAN/profile/v1\"><name>{name}</name>" +
               $"<SSIDConfig><SSID><hex>{hex}</hex><name>{name}</name></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>auto</connectionMode>" +
               $"<MSM><security>{security}</security></MSM></WLANProfile>";
    }

    public static void Connect(string ssid, string? password)
    {
        var net = Scan().FirstOrDefault(n => n.Ssid == ssid) ?? throw new ServiceError("That network is out of range.");
        if (net.Secured && string.IsNullOrEmpty(password)) throw new ServiceError("This network needs its password.");
        if (net.Auth is not ("open" or "WPA-PSK" or "WPA2PSK" or "WPA3SAE" or "WPA3" or "OWE")) throw new ServiceError("This network needs a company sign-in, which Duckling cannot do. Join it from a parent's Windows account.");
        var h = Open();
        try
        {
            foreach (var iface in Interfaces(h))
            {
                var id = iface;
                if (WlanSetProfile(h, ref id, 0, ProfileXml(ssid, net.Auth, password), null, true, IntPtr.Zero, out var reason) != 0)
                    throw new ServiceError($"Windows did not accept the network settings (reason {reason}).");
                var p = new WLAN_CONNECTION_PARAMETERS { wlanConnectionMode = 0, strProfile = ssid, dot11BssType = 1 };
                if (WlanConnect(h, ref id, ref p, IntPtr.Zero) != 0) throw new ServiceError("Could not connect to that network.");
                return;
            }
            throw new ServiceError("This device has no Wi-Fi.");
        }
        finally { WlanCloseHandle(h, IntPtr.Zero); }
    }
}
