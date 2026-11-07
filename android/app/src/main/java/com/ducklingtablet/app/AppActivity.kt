package com.ducklingtablet.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.File

/** Runs one installed package full screen from https://appassets.androidplatform.net/apps/<id>/, with a Home pill. */
class AppActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private var appId: String = ""
    private var allowsMic = false
    private var allowsCamera = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        appId = intent.getStringExtra("id") ?: run { finish(); return }
        val perms = getSharedPreferences("duckling", Context.MODE_PRIVATE).getString("perm:$appId", "") ?: ""
        allowsMic = perms.contains("microphone"); allowsCamera = perms.contains("camera")

        setContentView(R.layout.activity_app)
        hideSystemBars()
        web = findViewById(R.id.web)
        findViewById<View>(R.id.home).setOnClickListener { finish() }

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/apps/", WebViewAssetLoader.InternalStoragePathHandler(this, File(filesDir, "apps")))
            .build()

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = false
            userAgentString = "$userAgentString DucklingTablet/${BuildConfig.VERSION_NAME}"
        }
        // window.DucklingApp: what duckling-compat.js inside the package needs for the narrator.
        web.addJavascriptInterface(AppBridge(appId, Prefs(this)), "DucklingApp")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val host = request.url.host?.lowercase() ?: return blocked()
                if (host == "appassets.androidplatform.net") return loader.shouldInterceptRequest(request.url)
                // Apps are offline. The API and CDN stay reachable for the narrator voice later; nothing else does.
                return if (host in MainActivity.OWN_HOSTS) null else blocked()
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.url.host?.lowercase() != "appassets.androidplatform.net"
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val wanted = request.resources.filter {
                    (it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && allowsMic && granted(Manifest.permission.RECORD_AUDIO)) ||
                    (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE && allowsCamera && granted(Manifest.permission.CAMERA))
                }
                if (wanted.isEmpty()) request.deny() else request.grant(wanted.toTypedArray())
            }
        }
        // Ask the person for the system permission up front when the app's manifest wants it.
        val ask = mutableListOf<String>()
        if (allowsMic && !granted(Manifest.permission.RECORD_AUDIO)) ask += Manifest.permission.RECORD_AUDIO
        if (allowsCamera && !granted(Manifest.permission.CAMERA)) ask += Manifest.permission.CAMERA
        if (ask.isNotEmpty()) ActivityCompat.requestPermissions(this, ask.toTypedArray(), 2)

        web.loadUrl("https://appassets.androidplatform.net/apps/$appId/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { finish() }
        })
    }

    class AppBridge(private val id: String, private val prefs: Prefs) {
        @JavascriptInterface fun appId(): String = id
        @JavascriptInterface fun deviceToken(): String = prefs.deviceToken
        @JavascriptInterface fun apiUrl(): String = "https://api.ducklingtablet.com"
        @JavascriptInterface fun childName(): String = prefs.childName
        @JavascriptInterface fun voice(): String = prefs.narratorVoice
        @JavascriptInterface fun levels(): String = prefs.childLevels
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
    private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    override fun onResume() { super.onResume(); hideSystemBars() }
    override fun onDestroy() { web.destroy(); super.onDestroy() }

    private fun hideSystemBars() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }
}
