package com.whombat.live

import org.json.JSONObject

/**
 * What a live activity shows: `LiveActivityDisplay` from `@whombat/core` (built by the server for data
 * pushes and by the app for realtime updates). This side only renders it; it builds no copy of its own.
 */
data class LiveDisplay(
  val key: String,
  val kind: String,
  val number: Int,
  val label: String,
  val tone: String,
  val title: String,
  val text: String,
  val progress: Int,
  val segments: Int,
  val chip: String?,
  val ongoing: Boolean,
  val actions: List<String>,
  /** Burrow slug the run or approval belongs to. */
  val burrow: String,
) {
  /** The app screen for this activity (`whombat://runs/1907`, `whombat://approvals/12`). */
  val url: String
    get() = if (kind == "run") "$SCHEME://runs/$number" else "$SCHEME://approvals/$number"

  fun ended(): LiveDisplay = copy(ongoing = false, chip = null)

  companion object {
    const val SCHEME = "whombat"

    fun parse(json: String, burrow: String): LiveDisplay = fromJson(JSONObject(json), burrow)

    fun fromJson(json: JSONObject, burrow: String): LiveDisplay {
      val actions = json.optJSONArray("actions")
      return LiveDisplay(
        key = json.getString("key"),
        kind = json.optString("kind", "run"),
        number = json.getInt("number"),
        label = json.optString("label"),
        tone = json.optString("tone", "neutral"),
        title = json.optString("title"),
        text = json.optString("text"),
        progress = json.optInt("progress", 0).coerceIn(0, 100),
        segments = json.optInt("segments", 1).coerceIn(1, 12),
        chip = if (json.isNull("chip")) null else json.optString("chip").ifEmpty { null },
        ongoing = json.optBoolean("ongoing", true),
        actions = if (actions == null) emptyList() else List(actions.length()) { actions.getString(it) },
        burrow = burrow,
      )
    }
  }
}
