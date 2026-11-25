plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
// Firebase (push) is wired in when app/google-services.json is present: download it from the Firebase console for
// the Android app com.ducklingtablet.app and commit it. Without it the APK builds and runs without push.
if (file("google-services.json").exists()) apply(plugin = "com.google.gms.google-services")

android {
    namespace = "com.ducklingtablet.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.ducklingtablet.app"
        minSdk = 29
        targetSdk = 36
        // CI sets the build number (the workflow run number), so every uploaded bundle has a higher version code.
        versionCode = (System.getenv("BUILD_NUMBER") ?: "1").toInt()
        versionName = "1.0.4"
    }

    signingConfigs {
        // A committed debug keystore keeps the signature stable across CI builds, so a new APK installs over the old
        // one. Store builds use a separate upload key that never lives in the repo.
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        // The Play upload key, from the CI secrets (ANDROID_UPLOAD_KEYSTORE, ANDROID_UPLOAD_PASSWORD). Google Play
        // re-signs with the app signing key it holds.
        val upload = System.getenv("UPLOAD_KEYSTORE_FILE")
        if (!upload.isNullOrEmpty()) create("upload") {
            storeFile = file(upload)
            storePassword = System.getenv("UPLOAD_KEYSTORE_PASSWORD")
            keyAlias = "upload"
            keyPassword = System.getenv("UPLOAD_KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        getByName("debug") { applicationIdSuffix = ""; isDebuggable = true }
        getByName("release") {
            isMinifyEnabled = false
            signingConfigs.findByName("upload")?.let { signingConfig = it }
        }
    }

    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // Ed25519 signature checks on package zips (java.security has Ed25519 only from API 33).
    implementation("net.i2p.crypto:eddsa:0.3.0")
    // Push after parent changes.
    implementation("com.google.firebase:firebase-messaging:24.1.0")
    implementation("androidx.localbroadcastmanager:localbroadcastmanager:1.1.0")
    // The subscription through Google Play.
    implementation("com.android.billingclient:billing:8.0.0")
    // Continue with Google during setup (SignIn.kt).
    implementation("androidx.credentials:credentials:1.5.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.5.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
}
