import AVFoundation
import ExpoModulesCore

/** The microphone isn't allowed, or there is none: the app says “Allow the microphone to use voice typing.” */
internal final class MicrophoneException: Exception {
  override var code: String { "microphone" }
  override var reason: String { "The microphone isn’t allowed." }
}

/** The microphone couldn't start. */
internal final class RecorderException: GenericException<String> {
  override var code: String { "recorder" }
  override var reason: String { param }
}

/**
 * `WhombatVoice` (iOS): the phone's microphone for voice typing (docs/decisions/dictation.md DT-07). `AVAudioEngine`
 * taps the input at its own rate and `AVAudioConverter` brings it to 16 kHz mono 16-bit, written straight into a WAV
 * in the temporary folder, at most `maxSeconds`; `onLevel` says the loudness in decibels a few times a second, and
 * `onEnd` when it stopped by itself (the time is up, or a call or another app took the microphone). `stop` finishes the
 * WAV's header and answers its `file://` URL; the JavaScript side reads it, sends it and deletes it. The microphone is
 * asked for only when the person first presses a mic (`requestPermission`, `NSMicrophoneUsageDescription`).
 */
public final class WhombatVoiceModule: Module {
  private static let rate: Double = 16_000
  private static let headerBytes = 44

  /// Everything below belongs to `queue`: `start`, `stop` and `cancel` each enter it once, the microphone's buffers
  /// and an interruption arrive on it, and nothing run on it enters it again (it would wait for itself).
  private let queue = DispatchQueue(label: "com.whombat.voice")
  private var engine: AVAudioEngine?
  private var converter: AVAudioConverter?
  private var handle: FileHandle?
  private var url: URL?
  private var samples = 0
  private var maxSamples = 0
  private var running = false
  private var interruption: NSObjectProtocol?
  /// The audio session is this module's to give back (`halt`), from the moment a start made it active.
  private var sessionActive = false
  /// Which recording this is: a buffer or an interruption still on its way from an earlier one is ignored.
  private var recording = 0

  public func definition() -> ModuleDefinition {
    Name("WhombatVoice")

    Events("onLevel", "onEnd")

    Function("isSupported") { true }

    /** `{granted, canAskAgain}`: the system's question the first time, the answer after. */
    AsyncFunction("requestPermission") { (promise: Promise) in
      if #available(iOS 17.0, *) {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
          promise.resolve(["granted": true, "canAskAgain": true])
        case .denied:
          promise.resolve(["granted": false, "canAskAgain": false])
        default:
          AVAudioApplication.requestRecordPermission { granted in
            promise.resolve(["granted": granted, "canAskAgain": false])
          }
        }
      } else {
        let session = AVAudioSession.sharedInstance()
        switch session.recordPermission {
        case .granted:
          promise.resolve(["granted": true, "canAskAgain": true])
        case .denied:
          promise.resolve(["granted": false, "canAskAgain": false])
        default:
          session.requestRecordPermission { granted in
            promise.resolve(["granted": granted, "canAskAgain": false])
          }
        }
      }
    }

    AsyncFunction("start") { (maxSeconds: Int) in
      try self.queue.sync { try self.start(maxSeconds: maxSeconds) }
    }

    /** The WAV's `file://` URL. */
    AsyncFunction("stop") { () -> String in
      try self.queue.sync { try self.stop() }
    }

    AsyncFunction("cancel") {
      self.queue.sync { self.cancel() }
    }

    OnDestroy {
      self.queue.sync { self.cancel() }
    }
  }

  /** On `queue`. */
  private func start(maxSeconds: Int) throws {
    cancel()
    do {
      try begin(maxSeconds: maxSeconds)
    } catch {
      // Whatever it got as far as (the audio session, the file) is let go of: other apps' sound comes back.
      cancel()
      throw error
    }
  }

  /** On `queue`: `start` itself; where it throws, `start` cleans up. */
  private func begin(maxSeconds: Int) throws {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
      try session.setActive(true)
    } catch {
      throw MicrophoneException()
    }
    sessionActive = true
    // A new engine each time: one kept from an earlier recording may still hold the microphone's format of then.
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let from = input.outputFormat(forBus: 0)
    guard from.sampleRate > 0, from.channelCount > 0 else { throw MicrophoneException() }

    let url = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-\(UUID().uuidString).wav")
    guard FileManager.default.createFile(atPath: url.path, contents: Data(count: Self.headerBytes)) else {
      throw RecorderException("No room for the recording.")
    }
    let handle: FileHandle
    do {
      handle = try FileHandle(forWritingTo: url)
      try handle.seekToEnd()
    } catch {
      try? FileManager.default.removeItem(at: url)
      throw RecorderException("No room for the recording.")
    }

    self.recording += 1
    let recording = self.recording
    self.engine = engine
    self.converter = nil
    self.handle = handle
    self.url = url
    self.samples = 0
    self.maxSamples = maxSeconds * Int(Self.rate)
    self.running = true
    // The microphone's own format (`nil`), whatever it is by now: asking for the one read above raises an exception
    // Swift can't catch when the sound's route changed meanwhile (a headset connecting).
    input.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buffer, _ in
      self?.queue.async { self?.take(buffer, of: recording) }
    }
    interruption = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: session, queue: nil
    ) { [weak self] _ in
      self?.queue.async { self?.end("error", of: recording) }
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      throw MicrophoneException()
    }
  }

  /** On `queue`: the converter from this buffer's format, made anew when the microphone's format changed. */
  private func converterFor(_ format: AVAudioFormat) -> AVAudioConverter? {
    if let converter, converter.inputFormat == format { return converter }
    guard
      format.sampleRate > 0, format.channelCount > 0,
      let to = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Self.rate, channels: 1, interleaved: true)
    else { return nil }
    converter = AVAudioConverter(from: format, to: to)
    return converter
  }

  /** On `queue`: one tap's buffer converted and written, its loudness sent. */
  private func take(_ buffer: AVAudioPCMBuffer, of recording: Int) {
    guard running, recording == self.recording, let handle else { return }
    guard let converter = converterFor(buffer.format) else { return end("error", of: recording) }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * Self.rate / buffer.format.sampleRate) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else { return }
    var given = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if given {
        status.pointee = .noDataNow
        return nil
      }
      given = true
      status.pointee = .haveData
      return buffer
    }
    if error != nil { return end("error", of: recording) }
    let take = min(Int(out.frameLength), maxSamples - samples)
    if take > 0, let data = out.int16ChannelData {
      do {
        // The throwing write: the older `write(_:)` raises an exception Swift can't catch when the disk is full.
        try handle.write(contentsOf: Data(bytes: data[0], count: take * 2))
      } catch {
        return end("error", of: recording)
      }
      samples += take
    }
    sendEvent("onLevel", ["decibels": decibels(buffer)])
    if samples >= maxSamples { end("limit", of: recording) }
  }

  /** On `queue`: it stopped by itself; the WAV stays for `stop`. */
  private func end(_ reason: String, of recording: Int) {
    guard running, recording == self.recording else { return }
    running = false
    halt()
    sendEvent("onEnd", ["reason": reason])
  }

  /** The buffer's loudness (its RMS) in decibels, 0 at full scale. */
  private func decibels(_ buffer: AVAudioPCMBuffer) -> Double {
    guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return -160 }
    var sum: Float = 0
    for i in 0..<Int(buffer.frameLength) { sum += channel[i] * channel[i] }
    let rms = sqrt(sum / Float(buffer.frameLength))
    return rms > 0 ? Double(20 * log10(rms)) : -160
  }

  /** On `queue`: lets go of the microphone and the audio session. Nothing to do when it already did. */
  private func halt() {
    if let interruption { NotificationCenter.default.removeObserver(interruption) }
    interruption = nil
    if let engine {
      self.engine = nil
      engine.inputNode.removeTap(onBus: 0)
      if engine.isRunning { engine.stop() }
    }
    // Also when a start got no further than the session: it is active from before there is an engine.
    guard sessionActive else { return }
    sessionActive = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  /** On `queue`. */
  private func stop() throws -> String {
    halt()
    running = false
    guard let url, let handle else { throw RecorderException("Nothing is recording.") }
    try? handle.close()
    self.handle = nil
    self.url = nil
    self.converter = nil
    do {
      try writeHeader(url, samples: samples)
    } catch {
      try? FileManager.default.removeItem(at: url)
      throw RecorderException("No room for the recording.")
    }
    return url.absoluteString
  }

  /** On `queue`. */
  private func cancel() {
    halt()
    running = false
    try? handle?.close()
    handle = nil
    converter = nil
    if let url { try? FileManager.default.removeItem(at: url) }
    url = nil
  }

  /** The 44-byte RIFF header of a 16 kHz mono 16-bit WAV of `samples` samples. */
  private func writeHeader(_ url: URL, samples: Int) throws {
    var header = Data()
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { header.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { header.append(contentsOf: $0) } }
    let data = UInt32(samples * 2)
    header.append(contentsOf: Array("RIFF".utf8))
    u32(36 + data)
    header.append(contentsOf: Array("WAVE".utf8))
    header.append(contentsOf: Array("fmt ".utf8))
    u32(16)
    u16(1)
    u16(1)
    u32(UInt32(Self.rate))
    u32(UInt32(Self.rate) * 2)
    u16(2)
    u16(16)
    header.append(contentsOf: Array("data".utf8))
    u32(data)
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.seek(toOffset: 0)
    try handle.write(contentsOf: header)
  }
}
