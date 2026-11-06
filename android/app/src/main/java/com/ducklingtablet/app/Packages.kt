package com.ducklingtablet.app

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream

/**
 * Installed app packages live under filesDir/apps/<id>/ and are served to the WebView by WebViewAssetLoader at
 * https://appassets.androidplatform.net/apps/<id>/. A package is unpacked only after its SHA-256 matches the
 * catalog and its Ed25519 signature verifies.
 */
class Packages(private val context: Context) {
    val root: File get() = File(context.filesDir, "apps").also { it.mkdirs() }

    fun dir(id: String): File = File(root, id)

    class InstallError(message: String) : Exception(message)

    /** Downloads, verifies and unpacks. Throws InstallError with a message fit for the child's screen. */
    fun install(id: String, url: String, sha256: String, signature: String) {
        require(id.matches(Regex("^[a-z0-9][a-z0-9-]{1,40}$"))) { "bad app id" }
        val zip = download(url)
        if (Signing.sha256Hex(zip) != sha256.lowercase()) throw InstallError("The download did not match. Try again.")
        if (!Signing.verify(zip, signature)) throw InstallError("This package is not signed by Duckling.")

        val target = dir(id)
        val staging = File(root, "$id.new")
        staging.deleteRecursively(); staging.mkdirs()
        ZipInputStream(zip.inputStream()).use { zin ->
            var entry = zin.nextEntry
            var count = 0
            while (entry != null) {
                val out = File(staging, entry.name)
                // Keep every file inside the staging folder: no "../" and no absolute names.
                if (!out.canonicalPath.startsWith(staging.canonicalPath + File.separator)) throw InstallError("Bad file name in package.")
                if (entry.isDirectory) out.mkdirs() else {
                    out.parentFile?.mkdirs()
                    FileOutputStream(out).use { zin.copyTo(it) }
                    if (++count > 5000) throw InstallError("Package has too many files.")
                }
                zin.closeEntry(); entry = zin.nextEntry
            }
        }
        if (!File(staging, "index.html").exists()) throw InstallError("Package has no index.html.")
        target.deleteRecursively()
        if (!staging.renameTo(target)) throw InstallError("Could not finish the install.")
    }

    fun uninstall(id: String) { dir(id).deleteRecursively() }

    private fun download(url: String): ByteArray {
        val u = URL(url)
        if (u.protocol != "https") throw InstallError("Packages come only over HTTPS.")
        val c = u.openConnection() as HttpURLConnection
        c.connectTimeout = 15_000; c.readTimeout = 60_000
        try {
            if (c.responseCode != 200) throw InstallError("Download failed (${c.responseCode}).")
            val len = c.contentLengthLong
            if (len > 200L * 1024 * 1024) throw InstallError("Package is too large.")
            return c.inputStream.use { it.readBytes() }
        } finally { c.disconnect() }
    }
}
