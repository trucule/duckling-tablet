namespace Duckling.Service;

/// <summary>service.log under C:\ProgramData\Duckling\logs, kept under 1 MB (one previous file). Never tokens, PINs
/// or passwords: callers log what happened, not the values.</summary>
public static class Log
{
    static readonly object gate = new();
    public static string? Dir;

    public static void Info(string message) => Write("info", message);
    public static void Error(string message) => Write("error", message);

    static void Write(string level, string message)
    {
        try
        {
            lock (gate)
            {
                var dir = Dir ?? Duckling.Paths.LogsDir;
                Directory.CreateDirectory(dir);
                var file = Path.Combine(dir, "service.log");
                var fi = new FileInfo(file);
                if (fi.Exists && fi.Length > 1024 * 1024) File.Copy(file, file + ".old", true);
                if (fi.Exists && fi.Length > 1024 * 1024) File.WriteAllText(file, "");
                File.AppendAllText(file, $"{DateTime.UtcNow:yyyy-MM-dd HH:mm:ss}Z {level} {message}{Environment.NewLine}");
            }
        }
        catch (Exception) { }
    }
}
