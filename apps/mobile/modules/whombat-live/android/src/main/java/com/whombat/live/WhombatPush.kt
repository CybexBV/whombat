package com.whombat.live

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Handles a Whombat data push (`PushPayload` from `@whombat/core`, sent by the server as the FCM data
 * message's `payload` key) whether or not the app is running:
 *
 * - `liveActivity` present → start / update / end the live activity from its `display`;
 * - otherwise an inbox notification (needs you, mention, agent update) that opens its screen.
 *
 * A managed Whombat's push has no `payload`: control sends the FCM data `kind`, `ref` and, when there is one, the
 * preview (`title`, `body`), the notification's `tag` and `clear` (`ManagedPush`).
 *
 * The debug build's `DebugPushReceiver` calls the same entry point, so pushes can be tested with adb
 * without Firebase.
 */
object WhombatPush {
  private const val TAG = "WhombatLive"

  /** Returns false when the message is not a Whombat push (no `payload` key, no managed `kind`/`ref`). */
  fun handle(context: Context, data: Map<String, String>): Boolean {
    val raw = data["payload"]
    if (raw == null) {
      // A managed Whombat's push (control's data-only FCM message, CL-120): kind, ref, its preview and tag.
      val push = ManagedPush.from(data) ?: return false
      if (push.clear) {
        LiveNotifications.clearGeneric(context, push.tag)
      } else {
        LiveNotifications.showGeneric(context, push)
      }
      WhombatLiveModule.emitGenericPush(context, push.kind, push.ref)
      return true
    }
    return try {
      handlePayload(context, JSONObject(raw))
      true
    } catch (e: Exception) {
      Log.w(TAG, "Ignoring a malformed push: ${e.message}")
      true
    }
  }

  fun handlePayload(context: Context, payload: JSONObject) {
    val burrow = payload.optString("burrow")
    val live = payload.optJSONObject("liveActivity")
    if (live != null) {
      val displayJson = live.optJSONObject("display") ?: return
      val display = LiveDisplay.fromJson(displayJson, burrow)
      when (live.optString("event")) {
        "end" -> LiveNotifications.end(context, display.key, display)
        else -> LiveNotifications.show(context, display)
      }
      WhombatLiveModule.emitPush(payload.toString())
      return
    }
    LiveNotifications.showInbox(
      context,
      kind = payload.optString("kind"),
      title = payload.optString("title"),
      body = payload.optString("body"),
      path = payload.optString("path"),
      burrow = burrow,
      notificationId = if (payload.isNull("notificationId")) null else payload.optString("notificationId"),
    )
    WhombatLiveModule.emitPush(payload.toString())
  }
}

/**
 * A managed Whombat's push as control sends it (CT-286, control CL-120; every value a string): `kind` (generic, a
 * `PushKind`), the opaque `ref` a tap resolves, and when present the preview `title` / `body` (plain one-line text,
 * ≤ 80 / ≤ 160 code points), the `tag` (notifications with the same tag replace each other; absent = the ref) and
 * `clear` ("1": remove the notification with that tag, show nothing).
 */
data class ManagedPush(
  val kind: String,
  val ref: String,
  val title: String?,
  val body: String?,
  val tag: String,
  val clear: Boolean,
) {
  companion object {
    /** Null when the data is not a managed push (no `kind` or `ref`). */
    fun from(data: Map<String, String>): ManagedPush? {
      val kind = data["kind"] ?: return null
      val ref = data["ref"] ?: return null
      return ManagedPush(
        kind = kind,
        ref = ref,
        title = data["title"]?.ifBlank { null },
        body = data["body"]?.ifBlank { null },
        tag = data["tag"]?.ifEmpty { null } ?: ref,
        clear = data["clear"] == "1" || data["clear"] == "true",
      )
    }
  }
}
