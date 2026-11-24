package com.ducklingtablet.app

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.graphics.Bitmap
import android.view.View
import android.view.ViewGroup
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
        const val MEDIA_REQUEST = 3
        val OWN_HOSTS = setOf("app.ducklingtablet.com", "api.ducklingtablet.com", "duckling.nyc3.cdn.digitaloceanspaces.com", "appassets.androidplatform.net")
    }

    lateinit var web: WebView
    private lateinit var homePill: View
    private lateinit var prefs: Prefs
    var allowedHosts: Set<String> = emptySet()
    var signInHosts: Set<String> = emptySet()
    /** The host of the page showing in the main view. DucklingShell answers only while it is Duckling's own page. */
    @Volatile var pageHost: String = ""
    /** Windows a website opened (a "Sign in with Google" window), shown over it until they close. */
    private val popups = mutableListOf<WebView>()
    private lateinit var ducklingAgent: String
    private lateinit var browserAgent: String
    lateinit var billing: Billing

    // A push (or a new registration token) makes the web app check in now.
    private val pushReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            toWebApp("window.DucklingWeb && DucklingWeb.onPush && DucklingWeb.onPush()")
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
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        homePill = findViewById(R.id.home)
        homePill.setOnClickListener { goHome() }
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
            // A link or script that asks for a new window (a site's sign-in popup) opens in this view instead, when allowed.
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            // Duckling's own agent everywhere, and Chrome's on the sign-in services: Google refuses to sign in inside
            // what it takes for an embedded web view ("; wv" and "Version/4.0" in the agent, error disallowed_useragent).
            ducklingAgent = "$userAgentString DucklingTablet/${BuildConfig.VERSION_NAME}"
            browserAgent = userAgentString.replace("; wv", "").replace(Regex("""\s*Version/\d+\.\d+"""), "")
            userAgentString = ducklingAgent
        }
        billing = Billing(this,
            { status, message -> runOnUiThread { toWebApp("window.DucklingWeb && DucklingWeb.onBilling && DucklingWeb.onBilling(${org.json.JSONObject.quote(status)}, ${org.json.JSONObject.quote(message)})") } },
            { toWebApp("window.DucklingWeb && DucklingWeb.onResume && DucklingWeb.onResume()") })
        billing.start()
        web.addJavascriptInterface(Shell(this, web), "DucklingShell")
        val client = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                if (view === web) pageHost = url?.let { Uri.parse(it).host?.lowercase() } ?: ""
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = request.url.host?.lowercase() ?: return true
                // Duckling's own hosts and the parent's allowed websites open here; everything else goes nowhere.
                if (!(host in OWN_HOSTS || isAllowed(host))) return true
                // A standard browser while signing in, Duckling's own agent again on the way back to the site.
                if (request.isForMainFrame) {
                    val agent = if (isSignIn(host)) browserAgent else ducklingAgent
                    if (view.settings.userAgentString != agent) { view.settings.userAgentString = agent; view.loadUrl(request.url.toString()); return true }
                }
                return false
            }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val host = request.url.host?.lowercase() ?: return blocked()
                return if (host in OWN_HOSTS || isAllowed(host)) null else blocked()
            }
            // A website from a tile opens in this view in place of the home screen; the Home pill shows over it.
            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                if (view !== web) return
                pageHost = url?.let { Uri.parse(it).host?.lowercase() } ?: ""
                homePill.visibility = if (onWebsite(url)) View.VISIBLE else View.GONE
            }
        }
        web.webViewClient = client
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() } // apps run in AppActivity
            // A website's new window (its "Sign in with Google" window) opens over it as a real window, so the
            // sign-in can report back to the page that opened it and close itself. Loaded in place, as before, the
            // report had nowhere to go and the sign-in ended on a blank page. The same host rules apply inside it
            // (the shared client), it has no DucklingShell, and Home or Back closes it.
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                if (view !== web) return false
                val popup = WebView(this@MainActivity)
                with(popup.settings) {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    databaseEnabled = true
                    allowFileAccess = false
                    allowContentAccess = false
                    setSupportMultipleWindows(false)
                    userAgentString = browserAgent
                }
                popup.webViewClient = client
                popup.webChromeClient = object : WebChromeClient() {
                    override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
                    override fun onCloseWindow(window: WebView) { closePopup(window) }
                }
                val parent = web.parent as ViewGroup
                parent.addView(popup, parent.indexOfChild(web) + 1, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                popups += popup
                (resultMsg.obj as WebView.WebViewTransport).webView = popup
                resultMsg.sendToTarget()
                return true
            }
        }
        if (savedInstanceState == null) web.loadUrl(WEB_APP) else { web.restoreState(savedInstanceState); pageHost = web.url?.let { Uri.parse(it).host?.lowercase() } ?: "" }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Back on a website goes to the home screen; inside the web app it goes to its home screen. It never
                // leaves Duckling.
                if (popups.isNotEmpty()) closePopup(popups.last())
                else if (onWebsite(web.url)) goHome() else web.evaluateJavascript("location.hash = '#/home'", null)
            }
        })
    }

    private fun onWebsite(url: String?): Boolean {
        val host = url?.let { Uri.parse(it).host?.lowercase() } ?: return false
        return host != Uri.parse(WEB_APP).host
    }

    /** Runs code in Duckling's own page only: while a website is showing, nothing is sent to it. */
    fun toWebApp(code: String) { if (pageHost == Uri.parse(WEB_APP).host) web.evaluateJavascript(code, null) }

    private fun closePopup(popup: WebView) {
        if (!popups.remove(popup)) return
        (popup.parent as? ViewGroup)?.removeView(popup)
        popup.destroy()
    }

    private fun goHome() {
        popups.toList().forEach { closePopup(it) }
        homePill.visibility = View.GONE
        web.loadUrl(WEB_APP)
    }

    private fun isAllowed(host: String): Boolean = "*" in allowedHosts || allowedHosts.any { host == it || host.endsWith(".$it") }
    private fun isSignIn(host: String): Boolean = signInHosts.any { host == it || host.endsWith(".$it") }
    private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        if (otherPkg != null) endOtherApp("returned")
        if (prefs.lockdownOn && !isPinned()) pin()
        toWebApp("window.DucklingWeb && DucklingWeb.onResume && DucklingWeb.onResume()")
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
        toWebApp("window.DucklingWeb && DucklingWeb.onOtherApp && DucklingWeb.onOtherApp(${org.json.JSONObject.quote(pkg)}, $secs, ${org.json.JSONObject.quote(reason)})")
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

    fun hasPermission(p: String) = androidx.core.content.ContextCompat.checkSelfPermission(this, p) == android.content.pm.PackageManager.PERMISSION_GRANTED

    private val mediaPermissions = arrayOf(android.Manifest.permission.RECORD_AUDIO, android.Manifest.permission.CAMERA)

    fun requestMedia() {
        val missing = mediaPermissions.filter { !hasPermission(it) }
        if (missing.isNotEmpty()) androidx.core.app.ActivityCompat.requestPermissions(this, missing.toTypedArray(), MEDIA_REQUEST)
    }

    /** Duckling's page in Android's settings, with the lockdown lifted for the visit as for Wi-Fi; onResume restores it. */
    fun openAppSettings() {
        unpin()
        try { startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))) } catch (_: Exception) {}
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != MEDIA_REQUEST) return
        // Android answers at once, with no dialog, for a permission it will no longer ask about: settings is the only way.
        val refused = permissions.filterIndexed { i, _ -> grantResults.getOrNull(i) != android.content.pm.PackageManager.PERMISSION_GRANTED }
        if (refused.any { !androidx.core.app.ActivityCompat.shouldShowRequestPermissionRationale(this, it) }) openAppSettings()
        toWebApp("window.DucklingWeb && DucklingWeb.onResume && DucklingWeb.onResume()")
    }

    private fun hideSystemBars() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    @Suppress("unused")
    fun openExternal(url: String) { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
}
