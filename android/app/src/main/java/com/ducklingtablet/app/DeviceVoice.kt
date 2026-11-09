package com.ducklingtablet.app

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.util.Locale

/**
 * The tablet's own voice for apps, used when the Duckling narrator cannot play a line (offline, the daily allowance
 * used up, the API down). Android's WebView has no speechSynthesis; duckling-compat.js provides one that calls
 * speak(id, text, rate) here and hears back through window.__ducklingVoice.start/end/error(id), so apps that wait
 * for the end of a line keep going.
 */
class DeviceVoice(context: Context, private val web: WebView) {
    private val main = Handler(Looper.getMainLooper())
    private var ready = false
    private val waiting = mutableListOf<Triple<String, String, Float>>()
    private val tts: TextToSpeech = TextToSpeech(context.applicationContext) { status ->
        main.post {
            ready = status == TextToSpeech.SUCCESS
            if (ready) tts.language = Locale.US
            waiting.forEach { (id, text, rate) -> if (ready) say(id, text, rate) else report("error", id) }
            waiting.clear()
        }
    }

    init {
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String) = report("start", id)
            override fun onDone(id: String) = report("end", id)
            @Deprecated("Deprecated in Java")
            override fun onError(id: String) = report("error", id)
            override fun onError(id: String, errorCode: Int) = report("error", id)
            override fun onStop(id: String, interrupted: Boolean) = report("error", id)
        })
    }

    private fun report(kind: String, id: String) {
        if (!id.matches(Regex("^v[0-9]+$"))) return
        main.post { web.evaluateJavascript("window.__ducklingVoice && __ducklingVoice.$kind('$id')", null) }
    }

    private fun say(id: String, text: String, rate: Float) {
        tts.setSpeechRate(rate.coerceIn(0.5f, 2f))
        tts.speak(text, TextToSpeech.QUEUE_ADD, Bundle(), id)
    }

    @JavascriptInterface fun speak(id: String, text: String, rate: Float) {
        main.post { if (ready) say(id, text, rate) else waiting += Triple(id, text, rate) }
    }

    @JavascriptInterface fun stopSpeaking() { main.post { waiting.clear(); tts.stop() } }

    fun shutdown() { tts.stop(); tts.shutdown() }
}
