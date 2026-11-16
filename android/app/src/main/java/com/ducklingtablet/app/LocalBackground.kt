package com.ducklingtablet.app

/** A picture an app set as this tablet's own home background (Camera Fun), on its way from the app's WebView to the
 *  home screen's. It is held in memory only: the home screen takes it as soon as the child is back and keeps it in its
 *  own storage on this tablet. Nothing here is uploaded. */
object LocalBackground {
    private const val PREFIX = "data:image/jpeg;base64,"
    private const val MAX = 4_000_000
    @Volatile private var pending: String? = null

    @Synchronized fun hold(dataUrl: String): Boolean {
        // "none": a picture set on her profile from this tablet replaces this tablet's own one.
        if (dataUrl != "none" && (!dataUrl.startsWith(PREFIX) || dataUrl.length > MAX)) return false
        pending = dataUrl
        return true
    }

    @Synchronized fun take(): String { val d = pending ?: ""; pending = null; return d }
}
