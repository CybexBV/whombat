package com.whombat.live

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Base64
import org.json.JSONObject

/**
 * Debug builds only: delivers a push payload the way FCM would, so push handling can be tested on an
 * emulator without Firebase credentials (`apps/mobile/scripts/push.mjs`):
 *
 *   adb shell am broadcast -n com.whombat.mobile/com.whombat.live.DebugPushReceiver \
 *     -a com.whombat.live.DEBUG_PUSH --es payload64 <base64 of the PushPayload JSON>
 *
 * A managed Whombat's push (control's FCM `data`, string values) is `--es data64 <base64 of the data as a JSON
 * object>` (`{"kind":…,"ref":…,"title":…,"body":…,"tag":…,"clear":"1"}`), or just `--es kind <kind> --es ref <ref>`.
 * Included in a release build only when it is built with EXPO_PUBLIC_WHOMBAT_PUSH_RELAY=1 (test builds, never
 * shipped).
 */
class DebugPushReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val data64 = intent.getStringExtra("data64")
    if (data64 != null) {
      val json = JSONObject(String(Base64.decode(data64, Base64.DEFAULT), Charsets.UTF_8))
      val data = json.keys().asSequence().associateWith { json.optString(it) }
      WhombatPush.handle(context.applicationContext, data)
      return
    }
    val kind = intent.getStringExtra("kind")
    val ref = intent.getStringExtra("ref")
    if (kind != null && ref != null) {
      WhombatPush.handle(context.applicationContext, mapOf("kind" to kind, "ref" to ref))
      return
    }
    val json = intent.getStringExtra("payload")
      ?: intent.getStringExtra("payload64")?.let { String(Base64.decode(it, Base64.DEFAULT), Charsets.UTF_8) }
      ?: return
    WhombatPush.handle(context.applicationContext, mapOf("payload" to json))
  }
}
