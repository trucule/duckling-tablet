package com.ducklingtablet.app

import android.util.Base64
import net.i2p.crypto.eddsa.EdDSAEngine
import net.i2p.crypto.eddsa.EdDSAPublicKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec
import java.security.MessageDigest

/** The package signing public key. Packages are accepted only when their Ed25519 signature verifies against it. */
object Signing {
    // Raw 32-byte Ed25519 public key, base64. Printed by `node tools/publish.mjs keygen`.
    // Production key, made on the droplet on 2026-11-06 (private half in /opt/duckling/.env only).
    const val PUBLIC_KEY_B64 = "WjahKRLoQJBt/V1D48hazYaoVJaWkON81N0FeIMLols="

    fun verify(data: ByteArray, signatureB64: String): Boolean {
        return try {
            val spec = EdDSANamedCurveTable.getByName(EdDSANamedCurveTable.ED_25519)
            val key = EdDSAPublicKey(EdDSAPublicKeySpec(Base64.decode(PUBLIC_KEY_B64, Base64.DEFAULT), spec))
            val engine = EdDSAEngine(MessageDigest.getInstance(spec.hashAlgorithm))
            engine.initVerify(key)
            engine.update(data)
            engine.verify(Base64.decode(signatureB64, Base64.DEFAULT))
        } catch (e: Exception) {
            false
        }
    }

    fun sha256Hex(data: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
}
