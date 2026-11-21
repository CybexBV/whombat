package com.whombat.live

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener
import java.lang.ref.WeakReference

class WhombatLivePackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context): List<ReactActivityLifecycleListener> =
    listOf(LatestIntentListener())
}

/**
 * A notification (or its Approve / Details / Open run action) opens the app on a deep link. When the app's
 * task still exists but its process was killed, Android recreates the activity with the task's old intent
 * and hands the new one to `onNewIntent` before React Native is running, so the link would be lost. Making
 * the new intent the activity's intent means `Linking.getInitialURL()` returns it once JavaScript starts;
 * a running app still gets the `url` event as before.
 *
 * Opened again from Recents after its process was killed, the activity gets the intent that once started the
 * task: a notification's link (or a tray push's data) from long ago would open that screen again instead of where
 * the person was (MN-01). Such an intent loses its link and push data, so the app restores its last place.
 */
private class LatestIntentListener : ReactActivityLifecycleListener {
  private var activity: WeakReference<Activity>? = null

  override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
    this.activity = WeakReference(activity)
    val intent = activity.intent ?: return
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0) return
    if (intent.data == null && intent.extras?.containsKey("google.message_id") != true) return
    activity.intent = Intent(intent).apply {
      data = null
      if (extras?.containsKey("google.message_id") == true) replaceExtras(Bundle())
    }
  }

  override fun onNewIntent(intent: Intent): Boolean {
    if (intent.data != null) activity?.get()?.intent = intent
    return false
  }
}
