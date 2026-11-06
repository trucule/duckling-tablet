plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.ducklingtablet.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.ducklingtablet.app"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
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
    }

    buildTypes {
        getByName("debug") { applicationIdSuffix = ""; isDebuggable = true }
        getByName("release") { isMinifyEnabled = false }
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
}
