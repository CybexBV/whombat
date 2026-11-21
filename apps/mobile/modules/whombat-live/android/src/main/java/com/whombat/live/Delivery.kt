package com.whombat.live

import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat

/**
 * Whether Android lets Whombat's notifications through, beyond the app-wide permission: a channel turned off (the
 * person long-pressed a notification, or the channel's group is off), the app restricted in the background (its data
 * pushes don't reach it then), battery optimisation (Android's default, reported only) and, on Android 16 QPR1+, Live
 * Updates not allowed. Read only: it never asks for an exemption and never touches the push registration. The
 * Settings → Notifications row reads it (`src/managed/useDelivery.ts`) and names what is off with a button to the page
 * that turns it back on.
 */
object Delivery {
  /** The channels in the order they matter: an approval waiting first. */
  private val CHANNELS =
    listOf(LiveNotifications.CHANNEL_NEEDS_YOU, LiveNotifications.CHANNEL_UPDATES, LiveNotifications.CHANNEL_RUNS)

  /** `Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS` (public from API 36.1). */
  private const val ACTION_PROMOTION_SETTINGS = "android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS"

  fun status(context: Context): Map<String, Any> {
    val notifications = context.getSystemService(NotificationManager::class.java)
    return buildMap {
      // The app-wide switch: on Android 8 to 12, turning it off neither ends the app nor marks the channels off, and
      // a registered app doesn't ask the permission again on its return.
      put("enabled", NotificationManagerCompat.from(context).areNotificationsEnabled())
      put("channels", channels(context, notifications))
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        context.getSystemService(ActivityManager::class.java)?.let { put("backgroundRestricted", it.isBackgroundRestricted) }
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        context.getSystemService(PowerManager::class.java)?.let {
          put("batteryOptimized", !it.isIgnoringBatteryOptimizations(context.packageName))
        }
      }
      liveUpdatesAllowed(context, notifications)?.let { put("liveUpdatesAllowed", it) }
    }
  }

  private fun channels(context: Context, manager: NotificationManager?): List<Map<String, Any>> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || manager == null) return emptyList()
    LiveNotifications.ensureChannels(context)
    return CHANNELS.mapNotNull { id ->
      val channel = manager.getNotificationChannel(id) ?: return@mapNotNull null
      val groupBlocked =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
          channel.group?.let { manager.getNotificationChannelGroup(it)?.isBlocked } == true
      mapOf(
        "id" to id,
        "name" to channel.name.toString(),
        "blocked" to (channel.importance == NotificationManager.IMPORTANCE_NONE || groupBlocked),
      )
    }
  }

  /**
   * `NotificationManager.canPostPromotedNotifications()`, Android 16 QPR1+; looked up by name, since the build's SDK
   * may be older than the method. Null where there is no such choice: the method is missing, or this phone has no
   * settings page to turn it back on with (some makers leave it out).
   */
  private fun liveUpdatesAllowed(context: Context, manager: NotificationManager?): Boolean? {
    if (Build.VERSION.SDK_INT < 36 || manager == null) return null
    if (promotionSettings(context).resolveActivity(context.packageManager) == null) return null
    return runCatching {
      NotificationManager::class.java.getMethod("canPostPromotedNotifications").invoke(manager) as? Boolean
    }.getOrNull()
  }

  private fun promotionSettings(context: Context): Intent =
    Intent(ACTION_PROMOTION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)

  /**
   * Opens the settings page for one thing the row names: `channel` (one channel's page), `notifications` (the app's
   * notifications), `liveUpdates` (Live Updates) or `battery` (the app's page, where Android keeps its battery use).
   * Falls back to the app's page; false when nothing opened.
   */
  fun openSettings(context: Context, page: String, channel: String?, start: (Intent) -> Unit): Boolean {
    val pkg = context.packageName
    val intents = buildList {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        when (page) {
          "channel" ->
            if (channel != null) {
              add(
                Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                  .putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
                  .putExtra(Settings.EXTRA_CHANNEL_ID, channel),
              )
            }
          "liveUpdates" -> add(promotionSettings(context))
        }
        if (page != "battery") add(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg))
      }
      add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg")))
    }
    return intents.any { intent -> runCatching { start(intent) }.isSuccess }
  }
}
