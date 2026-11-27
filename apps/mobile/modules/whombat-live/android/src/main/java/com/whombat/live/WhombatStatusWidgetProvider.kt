package com.whombat.live

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews

/**
 * Small home-screen widget showing Whombat's last saved calm status and opening the app when tapped.
 * Uses RemoteViews directly so the APK adds no extra UI runtime, renders only what the app last saved
 * in `StatusWidgetStore` (never fetches in the background), and re-formats the saved timestamp at draw
 * time so a time from last night never looks like today.
 */
class WhombatStatusWidgetProvider : AppWidgetProvider() {
  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    when (intent.action) {
      ACTION_ROLLOVER,
      Intent.ACTION_DATE_CHANGED,
      Intent.ACTION_TIME_CHANGED,
      Intent.ACTION_TIMEZONE_CHANGED,
      Intent.ACTION_MY_PACKAGE_REPLACED,
      -> refreshAll(context)
    }
  }

  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    val nowMs = System.currentTimeMillis()
    val snapshot = StatusWidgetStore.read(context)
    for (id in appWidgetIds) {
      appWidgetManager.updateAppWidget(id, buildViews(context, snapshot, nowMs))
    }
    scheduleNextRollover(context, snapshot, nowMs)
  }

  override fun onDisabled(context: Context) {
    super.onDisabled(context)
    cancelRollover(context)
  }

  companion object {
    private const val OPEN_REQUEST_CODE = 4201
    private const val ROLLOVER_REQUEST_CODE = 4202
    internal const val ACTION_ROLLOVER = "com.whombat.live.ACTION_STATUS_WIDGET_ROLLOVER"

    fun refreshAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context) ?: return
      val component = ComponentName(context, WhombatStatusWidgetProvider::class.java)
      val ids = manager.getAppWidgetIds(component)
      if (ids.isEmpty()) {
        cancelRollover(context)
        return
      }
      val nowMs = System.currentTimeMillis()
      val snapshot = StatusWidgetStore.read(context)
      for (id in ids) {
        manager.updateAppWidget(id, buildViews(context, snapshot, nowMs))
      }
      scheduleNextRollover(context, snapshot, nowMs)
    }

    private fun scheduleNextRollover(context: Context, snapshot: StatusWidgetSnapshot?, nowMs: Long) {
      val nextAt = snapshot?.nextRolloverAtMs(nowMs)
      if (nextAt == null) {
        cancelRollover(context)
        return
      }
      val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
      val pending = rolloverIntent(context, PendingIntent.FLAG_UPDATE_CURRENT) ?: return
      runCatching {
        // Plain RTC avoids waking a sleeping phone; Android delivers the redraw when it next wakes.
        alarmManager.set(AlarmManager.RTC, nextAt, pending)
      }
    }

    private fun cancelRollover(context: Context) {
      val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
      val pending = rolloverIntent(context, PendingIntent.FLAG_NO_CREATE) ?: return
      runCatching { alarmManager.cancel(pending) }
      pending.cancel()
    }

    private fun rolloverIntent(context: Context, flags: Int): PendingIntent? {
      val intent = Intent(context, WhombatStatusWidgetProvider::class.java).setAction(ACTION_ROLLOVER)
      return PendingIntent.getBroadcast(
        context,
        ROLLOVER_REQUEST_CODE,
        intent,
        flags or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    private fun buildViews(context: Context, snapshot: StatusWidgetSnapshot?, nowMs: Long): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.whombat_status_widget)
      if (snapshot == null) {
        val words = LiveLocale.localized(context)
        val box = words.getString(R.string.whombat_widget_empty_box)
        val status = words.getString(R.string.whombat_widget_empty_status)
        val asOf = words.getString(R.string.whombat_widget_empty_as_of)
        views.setTextViewText(R.id.whombat_widget_box_name, box)
        views.setTextViewText(R.id.whombat_widget_status, status)
        views.setTextViewText(R.id.whombat_widget_as_of, asOf)
        views.setImageViewResource(R.id.whombat_widget_dot, R.drawable.whombat_widget_dot_neutral)
        views.setContentDescription(R.id.whombat_widget_root, "$box. $status. $asOf.")
      } else {
        val asOf = snapshot.asOfForNow(context, nowMs)
        views.setTextViewText(R.id.whombat_widget_box_name, snapshot.boxName)
        views.setTextViewText(R.id.whombat_widget_status, snapshot.status)
        views.setTextViewText(R.id.whombat_widget_as_of, asOf)
        views.setImageViewResource(R.id.whombat_widget_dot, dotForTone(snapshot.tone))
        views.setContentDescription(
          R.id.whombat_widget_root,
          "${snapshot.boxName}. ${snapshot.status}, $asOf.",
        )
      }
      views.setOnClickPendingIntent(R.id.whombat_widget_root, openAppIntent(context))
      return views
    }

    private fun dotForTone(tone: String): Int =
      when (tone) {
        "ok" -> R.drawable.whombat_widget_dot_ok
        "warn" -> R.drawable.whombat_widget_dot_warn
        "bad" -> R.drawable.whombat_widget_dot_bad
        else -> R.drawable.whombat_widget_dot_neutral
      }

    private fun openAppIntent(context: Context): PendingIntent {
      val intent = (
        context.packageManager.getLaunchIntentForPackage(context.packageName)
          ?: Intent(Intent.ACTION_VIEW, Uri.parse("${LiveDisplay.SCHEME}://")).setPackage(context.packageName)
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
      return PendingIntent.getActivity(
        context,
        OPEN_REQUEST_CODE,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
  }
}
