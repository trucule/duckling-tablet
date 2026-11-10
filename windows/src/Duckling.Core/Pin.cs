using System.Security.Cryptography;
using System.Text;

namespace Duckling;

/// <summary>The parent PIN in the form every shell and the server keep: SHA-256 hex of "duckling:&lt;pin&gt;".</summary>
public static class Pin
{
    public static string Hash(string pin) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("duckling:" + pin)));
    public static bool IsHash(string s) => s.Length == 64 && s.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
}
