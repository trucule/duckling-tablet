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

    [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQueryUserToken(int sessionId, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attrs, int level, int type, out IntPtr newToken);
    [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
    [DllImport("userenv.dll", SetLastError = true)] static extern bool DestroyEnvironmentBlock(IntPtr env);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr token, string? app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string? dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO { public int cb; public string? lpReserved; public string? lpDesktop; public string? lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    /// <summary>Starts a program in a signed-in session as that session's user (the service runs as SYSTEM in
    /// session 0). Returns the process id, or 0.</summary>
    public static int StartInSession(int sessionId, string exe)
    {
        if (!WTSQueryUserToken(sessionId, out var userToken)) return 0;
        IntPtr primary = IntPtr.Zero, env = IntPtr.Zero;
        try
        {
            if (!DuplicateTokenEx(userToken, 0x02000000 /* MAXIMUM_ALLOWED */, IntPtr.Zero, 2 /* impersonation */, 1 /* primary */, out primary)) return 0;
            CreateEnvironmentBlock(out env, primary, false);
            var si = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>(), lpDesktop = @"winsta0\default" };
            var cmd = new System.Text.StringBuilder($"\"{exe}\"");
            if (!CreateProcessAsUser(primary, exe, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x00000400 /* CREATE_UNICODE_ENVIRONMENT */, env, Path.GetDirectoryName(exe), ref si, out var pi)) return 0;
            CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
            return pi.dwProcessId;
        }
        finally
        {
            if (env != IntPtr.Zero) DestroyEnvironmentBlock(env);
            if (primary != IntPtr.Zero) CloseHandle(primary);
            CloseHandle(userToken);
        }
    }
}
