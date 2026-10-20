import AVFoundation
import NaturalLanguage

/// Makes a reply fit for speech: no markdown marks, and a link is "a link", not letters read out one by one.
enum SpeechText {
    static func clean(_ text: String, limit: Int = 1200) -> String {
        var s = text
        s = s.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"https?://\S+"#, with: "a link", options: .regularExpression)
        s = s.replacingOccurrences(of: #"[`*#>]+"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"(?m)^\s*[-•]\s+"#, with: "", options: .regularExpression)
        let endings: Set<Character> = [".", "!", "?", ":", ";", "…", "。", "！", "？"]
        let lines = s.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .map { line -> String in
                guard let last = line.last, !endings.contains(last) else { return line }
                let wide = last.unicodeScalars.first.map { $0.value >= 0x3000 } ?? false
                return line + (wide ? "。" : ".")
            }
        let joined = lines.joined(separator: " ")
        return joined.count > limit ? String(joined.prefix(limit)) : joined
    }
}

/// Reads replies aloud with the Mac's own voices. Nothing leaves the Mac.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    /// Plays audio that a hosted voice service made.
    private var player: AVAudioPlayer?
    /// Goes up every time speech stops or starts, so an answer from a hosted voice that arrives late can tell it is stale.
    private(set) var generation = 0
    /// Called on the main queue when speech starts or ends.
    var onChange: ((Bool) -> Void)?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    var isSpeaking: Bool { synthesizer.isSpeaking || player?.isPlaying == true }

    /// `rate` is 0 to 1; 0.5 is the system's normal speed.
    func speak(_ reply: String, voiceId: String, rate: Double) {
        let text = SpeechText.clean(reply)
        guard !text.isEmpty else { return }
        stop()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Speaker.voice(id: voiceId, for: text)
        let clamped = min(0.8, max(0.2, rate))
        utterance.rate = AVSpeechUtteranceMinimumSpeechRate + (AVSpeechUtteranceMaximumSpeechRate - AVSpeechUtteranceMinimumSpeechRate) * Float(clamped)
        synthesizer.speak(utterance)
    }

    func stop() {
        generation += 1
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        if let player {
            let wasPlaying = player.isPlaying
            player.stop()
            self.player = nil
            if wasPlaying { DispatchQueue.main.async { self.onChange?(false) } }
        }
    }

    /// Plays audio from a hosted voice. Returns false when the data can't be played.
    func play(_ data: Data) -> Bool {
        guard let next = try? AVAudioPlayer(data: data) else { return false }
        next.delegate = self
        guard next.play() else { return false }
        player = next
        DispatchQueue.main.async { self.onChange?(true) }
        return true
    }

    func audioPlayerDidFinishPlaying(_ finished: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async {
            if self.player === finished { self.player = nil }
            self.onChange?(false)
        }
    }

    /// The chosen voice, or the best installed voice for the language of the reply.
    static func voice(id: String, for text: String) -> AVSpeechSynthesisVoice? {
        if !id.isEmpty, let chosen = AVSpeechSynthesisVoice(identifier: id) { return chosen }
        guard let language = NLLanguageRecognizer.dominantLanguage(for: text)?.rawValue else { return nil }
        let matching = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(language) }
        return matching.max { $0.quality.rawValue < $1.quality.rawValue }
            ?? AVSpeechSynthesisVoice(language: language)
    }

    struct VoiceChoice: Identifiable {
        let id: String
        let label: String
    }

    /// Installed voices for the Settings picker, the user's language first.
    static func choices() -> [VoiceChoice] {
        let own = Locale.current.language.languageCode?.identifier ?? "en"
        return AVSpeechSynthesisVoice.speechVoices()
            .sorted {
                let a = $0.language.hasPrefix(own), b = $1.language.hasPrefix(own)
                if a != b { return a }
                return $0.name < $1.name
            }
            .map { VoiceChoice(id: $0.identifier, label: "\($0.name) (\($0.language))") }
    }

    // MARK: AVSpeechSynthesizerDelegate

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.onChange?(true) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.onChange?(false) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async { self.onChange?(false) }
    }
}
