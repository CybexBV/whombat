package com.whombat.live

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Renders live activities as ongoing notifications and inbox pushes as plain ones.
 *
 * - Android 16+: `Notification.ProgressStyle` (one segment for a run, one per condition for an approval),
 *   the status-bar chip text (`setShortCriticalText`) and the request to be promoted to a Live Update.
 * - Older versions: an ongoing `NotificationCompat` with a progress bar.
 *
 * Each activity is one notification, tagged with its key (`run:<id>`, `approval:<id>`), so the app's
 * realtime updates and data pushes replace the same notification. An ongoing one goes by itself 10 minutes after
 * its last update (every update starts the 10 minutes again), so one nobody updates any more — the app was killed,
 * a managed Whombat sends no live pushes (NT-13) — doesn't stay for ever (MN-02); an ended activity stays as a
 * dismissible last state for 30 minutes.
 */
object LiveNotifications {
  const val CHANNEL_RUNS = "whombat.runs"
  private const val GENERIC_TAG = "whombat.push:"
  const val CHANNEL_NEEDS_YOU = "whombat.needs-you"
  const val CHANNEL_UPDATES = "whombat.updates"

  private const val LIVE_ID = 1
  private const val INBOX_ID = 2
  private const val LIVE_TAG = "whombat.live:"
  private const val INBOX_TAG = "whombat.inbox:"
  private const val EXTRA_KEY = "com.whombat.live.key"
  private const val EXTRA_BURROW = "com.whombat.live.burrow"
  private const val EXTRA_ONGOING = "com.whombat.live.ongoing"
  /** `Notification.EXTRA_REQUEST_PROMOTED_ONGOING` (public from API 36.1; the extra works on 36). */
  private const val EXTRA_REQUEST_PROMOTED_ONGOING = "android.requestPromotedOngoing"
  private const val ENDED_TIMEOUT_MS = 30 * 60 * 1000L
  /** An ongoing activity without an update for this long goes (MN-02); each update starts it again. */
  private const val LIVE_TIMEOUT_MS = 10 * 60 * 1000L
  /** What the app reads back from the shade (MN-04): an inbox or managed notification's row, path, ref and kind. */
  private const val EXTRA_KIND = "com.whombat.live.kind"
  private const val EXTRA_NOTIFICATION = "com.whombat.live.notification"
  private const val EXTRA_PATH = "com.whombat.live.path"
  private const val EXTRA_REF = "com.whombat.live.ref"
  /** Activities shown lately (key → epoch ms), so the app doesn't bring back one that timed out or was swiped away. */
  private const val RECENT_PREFS = "com.whombat.live.recent"
  private const val RECENT_MS = 24 * 60 * 60 * 1000L

  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val words = LiveLocale.localized(context)
    // Re-registering a channel ID updates its name and description and retains the person's settings.
    manager.createNotificationChannels(
      listOf(
        NotificationChannel(CHANNEL_RUNS, words.getString(R.string.whombat_channel_runs), NotificationManager.IMPORTANCE_LOW).apply {
          description = words.getString(R.string.whombat_channel_runs_description)
          setShowBadge(false)
        },
        NotificationChannel(CHANNEL_NEEDS_YOU, words.getString(R.string.whombat_channel_needs_you), NotificationManager.IMPORTANCE_HIGH).apply {
          description = words.getString(R.string.whombat_channel_needs_you_description)
        },
        NotificationChannel(CHANNEL_UPDATES, words.getString(R.string.whombat_channel_updates), NotificationManager.IMPORTANCE_DEFAULT)
          .apply { description = words.getString(R.string.whombat_channel_updates_description) },
      ),
    )
  }

  fun canPost(context: Context): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      return false
    }
    return NotificationManagerCompat.from(context).areNotificationsEnabled()
  }

  /** Show or update an activity; an ended display (`ongoing: false`) becomes its dismissible last state. */
  fun show(context: Context, display: LiveDisplay) {
    if (!canPost(context)) return
    ensureChannels(context)
    val notification =
      if (Build.VERSION.SDK_INT >= 36) buildProgressStyle(context, display) else buildCompat(context, display)
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    manager.notify(LIVE_TAG + display.key, LIVE_ID, notification)
    if (display.ongoing) remember(context, display.key)
  }

  /** Keys of the activities shown in the last 24 hours, on screen or not (MN-02). */
  fun recent(context: Context): List<String> {
    val now = System.currentTimeMillis()
    return context.getSharedPreferences(RECENT_PREFS, Context.MODE_PRIVATE).all
      .filter { (_, at) -> at is Long && now - at < RECENT_MS }
      .keys
      .toList()
  }

  private fun remember(context: Context, key: String) {
    val prefs = context.getSharedPreferences(RECENT_PREFS, Context.MODE_PRIVATE)
    val now = System.currentTimeMillis()
    val edit = prefs.edit()
    for ((old, at) in prefs.all) if (at !is Long || now - at >= RECENT_MS) edit.remove(old)
    edit.putLong(key, now).apply()
  }

  fun end(context: Context, key: String, last: LiveDisplay?) {
    if (last != null) {
      show(context, last.ended())
      return
    }
    context.getSystemService(NotificationManager::class.java)?.cancel(LIVE_TAG + key, LIVE_ID)
  }

  /** Every Whombat notification (sign-out), and what was shown lately. */
  fun endAll(context: Context) {
    context.getSharedPreferences(RECENT_PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    for (n in manager.activeNotifications) {
      val tag = n.tag ?: continue
      if (tag.startsWith(LIVE_TAG) || tag.startsWith(INBOX_TAG) || tag.startsWith(GENERIC_TAG)) manager.cancel(tag, n.id)
    }
  }

  /**
   * The inbox and managed notifications in the shade (MN-04), for the app to cancel the ones read in the app: the tag
   * (handed back to `cancel`), the kind, and an inbox push's burrow, row and path or a managed push's ref.
   */
  fun shade(context: Context): List<Map<String, Any>> {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return emptyList()
    return manager.activeNotifications
      .filter { it.id == INBOX_ID && (it.tag?.startsWith(INBOX_TAG) == true || it.tag?.startsWith(GENERIC_TAG) == true) }
      .map { n ->
        val extras = n.notification.extras
        buildMap {
          put("tag", n.tag)
          put("postedAt", n.postTime.toDouble())
          extras.getString(EXTRA_KIND)?.let { put("kind", it) }
          extras.getString(EXTRA_BURROW)?.let { put("burrow", it) }
          extras.getString(EXTRA_NOTIFICATION)?.let { put("notificationId", it) }
          extras.getString(EXTRA_PATH)?.let { put("path", it) }
          extras.getString(EXTRA_REF)?.let { put("ref", it) }
        }
      }
  }

  /** Cancels inbox and managed notifications by the tags `shade` gave (MN-04); any other tag is ignored. */
  fun cancel(context: Context, tags: List<String>) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    for (tag in tags) if (tag.startsWith(INBOX_TAG) || tag.startsWith(GENERIC_TAG)) manager.cancel(tag, INBOX_ID)
  }

  /** Ongoing activities on screen: key, burrow. */
  fun active(context: Context): List<Pair<String, String>> {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return emptyList()
    return manager.activeNotifications
      .filter { it.id == LIVE_ID && it.tag?.startsWith(LIVE_TAG) == true }
      .filter { it.notification.extras.getBoolean(EXTRA_ONGOING, false) }
      .map {
        Pair(
          it.notification.extras.getString(EXTRA_KEY) ?: it.tag.removePrefix(LIVE_TAG),
          it.notification.extras.getString(EXTRA_BURROW) ?: "",
        )
      }
  }

  /** A Whombat inbox notification (needs you, mention, agent update) that opens its screen. */
  fun showInbox(
    context: Context,
    kind: String,
    title: String,
    body: String,
    path: String,
    burrow: String,
    notificationId: String?,
  ) {
    if (!canPost(context)) return
    ensureChannels(context)
    val open = Uri.Builder()
      .scheme(LiveDisplay.SCHEME)
      .authority("open")
      .appendQueryParameter("path", path)
      .appendQueryParameter("burrow", burrow)
      .apply { if (!notificationId.isNullOrEmpty()) appendQueryParameter("notification", notificationId) }
      .build()
      .toString()
    val needsYou = kind == "needs_you"
    val notification = NotificationCompat.Builder(context, if (needsYou) CHANNEL_NEEDS_YOU else CHANNEL_UPDATES)
      .setSmallIcon(R.drawable.whombat_live_small)
      .setColor(LiveColors.forTone(context, if (needsYou) "warn" else "neutral"))
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setCategory(if (needsYou) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(if (needsYou) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
      .setAutoCancel(true)
      .setContentIntent(openIntent(context, open))
      .addExtras(
        Bundle().apply {
          putString(EXTRA_KIND, kind)
          putString(EXTRA_BURROW, burrow)
          putString(EXTRA_PATH, path)
          if (!notificationId.isNullOrEmpty()) putString(EXTRA_NOTIFICATION, notificationId)
        },
      )
      .build()
    context.getSystemService(NotificationManager::class.java)
      ?.notify(INBOX_TAG + (notificationId?.ifEmpty { null } ?: path), INBOX_ID, notification)
  }

  /**
   * What a managed push says when it has no preview (an appliance before CT-286, or previews turned off in
   * Settings → Notifications), and always on the lock screen's public version: one line per kind, the same as
   * `PUSH_TEXT` in `@whombat/client/managed` (checked by `content.test.ts`). A tap opens
   * `whombat://push?kind=…&ref=…`; the app finds out what happened through its session.
   */
  val GENERIC_TEXT = mapOf(
    "message" to R.string.whombat_push_message,
    "mention" to R.string.whombat_push_mention,
    "approval" to R.string.whombat_push_approval,
    "run" to R.string.whombat_push_run,
    "update" to R.string.whombat_push_update,
    "backup" to R.string.whombat_push_backup,
    "security" to R.string.whombat_push_security,
    "generic" to R.string.whombat_push_generic,
  )

  fun pushTapUrl(kind: String, ref: String): String =
    Uri.Builder()
      .scheme(LiveDisplay.SCHEME)
      .authority("push")
      .appendQueryParameter("kind", kind)
      .appendQueryParameter("ref", ref)
      .build()
      .toString()

  /**
   * A managed push (CT-286): its preview (who wrote and where as the title, the start of the message as the text),
   * else “Whombat” and the kind's line. One notification per tag (a thread, an approval): the next one replaces it
   * without sounding again while it still shows. With “hide sensitive content” the lock screen shows the public
   * version, “Whombat” and the kind's line.
   */
  fun showGeneric(context: Context, push: ManagedPush) {
    if (!canPost(context)) return
    ensureChannels(context)
    val kind = if (GENERIC_TEXT.containsKey(push.kind)) push.kind else "generic"
    val words = LiveLocale.localized(context)
    val generic = words.getString(GENERIC_TEXT.getValue(kind))
    val defaultTitle = words.getString(R.string.whombat_notification_title)
    val title = push.title ?: defaultTitle
    val text = push.body ?: generic
    val needsYou = kind == "approval" || kind == "security"
    val channel = if (needsYou) CHANNEL_NEEDS_YOU else CHANNEL_UPDATES
    val color = LiveColors.forTone(context, if (needsYou) "warn" else "neutral")
    val category = if (needsYou) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_MESSAGE
    val priority = if (needsYou) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT
    val lockScreen = NotificationCompat.Builder(context, channel)
      .setSmallIcon(R.drawable.whombat_live_small)
      .setColor(color)
      .setContentTitle(defaultTitle)
      .setContentText(generic)
      .setCategory(category)
      .build()
    val builder = NotificationCompat.Builder(context, channel)
      .setSmallIcon(R.drawable.whombat_live_small)
      .setColor(color)
      .setContentTitle(title)
      .setContentText(text)
      .setCategory(category)
      .setPriority(priority)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(lockScreen)
      .setOnlyAlertOnce(true)
      .setAutoCancel(true)
      .setContentIntent(openIntent(context, pushTapUrl(kind, push.ref)))
      .addExtras(Bundle().apply { putString(EXTRA_KIND, kind); putString(EXTRA_REF, push.ref) })
    if (push.body != null) builder.setStyle(NotificationCompat.BigTextStyle().bigText(push.body))
    context.getSystemService(NotificationManager::class.java)
      ?.notify(GENERIC_TAG + push.tag, INBOX_ID, builder.build())
  }

  /** A managed push's `clear` (an approval decided elsewhere): the notification with this tag goes away. */
  fun clearGeneric(context: Context, tag: String) {
    context.getSystemService(NotificationManager::class.java)?.cancel(GENERIC_TAG + tag, INBOX_ID)
  }

  private fun channelFor(display: LiveDisplay): String =
    if (display.kind == "approval") CHANNEL_NEEDS_YOU else CHANNEL_RUNS

  private fun extrasFor(display: LiveDisplay): Bundle =
    Bundle().apply {
      putString(EXTRA_KEY, display.key)
      putString(EXTRA_BURROW, display.burrow)
      putBoolean(EXTRA_ONGOING, display.ongoing)
      if (display.ongoing) putBoolean(EXTRA_REQUEST_PROMOTED_ONGOING, true)
    }

  private fun actionLabel(words: Context, action: String): String? =
    when (action) {
      "open_run" -> words.getString(R.string.whombat_action_open_run)
      "details" -> words.getString(R.string.whombat_action_details)
      // The button opens the approval page.
      "approve" -> words.getString(R.string.whombat_action_review)
      else -> null
    }

  @RequiresApi(36)
  private fun buildProgressStyle(context: Context, display: LiveDisplay): Notification {
    val color = LiveColors.forTone(context, display.tone)
    val builder = Notification.Builder(context, channelFor(display))
      .setSmallIcon(R.drawable.whombat_live_small)
      .setContentTitle(display.title)
      .setContentText(display.text)
      .setSubText(display.label)
      .setColor(color)
      .setOngoing(display.ongoing)
      .setOnlyAlertOnce(true)
      .setAutoCancel(!display.ongoing)
      .setShowWhen(!display.ongoing)
      .setCategory(if (display.kind == "run") Notification.CATEGORY_PROGRESS else Notification.CATEGORY_STATUS)
      .setContentIntent(openIntent(context, display.url))
      .addExtras(extrasFor(display))
    builder.setTimeoutAfter(if (display.ongoing) LIVE_TIMEOUT_MS else ENDED_TIMEOUT_MS)
    if (display.ongoing && display.chip != null) builder.setShortCriticalText(display.chip)
    val style = Notification.ProgressStyle().setStyledByProgress(true)
    if (display.segments > 1) {
      style.setProgressSegments(List(display.segments) { Notification.ProgressStyle.Segment(1).setColor(color) })
      style.setProgress(Math.round(display.progress * display.segments / 100f))
    } else {
      style.setProgressSegments(listOf(Notification.ProgressStyle.Segment(100).setColor(color)))
      style.setProgress(display.progress)
    }
    style.setProgressTrackerIcon(Icon.createWithResource(context, R.drawable.whombat_live_tracker))
    builder.setStyle(style)
    val words = LiveLocale.localized(context, display.locale)
    for (action in display.actions) {
      val label = actionLabel(words, action) ?: continue
      val intent = openIntent(context, display.url)
      val icon = Icon.createWithResource(context, R.drawable.whombat_live_small)
      builder.addAction(
        Notification.Action.Builder(icon, label, intent)
          .setAuthenticationRequired(action == "approve")
          .build(),
      )
    }
    return builder.build()
  }

  private fun buildCompat(context: Context, display: LiveDisplay): Notification {
    val builder = NotificationCompat.Builder(context, channelFor(display))
      .setSmallIcon(R.drawable.whombat_live_small)
      .setContentTitle(display.title)
      .setContentText(display.text)
      .setSubText(display.label)
      .setColor(LiveColors.forTone(context, display.tone))
      .setOngoing(display.ongoing)
      .setOnlyAlertOnce(true)
      .setAutoCancel(!display.ongoing)
      .setShowWhen(!display.ongoing)
      .setCategory(
        if (display.kind == "run") NotificationCompat.CATEGORY_PROGRESS else NotificationCompat.CATEGORY_STATUS,
      )
      .setPriority(
        if (display.kind == "approval") NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_LOW,
      )
      .setContentIntent(openIntent(context, display.url))
      .addExtras(extrasFor(display))
      .setRequestPromotedOngoing(display.ongoing)
    builder.setTimeoutAfter(if (display.ongoing) LIVE_TIMEOUT_MS else ENDED_TIMEOUT_MS)
    if (display.ongoing && display.chip != null) builder.setShortCriticalText(display.chip)
    if (display.segments > 1) {
      builder.setProgress(display.segments, Math.round(display.progress * display.segments / 100f), false)
    } else {
      builder.setProgress(100, display.progress, false)
    }
    val words = LiveLocale.localized(context, display.locale)
    for (action in display.actions) {
      val label = actionLabel(words, action) ?: continue
      builder.addAction(
        NotificationCompat.Action.Builder(
          R.drawable.whombat_live_small,
          label,
          openIntent(context, display.url),
        )
          .setAuthenticationRequired(action == "approve")
          .build(),
      )
    }
    return builder.build()
  }

  /** Opens the app on a deep link (`whombat://runs/1907`); a real activity, so no trampoline. */
  private fun openIntent(context: Context, url: String): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      url.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
}
