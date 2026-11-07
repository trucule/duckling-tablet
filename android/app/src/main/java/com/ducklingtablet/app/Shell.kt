package com.ducklingtablet.app

import android.app.KeyguardManager
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * window.DucklingShell for the web app (web/src/shell.ts is the other side). Methods run on a WebView binder
 * thread, so anything that touches the UI or the network hops to the main thread or an executor and reports back
 * through window.DucklingWeb.
 */
class Shell(private val activity: MainActivity, private val web: WebView) {
    private val prefs = Prefs(activity)
    private val packages = Packages(activity)
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()

    private fun js(code: String) { main.post { web.evaluateJavascript(code, null) } }
    private fun q(s: String) = JSONObject.quote(s)

    @JavascriptInterface fun platform(): String = "android"
    @JavascriptInterface fun shellVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface fun getDeviceToken(): String = prefs.deviceToken
    @JavascriptInterface fun pushToken(): String = prefs.pushToken
    @JavascriptInterface fun setDeviceToken(t: String) { prefs.deviceToken = t }

    @JavascriptInterface fun installedApps(): String {
        val o = JSONObject()
        for ((id, v) in prefs.installed()) if (packages.dir(id).exists()) o.put(id, v)
        return o.toString()
    }

    @JavascriptInterface
    fun installApp(id: String, version: String, url: String, sha256: String, signature: String, permissions: String) {
        io.execute {
            try {
                packages.install(id, url, sha256, signature)
                prefs.setInstalled(id, version)
                activity.getSharedPreferences("duckling", Context.MODE_PRIVATE).edit().putString("perm:$id", permissions).apply()
                js("window.DucklingWeb && DucklingWeb.onInstall(${q(id)}, true, '')")
            } catch (e: Exception) {
                js("window.DucklingWeb && DucklingWeb.onInstall(${q(id)}, false, ${q(e.message ?: "Install failed")})")
            }
        }
    }

    @JavascriptInterface fun uninstallApp(id: String) { io.execute { packages.uninstall(id); prefs.setInstalled(id, null) } }

    @JavascriptInterface fun openApp(id: String) {
        if (!packages.dir(id).exists()) return
        main.post { activity.startActivity(Intent(activity, AppActivity::class.java).putExtra("id", id)) }
    }

    @JavascriptInterface fun hasPin(): Boolean = prefs.hasPin()
    @JavascriptInterface fun setPin(pin: String) { prefs.setPin(pin) }
    @JavascriptInterface fun verifyPin(pin: String): Boolean = prefs.verifyPin(pin)
    @JavascriptInterface fun setPinHash(hex: String) { prefs.setPinHash(hex) }

    @JavascriptInterface fun lockdownStatus(): String {
        val role = activity.getSystemService(RoleManager::class.java)
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        return JSONObject()
            .put("homeRole", role?.isRoleHeld(RoleManager.ROLE_HOME) == true)
            .put("deviceSecure", keyguard?.isDeviceSecure == true)
            .put("pinned", activity.isPinned())
            .put("lockdownOn", prefs.lockdownOn)
            .toString()
    }

    @JavascriptInterface fun requestHomeRole() {
        main.post {
            val role = activity.getSystemService(RoleManager::class.java) ?: return@post
            if (role.isRoleAvailable(RoleManager.ROLE_HOME) && !role.isRoleHeld(RoleManager.ROLE_HOME)) {
                activity.startActivityForResult(role.createRequestRoleIntent(RoleManager.ROLE_HOME), 1)
            } else {
                activity.startActivity(Intent(Settings.ACTION_HOME_SETTINGS))
            }
        }
    }

    @JavascriptInterface fun openSecuritySettings() { main.post { activity.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS)) } }

    /**
     * Android's Wi-Fi settings, from the parent area: a parent picks a network (and signs in on a captive portal if
     * the network has one), then comes back with Back. The lockdown is lifted for that visit and comes back in
     * onResume. An app cannot join networks itself without device-owner provisioning.
     */
    @JavascriptInterface fun openWifiSettings() {
        main.post {
            activity.unpin()
            try { activity.startActivity(Intent(Settings.ACTION_WIFI_SETTINGS)) } catch (_: Exception) {
                try { activity.startActivity(Intent(Settings.ACTION_WIRELESS_SETTINGS)) } catch (_: Exception) {}
            }
        }
    }

    /** "wifi", "cellular", "other" or "none": what the tablet is connected through right now. */
    @JavascriptInterface fun networkStatus(): String {
        val cm = activity.getSystemService(android.net.ConnectivityManager::class.java) ?: return "none"
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "none"
        return when {
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            else -> "other"
        }
    }

    @JavascriptInterface fun setLockdown(on: Boolean) {
        prefs.lockdownOn = on
        main.post { if (on) activity.pin() else activity.unpin() }
    }

    /**
     * Lifts the lockdown and forgets everything: device token, PIN, installed apps. Then asks Android to uninstall
     * Duckling; when the parent confirms, the home role goes back to the device's own launcher. If they cancel, the
     * app stays, released and unlocked, and the home chooser is one tap away in the pairing screen.
     */
    @JavascriptInterface fun release() {
        main.post {
            activity.unpin()
            prefs.clearAll()
            packages.root.deleteRecursively()
            try {
                activity.startActivity(Intent(Intent.ACTION_DELETE, Uri.parse("package:${activity.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: Exception) {
                try { activity.startActivity(Intent(Settings.ACTION_HOME_SETTINGS)) } catch (_: Exception) {}
            }
        }
    }

    /** Website hosts a parent allowed (from the device config); the WebView lets only these through besides Duckling's own. */
    @JavascriptInterface fun setAllowedHosts(csv: String) { activity.allowedHosts = csv.split(',').map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet() }

    /** The child's first name (for private narrator lines) and the narrator voice, from the device config. */
    @JavascriptInterface fun setChildInfo(name: String, voice: String) { prefs.childName = name; if (voice.isNotEmpty()) prefs.narratorVoice = voice }

    @JavascriptInterface fun reload() { main.post { web.reload() } }
}
