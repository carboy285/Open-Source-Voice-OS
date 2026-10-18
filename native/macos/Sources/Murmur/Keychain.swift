import Foundation
import Security

/// Generic-password items under the service "Murmur", one account per key. The CLI uses the same layout.
///
/// Items go to the login keychain. The data-protection keychain needs a keychain-access-groups entitlement,
/// which an ad-hoc signed build can't carry, so it is not used.
enum Keychain {
    static let service = "Murmur"

    struct Failure: Error, LocalizedError {
        let status: OSStatus
        var errorDescription: String? {
            let text = SecCopyErrorMessageString(status, nil) as String? ?? "Unknown error"
            return "\(text) (\(status))"
        }
    }

    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }

    static func get(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Checks for an item without reading its secret, so it never shows a keychain password prompt.
    static func exists(_ key: String) -> Bool {
        var q = query(key)
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess
    }

    /// Stores a value. Falls back to /usr/bin/security when the Security API refuses the write.
    static func save(_ key: String, _ value: String) -> Result<Void, Failure> {
        let data = Data(value.utf8)
        var status = SecItemUpdate(query(key) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query(key)
            add[kSecValueData as String] = data
            add[kSecAttrLabel as String] = "Murmur: \(key)"
            status = SecItemAdd(add as CFDictionary, nil)
        }
        if status == errSecSuccess { return .success(()) }
        NSLog("Murmur: keychain write for %@ failed: %d", key, status)
        if securityTool(key, value) && exists(key) { return .success(()) }
        return .failure(Failure(status: status))
    }

    @discardableResult
    static func set(_ key: String, _ value: String) -> Bool {
        if case .success = save(key, value) { return true }
        return false
    }

    static func delete(_ key: String) {
        SecItemDelete(query(key) as CFDictionary)
    }

    /// Writes through Apple's `security` tool in interactive mode. The secret goes over stdin, never in the arguments.
    private static func securityTool(_ key: String, _ value: String) -> Bool {
        func quote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["-i"]
        let input = Pipe()
        process.standardInput = input
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return false
        }
        let line = "add-generic-password -U -s \(quote(service)) -a \(quote(key)) -w \(quote(value))\n"
        input.fileHandleForWriting.write(Data(line.utf8))
        try? input.fileHandleForWriting.close()
        process.waitUntilExit()
        return process.terminationStatus == 0
    }
}
