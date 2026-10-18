import AppKit

/// One soft cue, synthesized at launch: a short rising tone for start, falling for stop.
enum Cue {
    private static let start = NSSound(data: tone(from: 660, to: 880))
    private static let stop = NSSound(data: tone(from: 880, to: 660))

    static func play(start isStart: Bool, enabled: Bool) {
        guard enabled else { return }
        let sound = isStart ? start : stop
        sound?.stop()
        sound?.volume = 0.25
        sound?.play()
    }

    /// 90 ms sine sweep with a smooth envelope, as an in-memory WAV.
    private static func tone(from f0: Double, to f1: Double, rate: Double = 44_100, duration: Double = 0.09) -> Data {
        let count = Int(rate * duration)
        var pcm = Data(capacity: count * 2)
        var phase = 0.0
        for i in 0..<count {
            let t = Double(i) / Double(count)
            let frequency = f0 + (f1 - f0) * t
            phase += 2 * Double.pi * frequency / rate
            let envelope = sin(Double.pi * t)
            let sample = Int16(max(-1, min(1, sin(phase) * envelope * 0.6)) * Double(Int16.max))
            withUnsafeBytes(of: sample.littleEndian) { pcm.append(contentsOf: $0) }
        }
        var header = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { header.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { header.append(contentsOf: $0) } }
        header.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + pcm.count))
        header.append(contentsOf: Array("WAVEfmt ".utf8)); u32(16); u16(1); u16(1)
        u32(UInt32(rate)); u32(UInt32(rate) * 2); u16(2); u16(16)
        header.append(contentsOf: Array("data".utf8)); u32(UInt32(pcm.count))
        return header + pcm
    }
}
