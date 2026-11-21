package com.whombat.voice

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** The microphone isn't allowed, or there is none: the app says “Allow the microphone to use voice typing.” */
internal class MicrophoneException : CodedException("microphone", "The microphone isn’t allowed.", null)

/** The microphone couldn't start. */
internal class RecorderException(message: String) : CodedException("recorder", message, null)

/**
 * One recording under way: the microphone, the thread reading it and the file it goes into. The reader thread owns the
 * microphone and the file: it alone releases and closes them, when it leaves its loop, so nothing is let go while it
 * is still inside `read()`. `id` is the JavaScript side's number for it, on every event it sends, so an event of an
 * earlier recording can't act on a later one.
 */
private class Recording(
  val id: Int,
  val record: AudioRecord,
  val file: File,
  val out: BufferedOutputStream,
  val maxSamples: Long,
) {
  @Volatile var running = true
  @Volatile var samples = 0L
  /**
   * Set by the reader under the recording's own lock as it starts letting go, so nobody stops a microphone it is
   * releasing; the letting go itself happens outside the lock, so a slow release or flush never holds up a stop.
   */
  var releasing = false
  /** Set by the reader under the recording's own lock once it let go of the microphone and the file. */
  var released = false
  /** Set when nobody waits for the file any more: the reader deletes it when it finally lets go. */
  var discard = false
  /** Counted down when the reader has let go of everything. */
  val done = CountDownLatch(1)
}

/**
 * `WhombatVoice` (Android): the phone's microphone for voice typing (docs/decisions/dictation.md DT-07). `AudioRecord`
 * records 16 kHz mono 16-bit, the speech recogniser's source where the phone has it, straight into a WAV in the app's
 * cache, at most `maxSeconds`; `onLevel` says the loudness in decibels about twenty times a second, and `onEnd` when it
 * stopped by itself (the time is up, or the microphone went), each with the recording's `id`. `stop` finishes the WAV's
 * header and answers its `file://` URI; the JavaScript side reads it, sends it and deletes it. `cancel` drops it.
 * RECORD_AUDIO is asked for only when the person first presses a mic (`requestPermission`). The JavaScript side is
 * `modules/whombat-voice/index.ts`.
 */
class WhombatVoiceModule : Module() {
  /** Start, stop and cancel run one at a time, so two quick starts can't both open the microphone. */
  private val session = Any()
  /** Guards `current`, briefly; the reader takes it too, so nothing slow happens under it. */
  private val lock = Any()
  private var current: Recording? = null
  /**
   * A recording whose reader didn't let go in time (under `session`): until it has, no new recording starts, as a
   * second `AudioRecord` beside an unreleased one fails or takes the microphone from it.
   */
  private var lingering: Recording? = null

  private val permissions: Permissions
    get() = appContext.permissions ?: throw RecorderException("No permissions here.")

  override fun definition() = ModuleDefinition {
    Name("WhombatVoice")

    Events("onLevel", "onEnd")

    Function("isSupported") { true }

    /** `{granted, canAskAgain, status}`: Android's own question the first time, the answer after. */
    AsyncFunction("requestPermission") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(permissions, promise, Manifest.permission.RECORD_AUDIO)
    }

    AsyncFunction("start") { maxSeconds: Int, id: Int -> start(maxSeconds, id) }

    /** The WAV's `file://` URI. */
    AsyncFunction("stop") { -> stop() }

    AsyncFunction("cancel") { -> cancel() }

    // The app is closing: nothing may wait here, so the microphone is let go on a thread of its own.
    OnDestroy { Thread({ runCatching { cancel() } }, "whombat-voice-end").start() }
  }

  private fun start(maxSeconds: Int, id: Int): Unit = synchronized(session) {
    val context = appContext.reactContext ?: throw RecorderException("No app to record in.")
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      throw MicrophoneException()
    }
    if (!cancel() || !settled()) throw RecorderException("The microphone didn’t stop.")
    // The file first: nothing holds the microphone yet if it can't be made.
    val file = try {
      val dir = File(appContext.cacheDirectory, "dictation").apply { mkdirs() }
      File.createTempFile("recording-", ".wav", dir)
    } catch (_: Throwable) {
      throw RecorderException("The recording couldn’t be stored.")
    }
    val minBuffer = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    // Half a second of room, so a busy moment on the phone loses nothing.
    val record = if (minBuffer <= 0) null else {
      val buffer = max(minBuffer, RATE)
      open(MediaRecorder.AudioSource.VOICE_RECOGNITION, buffer) ?: open(MediaRecorder.AudioSource.MIC, buffer)
    }
    if (record == null) {
      file.delete()
      throw MicrophoneException()
    }
    var out: BufferedOutputStream? = null
    val recording = try {
      val stream = BufferedOutputStream(FileOutputStream(file))
      out = stream
      stream.write(ByteArray(HEADER))
      record.startRecording()
      if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) throw RecorderException("The microphone is busy.")
      Recording(id, record, file, stream, maxSeconds.toLong() * RATE)
    } catch (error: Throwable) {
      runCatching { record.stop() }
      runCatching { record.release() }
      runCatching { out?.close() }
      file.delete()
      if (error is CodedException) throw error
      // A full or broken cache isn't the microphone's fault: the app shouldn't ask to allow it.
      if (error is IOException) throw RecorderException("The recording couldn’t be stored.")
      throw MicrophoneException()
    }
    // A stop right after start waits on `done`, which only the reader counts down, so the reader must start: nothing
    // between publishing the recording and starting its thread can fail.
    val thread = Thread({ read(recording) }, "whombat-voice")
    synchronized(lock) { current = recording }
    thread.start()
  }

  private fun open(source: Int, buffer: Int): AudioRecord? = try {
    val record = AudioRecord(source, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, buffer)
    if (record.state == AudioRecord.STATE_INITIALIZED) record else {
      record.release()
      null
    }
  } catch (_: Throwable) {
    null
  }

  /** From the reader thread: the JavaScript runtime may be going away, and that mustn't end the thread early. */
  private fun send(name: String, body: Map<String, Any?>) {
    runCatching { sendEvent(name, body) }
  }

  /**
   * Reads the microphone 50 ms at a time into the file until stopped, full, or the microphone fails, then lets go of
   * the microphone and the file, whatever happened.
   */
  private fun read(r: Recording) {
    var ended: String? = null
    try {
      ended = readLoop(r)
    } catch (_: Throwable) {
      ended = "error"
    } finally {
      try {
        synchronized(r) { r.releasing = true }
        runCatching { r.record.stop() }
        runCatching { r.record.release() }
        runCatching { r.out.close() }
        synchronized(r) {
          r.released = true
          if (r.discard) runCatching { r.file.delete() }
        }
      } finally {
        r.done.countDown()
      }
    }
    // Only the recording still current says it ended; the JavaScript side also drops events of any other `id`.
    val tell = ended != null && synchronized(lock) {
      (current === r && r.running).also { if (it) r.running = false }
    }
    if (tell) send("onEnd", mapOf("id" to r.id, "reason" to ended))
  }

  /** The reading itself; why it ended by itself (`limit`, `error`), or null when it was stopped. */
  private fun readLoop(r: Recording): String? {
    val frames = ShortArray(RATE / 20)
    val bytes = ByteBuffer.allocate(frames.size * 2).order(ByteOrder.LITTLE_ENDIAN)
    // A microphone that gives nothing (an audio route change gone wrong) would otherwise spin a core.
    var silentSince = 0L
    while (r.running) {
      val n = r.record.read(frames, 0, frames.size)
      if (n < 0) return "error"
      if (n == 0) {
        val now = SystemClock.elapsedRealtime()
        if (silentSince == 0L) silentSince = now
        if (now - silentSince > EMPTY_READS_MS) return "error"
        Thread.sleep(10)
        continue
      }
      silentSince = 0L
      val take = min(n.toLong(), r.maxSamples - r.samples).toInt()
      bytes.clear()
      var sum = 0.0
      for (i in 0 until take) {
        val s = frames[i]
        bytes.putShort(s)
        sum += (s.toDouble() / 32768.0) * (s.toDouble() / 32768.0)
      }
      r.out.write(bytes.array(), 0, take * 2)
      r.samples += take
      val rms = if (take > 0) sqrt(sum / take) else 0.0
      send("onLevel", mapOf("id" to r.id, "decibels" to if (rms > 0) 20 * log10(rms) else -160.0))
      if (r.samples >= r.maxSamples) return "limit"
    }
    return null
  }

  /**
   * Stops the microphone and waits for the reader to let go of it and of the file. False when the reader is still stuck
   * after the wait: it lets go by itself later and deletes the file, which nobody can use any more.
   */
  private fun halt(r: Recording): Boolean {
    r.running = false
    synchronized(r) {
      // Stopping the microphone wakes a reader waiting inside read().
      if (!r.releasing) runCatching { r.record.stop() }
    }
    if (r.done.await(HALT_WAIT_MS, TimeUnit.MILLISECONDS)) return true
    synchronized(r) {
      if (r.released) return true
      r.discard = true
    }
    lingering = r
    return false
  }

  /** False while an earlier recording still holds the microphone after the wait. */
  private fun settled(): Boolean {
    val l = lingering ?: return true
    if (!l.done.await(HALT_WAIT_MS, TimeUnit.MILLISECONDS)) return false
    lingering = null
    return true
  }

  private fun stop(): String = synchronized(session) {
    val r = synchronized(lock) { current.also { current = null } } ?: throw RecorderException("Nothing is recording.")
    if (!halt(r)) throw RecorderException("The microphone didn’t stop.")
    try {
      writeHeader(r.file, r.samples)
    } catch (_: Throwable) {
      r.file.delete()
      throw RecorderException("The recording couldn’t be stored.")
    }
    r.file.toURI().toString()
  }

  /** Drops the recording under way; false at once when its microphone didn't let go in time. */
  private fun cancel(): Boolean = synchronized(session) {
    val r = synchronized(lock) { current.also { current = null } } ?: return true
    if (!halt(r)) return false
    r.file.delete()
    true
  }

  /** The 44-byte RIFF header of a 16 kHz mono 16-bit WAV of `samples` samples. */
  private fun writeHeader(file: File, samples: Long) {
    val data = (samples * 2).toInt()
    val header = ByteBuffer.allocate(HEADER).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray())
      putInt(36 + data)
      put("WAVE".toByteArray())
      put("fmt ".toByteArray())
      putInt(16)
      putShort(1)
      putShort(1)
      putInt(RATE)
      putInt(RATE * 2)
      putShort(2)
      putShort(16)
      put("data".toByteArray())
      putInt(data)
    }
    RandomAccessFile(file, "rw").use { it.write(header.array()) }
  }

  companion object {
    private const val RATE = 16_000
    private const val HEADER = 44
    /** How long the microphone may give nothing before the recording ends as an error. */
    private const val EMPTY_READS_MS = 1_000L
    private const val HALT_WAIT_MS = 2_000L
  }
}
