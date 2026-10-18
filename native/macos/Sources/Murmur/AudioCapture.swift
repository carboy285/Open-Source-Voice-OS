import AVFoundation

/// Records the microphone as 16 kHz mono PCM16, in memory only.
///
/// Starting AVAudioEngine from cold takes a few hundred milliseconds (longer with Bluetooth), which
/// cut off the first word. So the engine stays running for `warmSeconds` after a recording and keeps
/// a short pre-roll; samples outside a recording are held only in that small ring and then dropped.
final class AudioCapture {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var tapFormat: AVAudioFormat?
    private var samples = Data()
    private var preRoll = Data()
    private let lock = NSLock()
    private var running = false
    private var cooldown: DispatchWorkItem?
    private var configObserver: NSObjectProtocol?
    private(set) var isRecording = false
    /// 0...1, updated about 20 times a second, for the listening indicator.
    var onLevel: ((Float) -> Void)?

    /// How long the engine stays on after a recording, so the next press starts instantly.
    var warmSeconds: TimeInterval = 20
    /// Audio kept from just before the key press, while the engine is warm.
    private let preRollBytes = 16_000 * 2 * 3 / 10 // 300 ms
    /// Audio kept after the key is released, so the last word isn't clipped.
    static let tailSeconds: TimeInterval = 0.25

    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

    init() {
        // A new input device (AirPods connecting, a USB mic) stops the engine and changes the format.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in self?.handleConfigurationChange() }
    }

    deinit {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
    }

    func start() throws {
        guard !isRecording else { return }
        cooldown?.cancel()
        if !running { try startEngine() }
        lock.lock()
        samples = preRoll
        preRoll = Data()
        isRecording = true
        lock.unlock()
    }

    /// Stops recording right away and returns the audio. The engine stays warm for a while.
    func stop() -> Data {
        guard isRecording else { return Data() }
        lock.lock()
        isRecording = false
        let data = samples
        samples = Data()
        lock.unlock()
        scheduleCooldown()
        return data
    }

    /// Keeps recording for the tail, then hands back the audio on the main queue.
    func stop(afterTail completion: @escaping (Data) -> Void) {
        guard isRecording else { return completion(Data()) }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.tailSeconds) { [weak self] in
            completion(self?.stop() ?? Data())
        }
    }

    /// Stops the engine now, e.g. on quit or when the user turns the microphone off.
    func shutdown() {
        cooldown?.cancel()
        stopEngine()
    }

    private func startEngine() throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw NSError(domain: "Murmur", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone input is available."])
        }
        self.converter = converter
        tapFormat = inputFormat
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.process(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
        running = true
    }

    private func stopEngine() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
        converter = nil
        lock.lock()
        preRoll = Data()
        lock.unlock()
    }

    private func scheduleCooldown() {
        cooldown?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.isRecording else { return }
            self.stopEngine()
        }
        cooldown = item
        DispatchQueue.main.asyncAfter(deadline: .now() + warmSeconds, execute: item)
    }

    private func handleConfigurationChange() {
        let wasRecording = isRecording
        stopEngine()
        guard wasRecording else { return }
        // Keep what was recorded so far and carry on with the new device.
        do {
            try startEngine()
        } catch {
            NSLog("Murmur: microphone change during recording: %@", error.localizedDescription)
        }
    }

    private func process(_ buffer: AVAudioPCMBuffer) {
        guard let converter, buffer.format == tapFormat else { return }
        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = output.int16ChannelData else { return }
        let count = Int(output.frameLength)
        let pointer = UnsafeBufferPointer(start: channel[0], count: count)
        lock.lock()
        let recording = isRecording
        if recording {
            samples.append(pointer)
        } else {
            preRoll.append(pointer)
            if preRoll.count > preRollBytes { preRoll.removeFirst(preRoll.count - preRollBytes) }
        }
        lock.unlock()
        guard recording else { return }

        var sum: Float = 0
        for sample in pointer {
            let value = Float(sample) / Float(Int16.max)
            sum += value * value
        }
        let rms = count > 0 ? sqrt(sum / Float(count)) : 0
        let level = min(1, rms * 6)
        DispatchQueue.main.async { self.onLevel?(level) }
    }
}
