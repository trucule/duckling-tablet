package com.ducklingtablet.app

import android.content.Intent
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Firebase Cloud Messaging. The server sends a data-only {type: config-changed} message after a parent changes
 * something; the home screen then checks in. Nothing is shown to the child. The registration token is kept in
 * Prefs and goes up with the next check-in.
 */
class PushService : FirebaseMessagingService() {
    companion object {
        const val ACTION_PUSH = "com.ducklingtablet.app.PUSH"
        const val ACTION_TOKEN = "com.ducklingtablet.app.TOKEN"
    }

    override fun onNewToken(token: String) {
        Prefs(this).pushToken = token
        LocalBroadcastManager.getInstance(this).sendBroadcast(Intent(ACTION_TOKEN))
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["type"] == "config-changed") {
            LocalBroadcastManager.getInstance(this).sendBroadcast(Intent(ACTION_PUSH))
        }
    }
}
