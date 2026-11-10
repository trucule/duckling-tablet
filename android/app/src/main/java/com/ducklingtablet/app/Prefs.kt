package com.ducklingtablet.app

import android.content.Context
import android.content.SharedPreferences
import java.security.MessageDigest

/** Device state kept by the shell: the device token, the parent PIN hash, the lockdown switch, installed versions. */
class Prefs(context: Context) {
    private val p: SharedPreferences = context.getSharedPreferences("duckling", Context.MODE_PRIVATE)

    var deviceToken: String
        get() = p.getString("deviceToken", "") ?: ""
        set(v) { p.edit().putString("deviceToken", v).apply() }

    /** The FCM registration token; sent to the server at check-in so parent changes reach this tablet at once. */
    var pushToken: String
        get() = p.getString("pushToken", "") ?: ""
        set(v) { p.edit().putString("pushToken", v).apply() }

    /** The paired child's id. Apps keep their saved progress, pictures and recordings under it (duckling-compat.js),
     *  so a child paired to this tablet later starts at her own grade and never sees an earlier child's things. */
    var childId: String
        get() = p.getString("childId", "") ?: ""
        set(v) { p.edit().putString("childId", v).apply() }

    var childName: String
        get() = p.getString("childName", "") ?: ""
        set(v) { p.edit().putString("childName", v).apply() }

    /** The child's level per subject as JSON ({"math": 2, ...}, grade scale -1 to 8), from the device config. */
    var childLevels: String
        get() = p.getString("childLevels", "{}") ?: "{}"
        set(v) { p.edit().putString("childLevels", v).apply() }

    var narratorVoice: String
        get() = p.getString("narratorVoice", "en-US-AnaNeural") ?: "en-US-AnaNeural"
        set(v) { p.edit().putString("narratorVoice", v).apply() }

    var lockdownOn: Boolean
        get() = p.getBoolean("lockdownOn", false)
        set(v) { p.edit().putBoolean("lockdownOn", v).apply() }

    fun hasPin(): Boolean = p.contains("pinHash")
    fun setPin(pin: String) { p.edit().putString("pinHash", hash(pin)).apply() }
    fun verifyPin(pin: String): Boolean = p.getString("pinHash", null) == hash(pin)
    /** The family PIN from the server: SHA-256 hex of "duckling:<pin>", the same form [hash] makes. */
    fun setPinHash(hex: String) { if (hex.matches(Regex("[0-9a-f]{64}"))) p.edit().putString("pinHash", hex).apply() }

    fun installed(): MutableMap<String, String> {
        val out = mutableMapOf<String, String>()
        for ((k, v) in p.all) if (k.startsWith("app:") && v is String) out[k.removePrefix("app:")] = v
        return out
    }
    fun setInstalled(id: String, version: String?) {
        val e = p.edit()
        if (version == null) e.remove("app:$id") else e.putString("app:$id", version)
        e.apply()
    }

    fun clearAll() { p.edit().clear().apply() }

    private fun hash(pin: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest("duckling:$pin".toByteArray())
        return d.joinToString("") { "%02x".format(it) }
    }
}
