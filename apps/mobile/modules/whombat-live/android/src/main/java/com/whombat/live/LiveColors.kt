package com.whombat.live

import android.content.Context
import android.graphics.Color
import org.json.JSONObject

/**
 * Accent colors by tone. The app passes them from `@whombat/tokens` (`WhombatLive.configure`) and they are
 * kept for pushes that arrive while the app is not running. The defaults mirror the tokens' fixed colors
 * (run progress, status dots; README "fixed colors") — `live-colors.test.ts` checks they stay in sync.
 */
object LiveColors {
  private const val PREFS = "com.whombat.live"
  private const val KEY = "colors"

  /** tokens `fixedColors.progress` */
  const val DEFAULT_OK = "#5aa37a"
  /** tokens `statusColors.waiting` */
  const val DEFAULT_WARN = "#d9a84a"
  /** tokens light `bad` */
  const val DEFAULT_BAD = "#9f5540"
  /** tokens `statusColors.idle` */
  const val DEFAULT_NEUTRAL = "#a0958a"

  fun save(context: Context, json: String) {
    JSONObject(json) // validate
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).apply()
  }

  fun forTone(context: Context, tone: String): Int {
    val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
    val colors = runCatching { JSONObject(saved ?: "{}") }.getOrDefault(JSONObject())
    val fallback = when (tone) {
      "ok" -> DEFAULT_OK
      "warn" -> DEFAULT_WARN
      "bad" -> DEFAULT_BAD
      else -> DEFAULT_NEUTRAL
    }
    return runCatching { Color.parseColor(colors.optString(tone, fallback)) }
      .getOrDefault(Color.parseColor(fallback))
  }
}
