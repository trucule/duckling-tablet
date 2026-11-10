using System.Security.Cryptography;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace Duckling;

/// <summary>App packages are accepted only when their Ed25519 signature verifies against Duckling's publishing key,
/// the same key the Android and iPad shells carry.</summary>
public static class Signing
{
    // Raw 32-byte Ed25519 public key, base64. Production key, made on the droplet on 2026-11-06.
    public const string PublicKeyB64 = "WjahKRLoQJBt/V1D48hazYaoVJaWkON81N0FeIMLols=";

    public static bool Verify(byte[] data, string signatureB64, string publicKeyB64 = PublicKeyB64)
    {
        try
        {
            var key = new Ed25519PublicKeyParameters(Convert.FromBase64String(publicKeyB64), 0);
            var signer = new Ed25519Signer();
            signer.Init(false, key);
            signer.BlockUpdate(data, 0, data.Length);
            return signer.VerifySignature(Convert.FromBase64String(signatureB64));
        }
        catch (Exception) { return false; }
    }

    public static string Sha256Hex(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));
}
