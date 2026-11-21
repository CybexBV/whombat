package com.whombat.updater

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

private const val APK_MIME = "application/vnd.android.package-archive"
private const val PROGRESS_EVERY_MS = 250L

/**
 * `WhombatUpdater` (Android): the app updates itself (android-self-update.md AP-813), the way Morphe Manager does —
 * the APK control hands out (`downloads.android`, CT-191) is downloaded into the app's own cache with progress, checked
 * (size and SHA-256 from `latest.json`, then Android reads it: this package, the announced `versionCode`, newer than
 * this build, signed with this app's key) and handed to Android's installer through a FileProvider
 * (`ACTION_INSTALL_PACKAGE`), which asks the person and ends with “App installed · Open”. No browser, no Downloads
 * folder. The first time Android asks to allow installs from Whombat (`canInstall` / `openInstallSettings`, or
 * `openAppDetails` where that page doesn't open).
 *
 * Rejections carry a code: `busy`, `network` (no answer, an HTTP error, a short file), `verify` (the bytes
 * or the APK aren't what was announced), `signature` (not signed like this app: Android would refuse it), `failed`.
 * The JavaScript side is `modules/whombat-updater/index.ts`.
 */
class WhombatUpdaterModule : Module() {
  private val executor = Executors.newSingleThreadExecutor()
  private val running = AtomicBoolean(false)

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No context.")

  private val updatesDir: File
    get() = File(context.cacheDir, "updates")

  override fun definition() = ModuleDefinition {
    Name("WhombatUpdater")
    Events("onProgress")

    // An update that is now installed (or older) has nothing left to do: the next start frees its ~100 MB.
    OnCreate { executor.execute { runCatching { dropStaged(keepAbove = ownVersionCode()) } } }

    Function("isSupported") { true }

    /** Android 8+ asks per app whether it may install apps (“Install unknown apps”). */
    Function("canInstall") {
      Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
    }

    /** That setting's page for this app; true when it opened. */
    Function("openInstallSettings") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@Function false
      val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
      runCatching { start(intent) }.isSuccess
    }

    /** This app's own page in Android's settings, for phones that can't open the one above; true when it opened. */
    Function("openAppDetails") {
      val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
      runCatching { start(intent) }.isSuccess
    }

    /** Downloads and checks the APK; resolves with its path. A file already staged and intact isn't fetched again. */
    AsyncFunction("download") { url: String, sha256: String, size: Long, versionCode: Long, promise: Promise ->
      if (!running.compareAndSet(false, true)) {
        promise.reject("busy", "A download is already running.", null)
        return@AsyncFunction
      }
      executor.execute {
        try {
          promise.resolve(fetch(url, sha256.lowercase(), size, versionCode).absolutePath)
        } catch (e: UpdateException) {
          promise.reject(e.code, e.message, e)
        } catch (e: IOException) {
          promise.reject("network", e.message ?: "The download failed.", e)
        } catch (e: Exception) {
          promise.reject("failed", e.message ?: "The download failed.", e)
        } finally {
          running.set(false)
        }
      }
    }

    /**
     * Hands a staged APK to Android's installer. Resolves once the installer is on screen: an update replaces this
     * process, so success never comes back here; a person who cancels simply returns to the app.
     */
    AsyncFunction("install") { path: String, promise: Promise ->
      val file = File(path)
      if (file.parentFile?.canonicalPath != updatesDir.canonicalPath || !file.isFile) {
        promise.reject("verify", "The update isn't downloaded any more.", null)
        return@AsyncFunction
      }
      try {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.whombat-updates", file)
        @Suppress("DEPRECATION")
        val intent = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
          setDataAndType(uri, APK_MIME)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true)
          putExtra(Intent.EXTRA_INSTALLER_PACKAGE_NAME, context.packageName)
          putExtra(Intent.EXTRA_RETURN_RESULT, false)
        }
        start(intent)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("failed", e.message ?: "Android's installer didn't open.", e)
      }
    }
  }

  private fun start(intent: Intent) {
    val activity = appContext.currentActivity
    if (activity != null) activity.startActivity(intent)
    else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  private fun fetch(url: String, sha256: String, size: Long, versionCode: Long): File {
    val dir = updatesDir.apply { mkdirs() }
    val target = File(dir, "whombat-$versionCode.apk")
    if (target.isFile && target.length() == size && hashOf(target) == sha256) {
      progress(size, size)
      return target.also { checkArchive(it, versionCode) }
    }
    // One update at a time: whatever else is staged (an older one, a broken try) goes.
    dropStaged(keepAbove = Long.MAX_VALUE)
    val partial = File(dir, "whombat-$versionCode.apk.partial")
    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
      connectTimeout = 15_000
      readTimeout = 30_000
      instanceFollowRedirects = true
    }
    try {
      val status = connection.responseCode
      if (status !in 200..299) throw UpdateException("network", "The server answered $status.")
      val digest = MessageDigest.getInstance("SHA-256")
      var received = 0L
      var sentAt = 0L
      progress(0, size)
      connection.inputStream.use { input ->
        FileOutputStream(partial).use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            received += n
            if (received > size) throw UpdateException("verify", "The download is larger than announced.")
            digest.update(buffer, 0, n)
            output.write(buffer, 0, n)
            val now = SystemClock.elapsedRealtime()
            if (now - sentAt >= PROGRESS_EVERY_MS) {
              sentAt = now
              progress(received, size)
            }
          }
          output.fd.sync()
        }
      }
      if (received != size) throw UpdateException("network", "The download stopped at $received of $size bytes.")
      if (hex(digest.digest()) != sha256) throw UpdateException("verify", "The download doesn't match its checksum.")
      if (!partial.renameTo(target)) throw IOException("The update couldn't be stored.")
      progress(size, size)
      checkArchive(target, versionCode)
      return target
    } catch (e: Exception) {
      partial.delete()
      if (e is UpdateException && e.code != "network") target.delete()
      throw e
    } finally {
      connection.disconnect()
    }
  }

  /** What Android reads in the file: this app, the announced version, newer than this build, this app's signer. */
  private fun checkArchive(file: File, versionCode: Long) {
    val pm = context.packageManager
    // Android 9 reads an archive's certificates only when GET_SIGNATURES is asked for too, so both are.
    @Suppress("DEPRECATION")
    val flags =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES or PackageManager.GET_SIGNATURES
      else PackageManager.GET_SIGNATURES
    val fail = { code: String, message: String ->
      file.delete()
      UpdateException(code, message)
    }
    @Suppress("DEPRECATION")
    val info = pm.getPackageArchiveInfo(file.absolutePath, flags) ?: throw fail("verify", "The download isn't an app.")
    if (info.packageName != context.packageName) throw fail("verify", "The download is another app.")
    val code = codeOf(info)
    if (code != versionCode) throw fail("verify", "The download is version $code, not $versionCode.")
    if (code <= ownVersionCode()) throw fail("verify", "The download isn't newer than this app.")
    // A signer Android can't read counts as a failed check, never as a pass.
    val unread = "Android couldn't read who signed the download."
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val signers = info.signingInfo?.apkContentsSigners
      if (signers.isNullOrEmpty()) throw fail("verify", unread)
      if (signers.none { pm.hasSigningCertificate(context.packageName, it.toByteArray(), PackageManager.CERT_INPUT_RAW_X509) }) {
        throw fail("signature", "The download isn't signed like this app.")
      }
    } else {
      @Suppress("DEPRECATION")
      val signers = info.signatures
      if (signers.isNullOrEmpty()) throw fail("verify", unread)
      @Suppress("DEPRECATION")
      val own = pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures
      if (own.isNullOrEmpty()) throw fail("verify", unread)
      // Before Android 9 an update must carry exactly this app's signers.
      if (signers.toSet() != own.toSet()) throw fail("signature", "The download isn't signed like this app.")
    }
  }

  private fun ownVersionCode(): Long = codeOf(context.packageManager.getPackageInfo(context.packageName, 0))

  @Suppress("DEPRECATION")
  private fun codeOf(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

  /** Removes staged files whose version isn't above `keepAbove` (partials included). */
  private fun dropStaged(keepAbove: Long) {
    updatesDir.listFiles()?.forEach { f ->
      val code = Regex("""^whombat-(\d+)\.apk(\.partial)?$""").find(f.name)?.groupValues?.get(1)?.toLongOrNull()
      if (code == null || code <= keepAbove) f.delete()
    }
  }

  private fun progress(received: Long, total: Long) {
    sendEvent("onProgress", mapOf("received" to received.toDouble(), "total" to total.toDouble()))
  }

  private fun hashOf(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val n = input.read(buffer)
        if (n < 0) break
        digest.update(buffer, 0, n)
      }
    }
    return hex(digest.digest())
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  private class UpdateException(val code: String, message: String) : Exception(message)
}
