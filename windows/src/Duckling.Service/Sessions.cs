using System.Runtime.InteropServices;

namespace Duckling.Service;

/// <summary>Windows sessions on this device (Terminal Services API): who is signed in, and signing one out.</summary>
public static class Sessions
{
    [DllImport("wtsapi32.dll", SetLastError = true)]
    static extern bool WTSEnumerateSessions(IntPtr server, int reserved, int version, out IntPtr info, out int count);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WTSQuerySessionInformation(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll", SetLastError = true)]
    static extern bool WTSLogoffSession(IntPtr server, int sessionId, bool wait);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WTS_SESSION_INFO { public int SessionId; public string WinStationName; public int State; }

    const int WTSUserName = 5, WTSActive = 0, WTSDisconnected = 4;

    public record Session(int Id, string User, bool Active);

    public static List<Session> List()
    {
        var list = new List<Session>();
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var ptr, out var count)) return list;
        try
        {
            int size = Marshal.SizeOf<WTS_SESSION_INFO>();
            for (int i = 0; i < count; i++)
            {
                var si = Marshal.PtrToStructure<WTS_SESSION_INFO>(ptr + i * size);
                if (si.SessionId == 0) continue;
                if (!WTSQuerySessionInformation(IntPtr.Zero, si.SessionId, WTSUserName, out var buf, out _)) continue;
                var user = Marshal.PtrToStringUni(buf) ?? "";
                WTSFreeMemory(buf);
                if (user.Length > 0 && (si.State == WTSActive || si.State == WTSDisconnected)) list.Add(new Session(si.SessionId, user, si.State == WTSActive));
            }
        }
        finally { WTSFreeMemory(ptr); }
        return list;
    }

    public static Session? Of(string user) => List().FirstOrDefault(s => s.User.Equals(user, StringComparison.OrdinalIgnoreCase));

    public static bool Logoff(int sessionId) => WTSLogoffSession(IntPtr.Zero, sessionId, false);
}
