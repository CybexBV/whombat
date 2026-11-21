package com.whombat.systembars

import androidx.core.view.WindowInsetsControllerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * `WhombatSystemBars` (Android): the system's area under the tab bar follows the app's theme (fold-bar.md AP-2751).
 * React Native says light or dark once, as the activity starts, from the window's theme at that moment; the app's own
 * Light/Dark choice and a theme change while it runs come later, so Android drew for the wrong one (a white film over
 * the dark bar on the unfolded screen). The film is off in the theme (`plugins/with-navigation-bar.cjs`); this tells
 * Android which theme the colour under the handle has, so the handle and the three buttons are drawn light on dark
 * and dark on light. The last choice is applied again when an activity comes to the front (Android recreated it).
 * The JavaScript side is `modules/whombat-system-bars/index.ts`.
 */
class WhombatSystemBarsModule : Module() {
  @Volatile private var dark: Boolean? = null

  override fun definition() = ModuleDefinition {
    Name("WhombatSystemBars")

    Function("setNavigationBarTheme") { theme: String ->
      dark = theme == "dark"
      apply()
    }

    OnActivityEntersForeground { apply() }
  }

  private fun apply() {
    val dark = dark ?: return
    val activity = appContext.currentActivity ?: return
    activity.runOnUiThread {
      val window = activity.window ?: return@runOnUiThread
      WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightNavigationBars = !dark
    }
  }
}
