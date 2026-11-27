package com.whombat.live

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

internal object LiveLocale {
  // Also read by the app's background updater.
  private const val PREFS = "com.whombat.live"
  private const val KEY = "locale"

  fun set(context: Context, tag: String) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (prefs.getString(KEY, null) == tag) return
    prefs.edit().putString(KEY, tag).apply()
    LiveNotifications.ensureChannels(context)
    WhombatStatusWidgetProvider.refreshAll(context)
  }

  fun locale(context: Context, tag: String? = null): Locale {
    val value = tag ?: context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
    return value?.let(Locale::forLanguageTag) ?: Locale.getDefault()
  }

  fun localized(context: Context, tag: String? = null): Context {
    val current = locale(context, tag)
    val language = if (current.language == "nl") current else Locale.UK
    return context.createConfigurationContext(Configuration(context.resources.configuration).apply {
      setLocale(language)
    })
  }
}
