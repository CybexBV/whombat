package com.whombat.voice

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** The microphone isn't allowed, or there is none: the app says “Allow the microphone to use voice typing.” */
internal class MicrophoneException : CodedException("microphone", "The microphone isn’t allowed.", null)

/** The microphone couldn't start. */
internal class RecorderException(message: String) : CodedException("recorder", message, null)

/** One recording under way: the microphone, the thread reading it and the file it goes into. */
private class Recording(
  val record: AudioRecord,
  val file: File,
  val out: BufferedOutputStream,
  val maxSamples: Long,
) {
  @Volatile var running = true
  @Volatile var samples = 0L
  var thread: Thread? = null
}

/**
 * `WhombatVoice` (Android): the phone's microphone for voice typing (docs/decisions/dictation.md DT-07). `AudioRecord`
 * records 16 kHz mono 16-bit, the speech recogniser's source where the phone has it, straight into a WAV in the app's
 * cache, at most `maxSeconds`; `onLevel` says the loudness in decibels about twenty times a second, and `onEnd` when it
 * stopped by itself (the time is up, or the microphone went). `stop` finishes the WAV's header and answers its
 * `file://` URI; the JavaScript side reads it, sends it and deletes it. `cancel` drops it. RECORD_AUDIO is asked for
 * only when the person first presses a mic (`requestPermission`). The JavaScript side is `modules/whombat-voice/index.ts`.
 */
class WhombatVoiceModule : Module() {
  private val lock = Any()
  private var current: Recording? = null

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

    AsyncFunction("start") { maxSeconds: Int -> start(maxSeconds) }

    /** The WAV's `file://` URI. */
    AsyncFunction("stop") { -> stop() }

    AsyncFunction("cancel") { -> cancel() }

    OnDestroy { cancel() }
  }

  private fun start(maxSeconds: Int) {
    val context = appContext.reactContext ?: throw RecorderException("No app to record in.")
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      throw MicrophoneException()
    }
    cancel()
    val minBuffer = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minBuffer <= 0) throw MicrophoneException()
    // Half a second of room, so a busy moment on the phone loses nothing.
    val buffer = max(minBuffer, RATE)
    val record = open(MediaRecorder.AudioSource.VOICE_RECOGNITION, buffer)
      ?: open(MediaRecorder.AudioSource.MIC, buffer)
      ?: throw MicrophoneException()
    val dir = File(appContext.cacheDirectory, "dictation").apply { mkdirs() }
    val file = File(dir, "recording-${System.currentTimeMillis()}.wav")
    val out = BufferedOutputStream(FileOutputStream(file))
    out.write(ByteArray(HEADER))
    val recording = Recording(record, file, out, maxSeconds.toLong() * RATE)
    try {
      record.startRecording()
      if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) throw RecorderException("The microphone is busy.")
    } catch (error: Throwable) {
      record.release()
      out.close()
      file.delete()
      if (error is CodedException) throw error
      throw MicrophoneException()
    }
    synchronized(lock) { current = recording }
    recording.thread = Thread({ read(recording) }, "whombat-voice").apply { start() }
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

  /** Reads the microphone 50 ms at a time into the file until stopped, full, or the microphone fails. */
  private fun read(r: Recording) {
    val frames = ShortArray(RATE / 20)
    val bytes = ByteBuffer.allocate(frames.size * 2).order(ByteOrder.LITTLE_ENDIAN)
    var ended: String? = null
    while (r.running) {
      val n = r.record.read(frames, 0, frames.size)
      if (n < 0) {
        ended = "error"
        break
      }
      if (n == 0) continue
      val take = min(n.toLong(), r.maxSamples - r.samples).toInt()
      bytes.clear()
      var sum = 0.0
      for (i in 0 until take) {
        val s = frames[i]
        bytes.putShort(s)
        sum += (s.toDouble() / 32768.0) * (s.toDouble() / 32768.0)
      }
      try {
        r.out.write(bytes.array(), 0, take * 2)
      } catch (_: Throwable) {
        ended = "error"
        break
      }
      r.samples += take
      val rms = if (take > 0) sqrt(sum / take) else 0.0
      sendEvent("onLevel", mapOf("decibels" to if (rms > 0) 20 * log10(rms) else -160.0))
      if (r.samples >= r.maxSamples) {
        ended = "limit"
        break
      }
    }
    if (ended != null && r.running) {
      r.running = false
      try {
        r.record.stop()
      } catch (_: Throwable) {
      }
      sendEvent("onEnd", mapOf("reason" to ended))
    }
  }

  /** Stops the microphone and lets go of it; the file stays. */
  private fun halt(r: Recording) {
    r.running = false
    try {
      r.record.stop()
    } catch (_: Throwable) {
    }
    r.thread?.join(1_000)
    r.record.release()
    try {
      r.out.close()
    } catch (_: Throwable) {
    }
  }

  private fun stop(): String {
    val r = synchronized(lock) { current.also { current = null } } ?: throw RecorderException("Nothing is recording.")
    halt(r)
    writeHeader(r.file, r.samples)
    return r.file.toURI().toString()
  }

  private fun cancel() {
    val r = synchronized(lock) { current.also { current = null } } ?: return
    halt(r)
    r.file.delete()
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
  }
}
