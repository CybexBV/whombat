package com.whombat.live

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
 * Uses RemoteViews directly so the APK adds no extra UI runtime, and renders only what the app last
 * saved in `StatusWidgetStore` (never fetches in the background).
 */
class WhombatStatusWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
    val snapshot = StatusWidgetStore.read(context)
    for (id in appWidgetIds) {
      appWidgetManager.updateAppWidget(id, buildViews(context, snapshot))
    }
  }

  companion object {
    private const val OPEN_REQUEST_CODE = 4201

    fun refreshAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context) ?: return
      val component = ComponentName(context, WhombatStatusWidgetProvider::class.java)
      val ids = manager.getAppWidgetIds(component)
      if (ids.isEmpty()) return
      val snapshot = StatusWidgetStore.read(context)
      for (id in ids) {
        manager.updateAppWidget(id, buildViews(context, snapshot))
      }
    }

    private fun buildViews(context: Context, snapshot: StatusWidgetSnapshot?): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.whombat_status_widget)
      if (snapshot == null) {
        val box = context.getString(R.string.whombat_widget_empty_box)
        val status = context.getString(R.string.whombat_widget_empty_status)
        val asOf = context.getString(R.string.whombat_widget_empty_as_of)
        views.setTextViewText(R.id.whombat_widget_box_name, box)
        views.setTextViewText(R.id.whombat_widget_status, status)
        views.setTextViewText(R.id.whombat_widget_as_of, asOf)
        views.setImageViewResource(R.id.whombat_widget_dot, R.drawable.whombat_widget_dot_neutral)
        views.setContentDescription(R.id.whombat_widget_root, "$box. $status. $asOf.")
      } else {
        val asOf = snapshot.asOfForNow()
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
