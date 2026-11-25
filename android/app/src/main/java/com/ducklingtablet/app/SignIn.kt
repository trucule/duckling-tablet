package com.ducklingtablet.app

import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.lifecycle.lifecycleScope
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.launch

/**
 * Continue with Google during setup: Android's account sheet lists the Google accounts already on the tablet, the
 * parent picks one, and the web app gets Google's ID token for the server to check. The nonce is the server's, so a
 * token cannot be replayed. clientId is the server's web client id (Google puts it in the token's audience); the
 * Android client registered for this package and its signing key lets Google answer this app at all.
 * done(status, idToken, message): status is "ok", "cancelled" or "failed"; the message is empty, and the web app
 * shows its own sentence.
 */
class SignIn(private val activity: MainActivity) {
    private val manager = CredentialManager.create(activity)

    fun google(nonce: String, clientId: String, done: (String, String, String) -> Unit) {
        activity.lifecycleScope.launch {
            val accounts = GetGoogleIdOption.Builder()
                .setServerClientId(clientId).setNonce(nonce)
                .setFilterByAuthorizedAccounts(false).setAutoSelectEnabled(false).build()
            try {
                done("ok", token(accounts), "")
            } catch (_: NoCredentialException) {
                // No Google account on the tablet: Google's own sign-in screen adds one.
                try { done("ok", token(GetSignInWithGoogleOption.Builder(clientId).setNonce(nonce).build()), "") }
                catch (e: Exception) { done(if (e is GetCredentialCancellationException) "cancelled" else "failed", "", "") }
            } catch (_: GetCredentialCancellationException) {
                done("cancelled", "", "")
            } catch (_: Exception) {
                done("failed", "", "")
            }
        }
    }

    private suspend fun token(option: androidx.credentials.CredentialOption): String {
        val c = manager.getCredential(activity, GetCredentialRequest.Builder().addCredentialOption(option).build()).credential
        if (c is CustomCredential && c.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) return GoogleIdTokenCredential.createFrom(c.data).idToken
        throw IllegalStateException("not a Google ID token")
    }
}
