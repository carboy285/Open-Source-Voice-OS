import AppKit
import CryptoKit
import Foundation

/// Checks GitHub Releases for a newer Murmur, downloads the macOS disk image, verifies its SHA-256
/// against the release's SHA256SUMS.txt, swaps the app in place and relaunches.
final class Updater: ObservableObject {
    enum Phase: Equatable {
        case idle
        case checking
        case upToDate
        case available(String)
        case downloading(String)
        case installing(String)
        case failed(String)
    }

    struct Release {
        let version: String
        let dmg: URL
        let sums: URL?
    }

    static let repository = "carboy285/Open-Source-Voice-OS"
    static let checkInterval: TimeInterval = 6 * 60 * 60

    @Published private(set) var phase: Phase = .idle
    private(set) var latest: Release?
    private var timer: Timer?
    private var notifiedVersion: String?
    var onFound: ((String) -> Void)?

    var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    var automatic: Bool {
        UserDefaults.standard.object(forKey: "autoUpdate") as? Bool ?? true
    }

    /// First check shortly after launch, then every few hours while automatic checks are on.
    func startAutomaticChecks() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: Self.checkInterval, repeats: true) { [weak self] _ in
            guard let self, self.automatic else { return }
            self.check(userInitiated: false)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.automatic else { return }
            self.check(userInitiated: false)
        }
    }

    func check(userInitiated: Bool) {
        switch phase {
        case .checking, .downloading, .installing: return
        default: break
        }
        phase = .checking
        var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(Self.repository)/releases/latest")!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Murmur/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 30
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async { self?.handleCheck(data: data, response: response, error: error, userInitiated: userInitiated) }
        }.resume()
    }

    private func handleCheck(data: Data?, response: URLResponse?, error: Error?, userInitiated: Bool) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard error == nil, let data, status == 200 else {
            // 404 means no release has been published yet: that is "up to date", not an error.
            if status == 404 {
                phase = .upToDate
            } else {
                phase = userInitiated ? .failed(error?.localizedDescription ?? "HTTP \(status)") : .idle
            }
            return
        }
        guard let release = Self.parse(data) else {
            phase = userInitiated ? .failed(L("update.no_asset")) : .idle
            return
        }
        latest = release
        if Self.isNewer(release.version, than: currentVersion) {
            phase = .available(release.version)
            if notifiedVersion != release.version {
                notifiedVersion = release.version
                onFound?(release.version)
            }
        } else {
            phase = .upToDate
        }
    }

    static func parse(_ data: Data) -> Release? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = json["tag_name"] as? String,
              (json["draft"] as? Bool) != true, (json["prerelease"] as? Bool) != true,
              let assets = json["assets"] as? [[String: Any]] else { return nil }
        func url(where match: (String) -> Bool) -> URL? {
            for asset in assets {
                if let name = asset["name"] as? String, match(name),
                   let link = asset["browser_download_url"] as? String, let url = URL(string: link), url.scheme == "https" {
                    return url
                }
            }
            return nil
        }
        guard let dmg = url(where: { $0.hasSuffix("-macos-universal.dmg") }) else { return nil }
        let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        return Release(version: version, dmg: dmg, sums: url(where: { $0 == "SHA256SUMS.txt" }))
    }

    /// Compares dotted numeric versions; anything after "-" or "+" is ignored.
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        func parts(_ v: String) -> [Int] {
            let core = v.split(whereSeparator: { $0 == "-" || $0 == "+" }).first.map(String.init) ?? v
            return core.split(separator: ".").map { Int($0) ?? 0 }
        }
        let a = parts(candidate), b = parts(current)
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    // MARK: Install

    func install() {
        guard let release = latest, Self.isNewer(release.version, than: currentVersion) else { return }
        phase = .downloading(release.version)
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                let staged = try await Self.prepare(release)
                await MainActor.run { self?.phase = .installing(release.version) }
                try Self.swapAndRelaunch(staged: staged)
            } catch UpdateError.needsManualInstall(let dmg) {
                await MainActor.run {
                    self?.phase = .failed(L("update.manual"))
                    NSWorkspace.shared.open(dmg)
                }
            } catch {
                await MainActor.run { self?.phase = .failed(error.localizedDescription) }
            }
        }
    }

    enum UpdateError: LocalizedError {
        case checksumMissing, checksumMismatch, badBundle(String), needsManualInstall(URL), tool(String)

        var errorDescription: String? {
            switch self {
            case .checksumMissing: return L("update.err.no_checksum")
            case .checksumMismatch: return L("update.err.checksum")
            case let .badBundle(why): return L("update.err.bundle", ["why": why])
            case .needsManualInstall: return L("update.manual")
            case let .tool(message): return message
            }
        }
    }

    private static func prepare(_ release: Release) async throws -> URL {
        let work = FileManager.default.temporaryDirectory.appendingPathComponent("murmur-update-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)

        let (downloaded, _) = try await URLSession.shared.download(from: release.dmg)
        let dmg = work.appendingPathComponent(release.dmg.lastPathComponent)
        try FileManager.default.moveItem(at: downloaded, to: dmg)

        // The disk image must match the checksum published with the release.
        guard let sumsURL = release.sums else { throw UpdateError.checksumMissing }
        let (sumsData, _) = try await URLSession.shared.data(from: sumsURL)
        let sums = String(decoding: sumsData, as: UTF8.self)
        let expected = sums.split(separator: "\n").compactMap { line -> String? in
            let fields = line.split(separator: " ", omittingEmptySubsequences: true)
            guard fields.count >= 2, fields.last.map({ $0.trimmingCharacters(in: CharacterSet(charactersIn: "*")) }) == dmg.lastPathComponent
            else { return nil }
            return String(fields[0]).lowercased()
        }.first
        guard let expected else { throw UpdateError.checksumMissing }
        let actual = SHA256.hash(data: try Data(contentsOf: dmg, options: .mappedIfSafe)).map { String(format: "%02x", $0) }.joined()
        guard actual == expected else { throw UpdateError.checksumMismatch }

        let destination = Bundle.main.bundleURL
        let parent = destination.deletingLastPathComponent()
        guard destination.pathExtension == "app", FileManager.default.isWritableFile(atPath: parent.path) else {
            throw UpdateError.needsManualInstall(dmg)
        }

        let mount = work.appendingPathComponent("mount")
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        try run("/usr/bin/hdiutil", ["attach", dmg.path, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path])
        defer { _ = try? run("/usr/bin/hdiutil", ["detach", mount.path, "-force"]) }

        guard let found = try FileManager.default.contentsOfDirectory(at: mount, includingPropertiesForKeys: nil)
            .first(where: { $0.pathExtension == "app" }) else { throw UpdateError.badBundle("no app in the disk image") }
        // Stage next to the installed app so the final move is a rename on the same volume.
        let staged = parent.appendingPathComponent(".Murmur-\(release.version)-update.app")
        try? FileManager.default.removeItem(at: staged)
        try run("/usr/bin/ditto", [found.path, staged.path])

        guard let info = Bundle(url: staged)?.infoDictionary,
              info["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier else {
            try? FileManager.default.removeItem(at: staged)
            throw UpdateError.badBundle("different bundle identifier")
        }
        guard info["CFBundleShortVersionString"] as? String == release.version else {
            try? FileManager.default.removeItem(at: staged)
            throw UpdateError.badBundle("version does not match the release")
        }
        do {
            try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged.path])
        } catch {
            try? FileManager.default.removeItem(at: staged)
            throw UpdateError.badBundle("signature check failed")
        }
        return staged
    }

    /// A small script waits for Murmur to quit, swaps the bundles (restoring the old one on failure) and reopens it.
    private static func swapAndRelaunch(staged: URL) throws {
        let script = """
        pid="$1"; old="$2"; new="$3"
        while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
        rm -rf "$old.previous"
        if mv "$old" "$old.previous"; then
          if mv "$new" "$old"; then rm -rf "$old.previous"; else mv "$old.previous" "$old"; fi
        fi
        xattr -dr com.apple.quarantine "$old" 2>/dev/null
        open "$old"
        """
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", script, "murmur-update", String(ProcessInfo.processInfo.processIdentifier),
                             Bundle.main.bundleURL.path, staged.path]
        try process.run()
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }

    @discardableResult
    private static func run(_ tool: String, _ arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        guard process.terminationStatus == 0 else {
            throw UpdateError.tool("\((tool as NSString).lastPathComponent): \(text.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
        return text
    }
}
