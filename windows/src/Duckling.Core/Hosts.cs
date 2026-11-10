namespace Duckling;

/// <summary>Which websites the home screen may open: Duckling's own hosts, the parent's list, or everything ("*") in
/// travel mode. A listed host also allows its subdomains.</summary>
public static class Hosts
{
    public static IReadOnlyCollection<string> Normalize(IEnumerable<string> hosts) =>
        hosts.Select(h => h.Trim().ToLowerInvariant().TrimStart('*').TrimStart('.')).Where(h => h.Length > 0).Distinct().ToArray();

    public static bool IsOwn(string host) => Paths.OwnHosts.Contains(host.ToLowerInvariant());

    public static bool IsAllowed(string host, IReadOnlyCollection<string> allowed)
    {
        host = host.ToLowerInvariant().TrimEnd('.');
        if (host.Length == 0) return false;
        if (IsOwn(host)) return true;
        if (allowed.Contains("*")) return true;
        return allowed.Any(a => host == a || host.EndsWith("." + a, StringComparison.Ordinal));
    }

    public static bool IsAllowedUri(string uri, IReadOnlyCollection<string> allowed)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var u)) return false;
        if (u.Scheme is "about" or "data" or "blob") return true;
        if (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp) return false;
        return IsAllowed(u.Host, allowed);
    }
}
