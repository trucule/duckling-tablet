using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json.Nodes;

namespace Duckling.Service;

/// <summary>The DucklingTablet pipe. Open to signed-in users (the shell runs in the child's or a parent's session) and
/// to SYSTEM and Administrators; no network access. One request line, one response line per connection.</summary>
public class PipeServer(Handlers handlers, string name = Duckling.Paths.PipeName)
{
    public static PipeSecurity Security()
    {
        var ps = new PipeSecurity();
        ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.InteractiveSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        return ps;
    }

    public async Task Run(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            NamedPipeServerStream pipe;
            try
            {
                pipe = NamedPipeServerStreamAcl.Create(name, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 64 * 1024, 64 * 1024, Security());
            }
            catch (Exception e) { Log.Error($"pipe: {e.Message}"); await Task.Delay(2000, ct); continue; }
            try { await pipe.WaitForConnectionAsync(ct); }
            catch (OperationCanceledException) { pipe.Dispose(); break; }
            _ = Task.Run(() => Serve(pipe), CancellationToken.None);
        }
    }

    void Serve(NamedPipeServerStream pipe)
    {
        using (pipe)
        {
            try
            {
                using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, leaveOpen: true);
                using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true, NewLine = "\n" };
                var line = reader.ReadLine();
                if (line == null || line.Length > 1_000_000) return;
                string reply;
                string op = "?";
                try
                {
                    var req = JsonNode.Parse(line)!;
                    op = req["op"]?.GetValue<string>() ?? "";
                    reply = Protocol.Ok(handlers.Handle(op, req["args"]));
                }
                catch (ServiceError e) { reply = Protocol.Error(e.Message); }
                catch (InstallError e) { reply = Protocol.Error(e.Message); }
                catch (Exception e) { Log.Error($"{op}: {e.GetType().Name}: {e.Message}"); reply = Protocol.Error("Something went wrong on this device."); }
                writer.WriteLine(reply);
            }
            catch (IOException) { }
        }
    }
}
