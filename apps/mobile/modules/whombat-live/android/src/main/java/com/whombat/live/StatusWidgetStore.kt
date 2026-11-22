package com.whombat.live

import android.content.Context
import org.json.JSONObject
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * Saved calm status for the Android home-screen widget. Written by the app whenever Home's status
 * changes and cleared on sign-out or when a box is removed; the widget never fetches on its own.
 * Stores the raw status timestamp (`updatedAt`) rather than pre-formatted labels and formats the
 * “as of” text whenever the widget draws.
 */
data class StatusWidgetSnapshot(
  val applianceId: String,
  val source: String = "",
  val boxName: String,
  val status: String,
  val tone: String,
  val timeZone: String,
  val updatedAt: Long,
) {
  /**
   * Formats `updatedAt` at draw time in the box's time zone: “as of 14:05” today, “as of yesterday 23:50”
   * on the next calendar day, or “as of 21 Nov” (with the year when it differs) on any other day.
   */
  fun asOfForNow(nowMs: Long = System.currentTimeMillis()): String {
    val zone = resolveZone(timeZone)
    val atCal = Calendar.getInstance(zone).apply { timeInMillis = updatedAt }
    val nowCal = Calendar.getInstance(zone).apply { timeInMillis = nowMs }
    val atYear = atCal.get(Calendar.YEAR)
    val atMonth = atCal.get(Calendar.MONTH)
    val atDay = atCal.get(Calendar.DAY_OF_MONTH)
    val nowYear = nowCal.get(Calendar.YEAR)
    val diff = utcDayNumber(nowYear, nowCal.get(Calendar.MONTH), nowCal.get(Calendar.DAY_OF_MONTH)) -
      utcDayNumber(atYear, atMonth, atDay)
    val clock = String.format(
      Locale.US,
      "%02d:%02d",
      atCal.get(Calendar.HOUR_OF_DAY),
      atCal.get(Calendar.MINUTE),
    )
    if (diff == 0L) return "as of $clock"
    if (diff == 1L) return "as of yesterday $clock"
    val month = SHORT_MONTHS.getOrElse(atMonth) { "" }
    return if (atYear == nowYear) {
      "as of $atDay $month"
    } else {
      "as of $atDay $month $atYear"
    }
  }

  /**
   * Next wall-clock instant (epoch ms) when `asOfForNow` changes, or null once it is fixed permanently
   * (an older date from a prior year). Adds a 1 s margin past midnight so early alarm wake-ups land on
   * the new calendar day.
   */
  fun nextRolloverAtMs(nowMs: Long = System.currentTimeMillis()): Long? {
    val zone = resolveZone(timeZone)
    val atCal = Calendar.getInstance(zone).apply { timeInMillis = updatedAt }
    val nowCal = Calendar.getInstance(zone).apply { timeInMillis = nowMs }
    val atYear = atCal.get(Calendar.YEAR)
    val nowYear = nowCal.get(Calendar.YEAR)
    val diff = utcDayNumber(nowYear, nowCal.get(Calendar.MONTH), nowCal.get(Calendar.DAY_OF_MONTH)) -
      utcDayNumber(atYear, atCal.get(Calendar.MONTH), atCal.get(Calendar.DAY_OF_MONTH))
    if (diff == 0L || diff == 1L) {
      val nextDay = Calendar.getInstance(zone).apply {
        timeInMillis = nowMs
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
        add(Calendar.DAY_OF_YEAR, 1)
      }
      if (nextDay.timeInMillis <= nowMs) nextDay.add(Calendar.DAY_OF_YEAR, 1)
      return nextDay.timeInMillis + ROLLOVER_MARGIN_MS
    }
    if (diff < 0L) {
      val target = Calendar.getInstance(zone).apply {
        clear()
        if (atYear > nowYear) {
          set(atYear, Calendar.JANUARY, 1, 0, 0, 0)
        } else {
          set(atYear, atCal.get(Calendar.MONTH), atCal.get(Calendar.DAY_OF_MONTH), 0, 0, 0)
        }
      }
      return if (target.timeInMillis > nowMs) target.timeInMillis + ROLLOVER_MARGIN_MS else null
    }
    if (atYear == nowYear) {
      val nextYear = Calendar.getInstance(zone).apply {
        clear()
        set(nowYear + 1, Calendar.JANUARY, 1, 0, 0, 0)
      }
      return nextYear.timeInMillis + ROLLOVER_MARGIN_MS
    }
    return null
  }

  companion object {
    private const val DAY_MS = 86_400_000L
    private const val ROLLOVER_MARGIN_MS = 1_000L
    private val UTC: TimeZone = TimeZone.getTimeZone("UTC")
    private val SHORT_MONTHS = arrayOf(
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    )

    private fun utcDayNumber(year: Int, monthZeroBased: Int, dayOfMonth: Int): Long {
      val utc = Calendar.getInstance(UTC).apply {
        clear()
        set(year, monthZeroBased, dayOfMonth, 0, 0, 0)
      }
      return utc.timeInMillis / DAY_MS
    }

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
      val updatedAt = obj.optLong("updatedAt", 0L)
      if (boxName.isEmpty() || status.isEmpty() || updatedAt <= 0L) return null
      return StatusWidgetSnapshot(
        applianceId = obj.optString("applianceId").trim(),
        source = obj.optString("source").trim(),
        boxName = boxName,
        status = status,
        tone = obj.optString("tone", "ok"),
        timeZone = obj.optString("timeZone").trim(),
        updatedAt = updatedAt,
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
  fun clear(context: Context, applianceId: String? = null, source: String? = null): Boolean {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val existing = prefs.getString(KEY, null) ?: return false
    val filterId = applianceId?.trim().orEmpty()
    val filterSource = source?.trim().orEmpty()
    if (filterId.isNotEmpty() || filterSource.isNotEmpty()) {
      val current = StatusWidgetSnapshot.parse(existing)
      if (current != null) {
        if (filterId.isNotEmpty() && current.applianceId.isNotEmpty() && current.applianceId != filterId) {
          return false
        }
        if (filterSource.isNotEmpty() && !matchesSource(current.source, filterSource)) {
          return false
        }
      }
    }
    prefs.edit().remove(KEY).apply()
    WhombatStatusWidgetProvider.refreshAll(context)
    return true
  }

  /** Pre-upgrade snapshots without a saved source are cleared on cloud sign-out/expiry so they never linger. */
  private fun matchesSource(savedSource: String, requestedSource: String): Boolean {
    if (savedSource == requestedSource) return true
    return savedSource.isEmpty() && requestedSource == "cloud"
  }

  @Synchronized
  fun read(context: Context): StatusWidgetSnapshot? {
    val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return null
    return StatusWidgetSnapshot.parse(raw)
  }
}
