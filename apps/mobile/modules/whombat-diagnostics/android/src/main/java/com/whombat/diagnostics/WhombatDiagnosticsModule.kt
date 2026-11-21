package com.whombat.diagnostics

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.content.pm.PackageInfo
import android.os.Build
import android.util.Base64
import androidx.annotation.RequiresApi
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID

/**
 * `WhombatDiagnostics` (Android): what Android itself knows about how the app's earlier runs ended
 * (docs/app/decisions/phone-resilience.md). Android 11+ keeps the reasons a process ended, with the time, the memory it
 * used and, for an app that stopped answering or crashed in native code, the threads' stacks; a crash in native code,
 * a frozen app Android closed and an ending for memory are described nowhere else. On each start the module hands the
 * JavaScript side (`modules/whombat-diagnostics/index.ts`, `src/errors/androidExits.ts`) the endings newer than the
 * last one it took, in the same `pending` / `remove` shape as iOS's payloads. Which of them become notes is decided
 * there; Android 10 and older have nothing to read.
 */
class WhombatDiagnosticsModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "No React context" }.applicationContext

  override fun definition() = ModuleDefinition {
    Name("WhombatDiagnostics")

    // iOS's; nothing arrives here while the app runs, an ending is read at the next start.
    Events("onPayload")

    OnCreate { runCatching { ExitReasons.labelThisRun(context) } }

    /** `[{id, json}]`: the endings not taken yet, oldest first. */
    Function("pending") { runCatching { ExitReasons.pending(context) }.getOrDefault(emptyList()) }

    /** This run's own id, which Android keeps with its ending: a JavaScript error noted in it is that ending's cause. */
    Function("runId") { ExitReasons.run }

    Function("remove") { ids: List<String> ->
      runCatching { ExitReasons.taken(context, ids) }
      Unit
    }
  }
}

internal object ExitReasons {
  private const val PREFS = "com.whombat.diagnostics"
  /** Epoch ms of the newest ending already taken: Android lists the same ones again at every start. */
  private const val TAKEN_UNTIL = "takenUntil"
  /** Android keeps a few dozen endings per app; the newest of these are plenty. */
  private const val MOST = 16
  /** The start of a frozen app's thread dump: its main thread comes first. */
  private const val ANR_TRACE_BYTES = 128 * 1024
  /** A native crash's report (Android's tombstone, a protocol buffer); the crashed thread is near its start. */
  private const val TOMBSTONE_BYTES = 1024 * 1024
  /** How many of the newest endings have their trace read. */
  private const val TRACED = 3
  /** An ending older than this isn't noted any more. */
  private const val MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000L

  /** A random id of this run (this process), kept with its ending. */
  val run: String by lazy { UUID.randomUUID().toString().replace("-", "").take(12) }

  /**
   * The build this run is and its id, kept by Android with the run's ending (the process state summary, 128 bytes at
   * most, `3.141.0 (3141000) run=<id>`): an ending is read by the next start, which may be a newer build after an update.
   */
  fun labelThisRun(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) label(context)
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun label(context: Context) {
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    val bytes = "${info.versionName ?: "?"} (${codeOf(info)}) run=$run".toByteArray(Charsets.UTF_8)
    context.getSystemService(ActivityManager::class.java)?.setProcessStateSummary(bytes.copyOf(minOf(bytes.size, 128)))
  }

  fun pending(context: Context): List<Map<String, String>> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) newer(context) else emptyList()

  /**
   * The endings to hand over, oldest first. One older than a week, or an ending for memory while the app wasn't on
   * screen (Android does that to any app it needs the room of), is never worth a note: it is passed over without
   * reading its trace, and taken when it is older than every ending handed over. Only the newest few have their trace
   * read, which is the costly part.
   */
  @RequiresApi(Build.VERSION_CODES.R)
  private fun newer(context: Context): List<Map<String, String>> {
    val manager = context.getSystemService(ActivityManager::class.java) ?: return emptyList()
    val since = prefs(context).getLong(TAKEN_UNTIL, 0L)
    val oldest = System.currentTimeMillis() - MAX_AGE_MS
    // Only the app's own process: the package's other processes (WebView's sandboxed renderer of a preview among them)
    // are filed under it too, and their endings aren't the app's.
    val own = context.applicationInfo.processName ?: context.packageName
    val (wanted, passed) = manager.getHistoricalProcessExitReasons(context.packageName, 0, MOST)
      .filter { it.processName == own && it.timestamp > since && kept(it.reason) }
      .sortedBy { it.timestamp }
      .partition { it.timestamp >= oldest && (it.reason != ApplicationExitInfo.REASON_LOW_MEMORY || onScreen(it)) }
    val firstWanted = wanted.firstOrNull()?.timestamp ?: Long.MAX_VALUE
    passed.filter { it.timestamp < firstWanted }.maxOfOrNull { it.timestamp }?.let { take(context, it) }
    // The newest few of the endings that have a trace at all (an ANR, a native crash).
    val traced = wanted.filter { hasTrace(it.reason) }.takeLast(TRACED).toSet()
    return wanted.map { exit ->
      mapOf("id" to "exit-${exit.timestamp}-${exit.pid}", "json" to describe(exit, withTrace = exit in traced).toString())
    }
  }

  private fun hasTrace(reason: Int) =
    reason == ApplicationExitInfo.REASON_ANR || reason == ApplicationExitInfo.REASON_CRASH_NATIVE

  @RequiresApi(Build.VERSION_CODES.R)
  private fun onScreen(exit: ApplicationExitInfo) =
    exit.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE

  /** These are noted (or not worth a note): the ones up to the newest of them are never handed over again. */
  fun taken(context: Context, ids: List<String>) {
    val newest = ids.mapNotNull { Regex("""^exit-(\d+)-\d+$""").find(it)?.groupValues?.get(1)?.toLongOrNull() }
      .maxOrNull() ?: return
    take(context, newest)
  }

  private fun take(context: Context, until: Long) {
    val p = prefs(context)
    if (until > p.getLong(TAKEN_UNTIL, 0L)) p.edit().putLong(TAKEN_UNTIL, until).apply()
  }

  /**
   * A crash (in Java or Kotlin, which is also how a fatal JavaScript error ends the app, or in native code), a frozen
   * app Android closed, and an ending for memory. Not the person's swipe or force stop, an update (the app's own
   * updater ends it at each one), the app's own exit, or the rest.
   */
  private fun kept(reason: Int): Boolean =
    reason == ApplicationExitInfo.REASON_CRASH ||
      reason == ApplicationExitInfo.REASON_CRASH_NATIVE ||
      reason == ApplicationExitInfo.REASON_ANR ||
      reason == ApplicationExitInfo.REASON_LOW_MEMORY

  @RequiresApi(Build.VERSION_CODES.R)
  private fun describe(exit: ApplicationExitInfo, withTrace: Boolean): JSONObject =
    JSONObject().apply {
      put("platform", "android")
      put(
        "reason",
        when (exit.reason) {
          ApplicationExitInfo.REASON_CRASH -> "crash"
          ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash_native"
          ApplicationExitInfo.REASON_ANR -> "anr"
          else -> "low_memory"
        },
      )
      put("timestamp", exit.timestamp)
      put("importance", exit.importance)
      put("status", exit.status)
      put("pss", exit.pss)
      put("rss", exit.rss)
      // Free text: only an ANR's, from which the JavaScript side reads which kind it was and keeps nothing else.
      if (exit.reason == ApplicationExitInfo.REASON_ANR) exit.description?.let { put("description", it.take(120)) }
      exit.processStateSummary?.let { put("build", String(it, Charsets.UTF_8).take(64)) }
      if (withTrace) when (exit.reason) {
        ApplicationExitInfo.REASON_ANR ->
          read(exit, ANR_TRACE_BYTES)?.let { put("trace", String(it, Charsets.UTF_8)) }
        ApplicationExitInfo.REASON_CRASH_NATIVE ->
          read(exit, TOMBSTONE_BYTES)?.let { put("tombstone", Base64.encodeToString(it, Base64.NO_WRAP)) }
      }
    }

  /** The first `max` bytes of the ending's trace, or null when Android kept none. */
  @RequiresApi(Build.VERSION_CODES.R)
  private fun read(exit: ApplicationExitInfo, max: Int): ByteArray? =
    runCatching {
      exit.traceInputStream?.use { stream ->
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (out.size() < max) {
          val n = stream.read(buffer, 0, minOf(buffer.size, max - out.size()))
          if (n < 0) break
          out.write(buffer, 0, n)
        }
        out.toByteArray()
      }
    }.getOrNull()

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  @Suppress("DEPRECATION")
  private fun codeOf(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
}
