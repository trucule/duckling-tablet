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

    var lockdownOn: Boolean
        get() = p.getBoolean("lockdownOn", false)
        set(v) { p.edit().putBoolean("lockdownOn", v).apply() }

    fun hasPin(): Boolean = p.contains("pinHash")
    fun setPin(pin: String) { p.edit().putString("pinHash", hash(pin)).apply() }
    fun verifyPin(pin: String): Boolean = p.getString("pinHash", null) == hash(pin)

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
