namespace Duckling.Shell;

/// <summary>shell.log in the account's own %LOCALAPPDATA%\Duckling (the shell cannot write the service's log
/// folder). What happened, never tokens or PINs.</summary>
public static class ShellLog
{
    static readonly object gate = new();
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
                File.AppendAllText(file, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
            }
        }
        catch (Exception) { }
    }
}
