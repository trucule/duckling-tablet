package com.ducklingtablet.app

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
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

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        web = WebView(this)
        setContentView(web)
        hideSystemBars()

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

    private fun isAllowed(host: String): Boolean = allowedHosts.any { host == it || host.endsWith(".$it") }
    private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        if (prefs.lockdownOn && !isPinned()) pin()
        web.evaluateJavascript("window.DucklingWeb && DucklingWeb.onResume && DucklingWeb.onResume()", null)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent) }
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
