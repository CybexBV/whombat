package com.whombat.live

import android.content.Context
import org.json.JSONObject
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * Saved calm status for the Android home-screen widget. Written by the app whenever Home's status
 * changes and cleared on sign-out or when a box is removed; the widget never fetches on its own.
 */
data class StatusWidgetSnapshot(
  val applianceId: String,
  val boxName: String,
  val status: String,
  val tone: String,
  val asOf: String,
  val asOfEarlier: String,
  val asOfDay: String,
  val timeZone: String,
  val updatedAt: Long,
) {
  /** Uses “as of 14:05” on the same calendar day in the box's time zone, else “as of 21 Nov”. */
  fun asOfForNow(nowMs: Long = System.currentTimeMillis()): String {
    val zone = resolveZone(timeZone)
    val cal = Calendar.getInstance(zone).apply { timeInMillis = nowMs }
    val today = String.format(
      Locale.US,
      "%04d-%02d-%02d",
      cal.get(Calendar.YEAR),
      cal.get(Calendar.MONTH) + 1,
      cal.get(Calendar.DAY_OF_MONTH),
    )
    return if (today == asOfDay) asOf else asOfEarlier
  }

  companion object {
    private fun resolveZone(id: String): TimeZone {
      if (id.isBlank()) return TimeZone.getDefault()
      val zone = TimeZone.getTimeZone(id)
      val fellBack = zone.id == "GMT" && !id.equals("GMT", ignoreCase = true) && !id.equals("UTC", ignoreCase = true)
      return if (fellBack) TimeZone.getDefault() else zone
    }

    fun parse(json: String): StatusWidgetSnapshot? {
      val obj = runCatching { JSONObject(json) }.getOrNull() ?: return null
      val boxName = obj.optString("boxName").trim()
      val status = obj.optString("status").trim()
      val asOf = obj.optString("asOf").trim()
      if (boxName.isEmpty() || status.isEmpty() || asOf.isEmpty()) return null
      val asOfEarlier = obj.optString("asOfEarlier").trim().ifEmpty { asOf }
      return StatusWidgetSnapshot(
        applianceId = obj.optString("applianceId").trim(),
        boxName = boxName,
        status = status,
        tone = obj.optString("tone", "ok"),
        asOf = asOf,
        asOfEarlier = asOfEarlier,
        asOfDay = obj.optString("asOfDay").trim(),
        timeZone = obj.optString("timeZone").trim(),
        updatedAt = obj.optLong("updatedAt", 0L),
      )
    }
  }
}

object StatusWidgetStore {
  private const val PREFS = "com.whombat.live.widget"
  private const val KEY = "status"

  @Synchronized
  fun save(context: Context, json: String): Boolean {
    if (StatusWidgetSnapshot.parse(json) == null) return false
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (prefs.getString(KEY, null) == json) return false
    prefs.edit().putString(KEY, json).apply()
    WhombatStatusWidgetProvider.refreshAll(context)
    return true
  }

  @Synchronized
  fun clear(context: Context, applianceId: String? = null): Boolean {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val existing = prefs.getString(KEY, null) ?: return false
    if (!applianceId.isNullOrBlank()) {
      val current = StatusWidgetSnapshot.parse(existing)
      if (current != null && current.applianceId.isNotEmpty() && current.applianceId != applianceId) {
        return false
      }
    }
    prefs.edit().remove(KEY).apply()
    WhombatStatusWidgetProvider.refreshAll(context)
    return true
  }

  @Synchronized
  fun read(context: Context): StatusWidgetSnapshot? {
    val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return null
    return StatusWidgetSnapshot.parse(raw)
  }
}
