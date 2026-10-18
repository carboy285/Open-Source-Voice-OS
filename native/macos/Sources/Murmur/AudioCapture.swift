import AVFoundation

/// Records the microphone as 16 kHz mono PCM16, in memory only.
final class AudioCapture {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var samples = Data()
    private let lock = NSLock()
    private(set) var isRecording = false
    /// 0...1, updated about 20 times a second, for the listening indicator.
    var onLevel: ((Float) -> Void)?

    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

    func start() throws {
        guard !isRecording else { return }
        lock.lock(); samples = Data(); lock.unlock()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw NSError(domain: "Murmur", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone input is available."])
        }
        self.converter = converter
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.process(buffer)
        }
        engine.prepare()
        try engine.start()
        isRecording = true
    }

    /// Stops and returns the recording. The buffer is cleared.
    func stop() -> Data {
        guard isRecording else { return Data() }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false
        lock.lock()
        let data = samples
        samples = Data()
        lock.unlock()
        return data
    }

    private func process(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
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
        samples.append(pointer)
        lock.unlock()

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
