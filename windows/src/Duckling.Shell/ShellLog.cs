namespace Duckling.Shell;

/// <summary>shell.log in the account's own %LOCALAPPDATA%\Duckling (the shell cannot write the service's log
/// folder). What happened, never tokens or PINs.</summary>
public static class ShellLog
{
    static readonly object gate = new();
    static string FilePath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Duckling", "shell.log");

    /// <summary>The end of the log, at most this many characters, for a diagnostics report from the parent area.</summary>
    public static string Tail(int chars = 60_000)
    {
        try
        {
            lock (gate)
            {
                if (!File.Exists(FilePath)) return "";
                var text = File.ReadAllText(FilePath);
                if (text.Length < chars && File.Exists(FilePath + ".old")) text = File.ReadAllText(FilePath + ".old") + text;
                return text.Length > chars ? text[^chars..] : text;
            }
        }
        catch (Exception) { return ""; }
    }

    public static void Write(string message)
    {
        try
        {
            lock (gate)
            {
                var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Duckling");
                Directory.CreateDirectory(dir);
                var file = Path.Combine(dir, "shell.log");
                var fi = new FileInfo(file);
                if (fi.Exists && fi.Length > 512 * 1024) { File.Copy(file, file + ".old", true); File.WriteAllText(file, ""); }
                File.AppendAllText(file, $"{DateTime.UtcNow:yyyy-MM-dd HH:mm:ss}Z {message}{Environment.NewLine}");
            }
        }
        catch (Exception) { }
    }
}
