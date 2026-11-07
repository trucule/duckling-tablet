package com.ducklingtablet.app

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import java.io.ByteArrayInputStream

/**
 * The home screen: a WebView on app.ducklingtablet.com with the shell bridge. Also the HOME activity, and the
 * activity that keeps the task pinned while the lockdown is on.
 */
class MainActivity : AppCompatActivity() {
    companion object {
        const val WEB_APP = "https://app.ducklingtablet.com/"
        val OWN_HOSTS = setOf("app.ducklingtablet.com", "api.ducklingtablet.com", "duckling.nyc3.cdn.digitaloceanspaces.com", "appassets.androidplatform.net")
    }

    lateinit var web: WebView
    private lateinit var prefs: Prefs
    var allowedHosts: Set<String> = emptySet()

    // A push (or a new registration token) makes the web app check in now.
    private val pushReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            web.evaluateJavascript("window.DucklingWeb && DucklingWeb.onPush && DucklingWeb.onPush()", null)
        }
    }

    /** Asks Firebase for the registration token when the app is configured for it (google-services.json present). */
    private fun fetchPushToken() {
        if (FirebaseApp.getApps(this).isEmpty()) return
        try {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { t -> if (!t.isNullOrEmpty() && t != prefs.pushToken) { prefs.pushToken = t; pushReceiver.onReceive(this, Intent(PushService.ACTION_TOKEN)) } }
        } catch (_: Exception) { /* Firebase not available on this device; check-ins every three hours still apply */ }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        web = WebView(this)
        setContentView(web)
        hideSystemBars()
        LocalBroadcastManager.getInstance(this).registerReceiver(pushReceiver, IntentFilter().apply { addAction(PushService.ACTION_PUSH); addAction(PushService.ACTION_TOKEN) })
        fetchPushToken()

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString DucklingTablet/${BuildConfig.VERSION_NAME}"
        }
        web.addJavascriptInterface(Shell(this, web), "DucklingShell")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = request.url.host?.lowercase() ?: return true
                // Duckling's own hosts and the parent's allowed websites open here; everything else goes nowhere.
                return !(host in OWN_HOSTS || isAllowed(host))
            }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val host = request.url.host?.lowercase() ?: return blocked()
                return if (host in OWN_HOSTS || isAllowed(host)) null else blocked()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() } // apps run in AppActivity
        }
        if (savedInstanceState == null) web.loadUrl(WEB_APP) else web.restoreState(savedInstanceState)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Back inside the web app goes to its home screen; it never leaves Duckling.
                web.evaluateJavascript("location.hash = '#/home'", null)
            }
        })
    }

    private fun isAllowed(host: String): Boolean = "*" in allowedHosts || allowedHosts.any { host == it || host.endsWith(".$it") }
    private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        if (otherPkg != null) endOtherApp("returned")
        if (prefs.lockdownOn && !isPinned()) pin()
        web.evaluateJavascript("window.DucklingWeb && DucklingWeb.onResume && DucklingWeb.onResume()", null)
    }

    // ---- Another app's turn: unpinned while it runs, back to the front when its time ends.
    private var otherPkg: String? = null
    private var otherStart = 0L
    private val otherTimer = Handler(Looper.getMainLooper())
    private val comeBack = Runnable { bringToFront() }

    fun beginOtherApp(pkg: String, seconds: Int) {
        unpin()
        otherPkg = pkg; otherStart = SystemClock.elapsedRealtime()
        otherTimer.removeCallbacks(comeBack)
        otherTimer.postDelayed(comeBack, seconds.coerceIn(10, 6 * 3600) * 1000L)
    }

    fun endOtherApp(reason: String) {
        val pkg = otherPkg ?: return
        val secs = ((SystemClock.elapsedRealtime() - otherStart) / 1000L).toInt()
        otherPkg = null
        otherTimer.removeCallbacks(comeBack)
        web.evaluateJavascript("window.DucklingWeb && DucklingWeb.onOtherApp && DucklingWeb.onOtherApp(${org.json.JSONObject.quote(pkg)}, $secs, ${org.json.JSONObject.quote(reason)})", null)
    }

    /** From the background this needs "Display over other apps"; the parent area asks for it when other apps are on. */
    private fun bringToFront() {
        try { startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)) } catch (_: Exception) {}
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent) }
    override fun onDestroy() { LocalBroadcastManager.getInstance(this).unregisterReceiver(pushReceiver); super.onDestroy() }
    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); web.saveState(outState) }

    fun isPinned(): Boolean {
        val am = getSystemService(ActivityManager::class.java) ?: return false
        return am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    }

    /** Screen pinning. Without device-owner rights Android asks the person to confirm the first time. */
    fun pin() { try { startLockTask() } catch (_: Exception) {} }
    fun unpin() { try { stopLockTask() } catch (_: Exception) {} }

    private fun hideSystemBars() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    @Suppress("unused")
    fun openExternal(url: String) { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}
