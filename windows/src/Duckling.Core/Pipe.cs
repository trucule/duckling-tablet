using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Duckling;

/// <summary>The shell talks to the service over one named pipe, one JSON object per line each way:
/// {"op": "...", "args": {...}} and {"ok": true, "value": ...} or {"ok": false, "error": "..."}.</summary>
public static class Protocol
{
    public static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = false };

    public static string Request(string op, object? args = null) =>
        new JsonObject { ["op"] = op, ["args"] = args == null ? new JsonObject() : JsonSerializer.SerializeToNode(args, Json) }.ToJsonString();

    public static string Ok(object? value) => new JsonObject { ["ok"] = true, ["value"] = value == null ? null : JsonSerializer.SerializeToNode(value, Json) }.ToJsonString();
    public static string Error(string message) => new JsonObject { ["ok"] = false, ["error"] = message }.ToJsonString();
}

public class ServiceError(string message) : Exception(message);

/// <summary>A client for the service's pipe. Each call opens its own connection, so calls from several threads (an
/// install that takes a minute, a status check) do not wait on each other.</summary>
public class ServiceClient(string pipeName = Paths.PipeName, int timeoutMs = 5000)
{
    public JsonNode? Call(string op, object? args = null, int? timeout = null)
    {
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None);
        try { pipe.Connect(timeout ?? timeoutMs); }
        catch (TimeoutException) { throw new ServiceError("The Duckling service is not running."); }
        using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, leaveOpen: true);
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, leaveOpen: true) { AutoFlush = true, NewLine = "\n" };
        writer.WriteLine(Protocol.Request(op, args));
        var line = reader.ReadLine() ?? throw new ServiceError("The Duckling service closed the connection.");
        var r = JsonNode.Parse(line)!;
        if (r["ok"]?.GetValue<bool>() != true) throw new ServiceError(r["error"]?.GetValue<string>() ?? "The Duckling service refused.");
        return r["value"];
    }

    public Task<JsonNode?> CallAsync(string op, object? args = null, int timeout = 600_000) => Task.Run(() => Call(op, args, timeout));
}
