package com.whombat.updater

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * A newer app, told while Whombat isn't open (update-check.md): every few hours Android runs `UpdateCheckJob`, which
 * asks control which APK it hands out (the same public `downloads/android` the app asks while open) and, when it is
 * newer than this build, posts one notification for that version. Tapping it opens the app, whose pop-up offers the
 * update. A version the pop-up already showed, or one already notified, isn't notified again.
 *
 * What it remembers sits in the app's own preferences: the address to ask (the app hands it over at every start), the
 * newest version notified and the newest the pop-up showed.
 */
object UpdateWatch {
  private const val PREFS = "whombat-update-watch"
  private const val KEY_URL = "url"
  private const val KEY_NOTIFIED = "notified"
  private const val KEY_SEEN = "seen"
  private const val JOB_ID = 0x57_55_50 // “WUP”: unique among this app's jobs.
  private const val NOTIFICATION_ID = 0x57_55_50
  const val CHANNEL = "whombat-app-updates"

  /** Every three hours, when the phone has a connection; Android picks the moment within that. */
  private const val EVERY_MS = 3 * 60 * 60 * 1000L

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** Keeps the address to ask and makes sure the check is scheduled (kept over restarts of the phone). */
  fun watch(context: Context, url: String) {
    prefs(context).edit().putString(KEY_URL, url).apply()
    val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
    if (scheduler.getPendingJob(JOB_ID)?.intervalMillis == EVERY_MS) return
    val job =
      JobInfo.Builder(JOB_ID, ComponentName(context, UpdateCheckJob::class.java))
        .setPeriodic(EVERY_MS)
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
        .setPersisted(true)
        .build()
    runCatching { scheduler.schedule(job) }
  }

  /** The newest version the in-app pop-up showed (0: none). */
  fun seen(context: Context): Long = prefs(context).getLong(KEY_SEEN, 0)

  /** The pop-up showed this version: no notification for it any more, and one already posted goes. */
  fun markSeen(context: Context, versionCode: Long) {
    val p = prefs(context)
    if (versionCode > p.getLong(KEY_SEEN, 0)) p.edit().putLong(KEY_SEEN, versionCode).apply()
    NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
  }

  /** Asks control once and notifies when a newer, not yet announced version is out. Runs off the main thread. */
  fun check(context: Context) {
    val p = prefs(context)
    val url = p.getString(KEY_URL, null) ?: return
    val published = fetch(url) ?: return
    val own = ownVersionCode(context)
    val announced = maxOf(p.getLong(KEY_NOTIFIED, 0), p.getLong(KEY_SEEN, 0))
    if (published.versionCode <= own || published.versionCode <= announced) return
    // Notifications turned off: nothing is marked, so the next check tries again once they are on.
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    if (notify(context, published.version)) p.edit().putLong(KEY_NOTIFIED, published.versionCode).apply()
  }

  private class Published(val version: String, val versionCode: Long)

  private fun fetch(url: String): Published? {
    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
      connectTimeout = 15_000
      readTimeout = 15_000
      setRequestProperty("Accept", "application/json")
    }
    return try {
      if (connection.responseCode !in 200..299) return null
      val body = connection.inputStream.bufferedReader().use { it.readText() }
      val android = JSONObject(body).optJSONObject("android") ?: return null
      val version = android.optString("version").takeIf { it.isNotBlank() } ?: return null
      val code = android.optLong("versionCode", 0)
      if (code <= 0) null else Published(version, code)
    } catch (_: Exception) {
      null
    } finally {
      connection.disconnect()
    }
  }

  private fun notify(context: Context, version: String): Boolean {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
          description = "When a new version of the Whombat app is ready."
        },
      )
    }
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    } ?: return false
    val tap = PendingIntent.getActivity(
      context,
      NOTIFICATION_ID,
      open,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    // The status-bar mark the push notifications use (whombat-live), else the app's icon.
    val small = context.resources.getIdentifier("whombat_live_small", "drawable", context.packageName)
      .takeIf { it != 0 } ?: context.applicationInfo.icon
    val notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(small)
      .setContentTitle("A new version of Whombat is ready")
      .setContentText("Version $version is out. Tap to update.")
      .setContentIntent(tap)
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .build()
    return runCatching { manager.notify(NOTIFICATION_ID, notification) }.isSuccess
  }

  @Suppress("DEPRECATION")
  private fun ownVersionCode(context: Context): Long {
    val info: PackageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
  }
}
