package com.whombat.live

import android.content.Context
import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/**
 * `WhombatLive` (Android): live activities as ongoing Live Update notifications, driven by the app's
 * realtime updates (`upsert` / `end`) and by FCM data pushes (`WhombatMessagingService`). The JavaScript
 * side is `modules/whombat-live/index.ts`.
 */
class WhombatLiveModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "No React context" }.applicationContext

  override fun definition() = ModuleDefinition {
    Name("WhombatLive")

    Events("onPush", "onPushToken", "onGenericPush", "onPushTap")

    OnCreate {
      current = WeakReference(this@WhombatLiveModule)
      LiveNotifications.ensureChannels(context)
    }

    OnDestroy {
      if (current?.get() === this@WhombatLiveModule) current = null
    }

    Function("isSupported") { true }

    /** Tone colors from `@whombat/tokens`, kept for pushes that arrive while the app is closed. */
    Function("configure") { colorsJson: String ->
      LiveColors.save(context, colorsJson)
    }

    /**
     * Start or update an activity. `attributesJson` is iOS's (ActivityKit attributes); resolves with an iOS
     * push token, which Android does not have.
     */
    AsyncFunction("upsert") { displayJson: String, burrow: String, _: String? ->
      LiveNotifications.show(context, LiveDisplay.parse(displayJson, burrow))
      null as String?
    }

    AsyncFunction("end") { key: String, lastJson: String?, burrow: String ->
      LiveNotifications.end(context, key, lastJson?.let { LiveDisplay.parse(it, burrow) })
    }

    AsyncFunction("endAll") {
      LiveNotifications.endAll(context)
    }

    /** Ongoing activities on screen (to end the ones that finished while the app was closed). */
    AsyncFunction("active") {
      LiveNotifications.active(context).map { (key, burrow) -> mapOf("key" to key, "burrow" to burrow) }
    }

    /** Activities shown in the last 24 hours, on screen or not (MN-02): one that timed out isn't brought back unasked. */
    AsyncFunction("recent") {
      LiveNotifications.recent(context)
    }

    /** Inbox and managed notifications in the shade (MN-04): tag, kind, burrow, row, path or ref. */
    AsyncFunction("shade") {
      LiveNotifications.shade(context)
    }

    /** Cancels the shade's notifications with these tags (read in the app, MN-04). */
    AsyncFunction("cancel") { tags: List<String> ->
      LiveNotifications.cancel(context, tags)
    }

    /**
     * A notification FCM itself showed (a managed push while the app was in the background) opens the app with
     * the message's data as the launch intent's extras: its tap as `whombat://push?…`, once.
     */
    Function("launchPushTap") {
      val activity = appContext.currentActivity ?: return@Function null
      consumePushTap(activity.intent)
    }

    OnNewIntent { intent ->
      consumePushTap(intent)?.let { url -> runCatching { sendEvent("onPushTap", mapOf("url" to url)) } }
    }

    /** Epoch ms of the last managed push this install received (“push delivered”, apart from the session). */
    Function("lastGenericPushAt") {
      val at = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(GENERIC_AT_KEY, 0L)
      if (at > 0L) at.toDouble() else null
    }
  }

  companion object {
    private const val PREFS = "com.whombat.live"
    private const val GENERIC_AT_KEY = "genericPushAt"

    /** FCM's tray notification put `kind` and `ref` in the launch intent: turn them into the tap URL, once. */
    fun consumePushTap(intent: Intent?): String? {
      val extras = intent?.extras ?: return null
      if (!extras.containsKey("google.message_id")) return null
      val kind = extras.getString("kind") ?: return null
      val ref = extras.getString("ref") ?: return null
      extras.keySet().toList().forEach { intent.removeExtra(it) }
      return LiveNotifications.pushTapUrl(kind, ref)
    }

    /** A managed push arrived (shown natively): remember when, and tell the app if it runs. */
    fun emitGenericPush(context: Context, kind: String, ref: String) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putLong(GENERIC_AT_KEY, System.currentTimeMillis()).apply()
      val module = current?.get() ?: return
      runCatching { module.sendEvent("onGenericPush", mapOf("kind" to kind, "ref" to ref)) }
    }

    @Volatile private var current: WeakReference<WhombatLiveModule>? = null

    /** A push arrived: the app (if running) refreshes what it shows. */
    fun emitPush(payloadJson: String) {
      val module = current?.get() ?: return
      runCatching { module.sendEvent("onPush", mapOf("payload" to payloadJson)) }
    }

    /** FCM rotated the token: tell the app so it can update its device registration. */
    fun emitPushToken(token: String) {
      val module = current?.get() ?: return
      runCatching { module.sendEvent("onPushToken", mapOf("token" to token)) }
    }
  }
}
