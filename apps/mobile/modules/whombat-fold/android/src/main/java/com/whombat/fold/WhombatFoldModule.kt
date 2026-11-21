package com.whombat.fold

import android.app.Activity
import androidx.core.content.ContextCompat
import androidx.core.util.Consumer
import androidx.window.java.layout.WindowInfoTrackerCallbackAdapter
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * `WhombatFold` (Android): where a foldable's fold is and whether it is half open, from Jetpack WindowManager
 * (docs/app/decisions/iphone-duo.md). The fold comes in window pixels and goes out in dp, the units React Native lays
 * out in; Android has no vertical system bar, so `barEdge` is always null and there are no occlusion regions. The
 * listener follows the activity in front, and `onChange` sends a state that differs from the last. The JavaScript side
 * is `modules/whombat-fold/index.ts`.
 */
class WhombatFoldModule : Module() {
  private var tracker: WindowInfoTrackerCallbackAdapter? = null
  private var listening: Activity? = null
  @Volatile private var last: Map<String, Any?>? = null
  private val consumer = Consumer<WindowLayoutInfo> { info -> publish(info) }

  override fun definition() = ModuleDefinition {
    Name("WhombatFold")

    Events("onChange")

    /** The last state read, or null before the first. */
    Function("current") { last }

    OnCreate { listen() }

    OnActivityEntersForeground { listen() }

    OnActivityEntersBackground { stop() }

    OnActivityDestroys { stop() }

    OnDestroy { stop() }
  }

  private fun listen() {
    val activity = appContext.currentActivity ?: return
    activity.runOnUiThread {
      if (listening === activity) return@runOnUiThread
      stop()
      val adapter = WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(activity))
      adapter.addWindowLayoutInfoListener(activity, ContextCompat.getMainExecutor(activity), consumer)
      tracker = adapter
      listening = activity
    }
  }

  private fun stop() {
    tracker?.removeWindowLayoutInfoListener(consumer)
    tracker = null
    listening = null
  }

  private fun publish(info: WindowLayoutInfo) {
    val activity = listening ?: return
    val density = activity.resources.displayMetrics.density
    val folds = info.displayFeatures.filterIsInstance<FoldingFeature>()
    val posture =
      when {
        folds.any { it.state == FoldingFeature.State.HALF_OPENED } -> "half"
        folds.isNotEmpty() -> "flat"
        else -> null
      }
    val state =
      mapOf(
        "barEdge" to null,
        "folds" to
          folds.map {
            mapOf(
              "x" to it.bounds.left / density.toDouble(),
              "y" to it.bounds.top / density.toDouble(),
              "width" to it.bounds.width() / density.toDouble(),
              "height" to it.bounds.height() / density.toDouble(),
            )
          },
        "occlusions" to emptyList<Map<String, Double>>(),
        "posture" to posture,
      )
    if (state == last) return
    last = state
    sendEvent("onChange", state)
  }
}
