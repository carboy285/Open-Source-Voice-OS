import Foundation

/// JSON value helpers over JSONSerialization output.
typealias JSONObject = [String: Any]

enum CoreError: LocalizedError {
    case notRunning
    case remote(code: Int, message: String)
    case timeout(String)

    var errorDescription: String? {
        switch self {
        case .notRunning: return "Murmur's engine is not running."
        case let .remote(_, message): return message
        case let .timeout(method): return "\(method) took too long."
        }
    }
}

/// Starts the bundled Node core and speaks newline-delimited JSON-RPC 2.0 with it, in both directions.
final class CoreClient {
    typealias RequestHandler = (JSONObject, @escaping (Result<Any, Error>) -> Void) -> Void

    var onNotification: ((String, JSONObject) -> Void)?
    var onExit: ((Int32) -> Void)?

    private var process: Process?
    private var stdinPipe: Pipe?
    private var buffer = Data()
    private var nextId = 1
    private var pending: [Int: (Result<Any, Error>) -> Void] = [:]
    private var handlers: [String: RequestHandler] = [:]
    private let queue = DispatchQueue(label: "murmur.core")

    /// Registers a handler for a request the core sends to the shell (text.insert, context.capture, secret.*).
    func handle(_ method: String, _ handler: @escaping RequestHandler) {
        handlers[method] = handler
    }

    /// Finds the runtime: the app bundle first, then MURMUR_NODE / MURMUR_CORE for development.
    static func locate() -> (node: URL, script: URL)? {
        let env = ProcessInfo.processInfo.environment
        if let core = Bundle.main.resourceURL?.appendingPathComponent("core") {
            let node = core.appendingPathComponent("node")
            let script = core.appendingPathComponent("murmur-core.mjs")
            if FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: script.path) {
                return (node, script)
            }
        }
        if let script = env["MURMUR_CORE"] {
            let node = env["MURMUR_NODE"] ?? "/usr/local/bin/node"
            return (URL(fileURLWithPath: node), URL(fileURLWithPath: script))
        }
        return nil
    }

    func start() throws {
        guard let location = CoreClient.locate() else { throw CoreError.notRunning }
        let process = Process()
        process.executableURL = location.node
        process.arguments = ["--disable-warning=ExperimentalWarning", location.script.path, "daemon"]
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.standardError
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            self.queue.async { self.receive(data) }
        }
        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                self?.failAll()
                self?.onExit?(proc.terminationStatus)
            }
        }
        try process.run()
        self.process = process
        self.stdinPipe = input
    }

    func stop() {
        stdinPipe?.fileHandleForWriting.closeFile()
        process?.terminate()
        process = nil
    }

    var isRunning: Bool { process?.isRunning ?? false }

    /// Sends a request; the completion runs on the main queue.
    func request(_ method: String, _ params: JSONObject = [:], timeout: TimeInterval = 60, completion: ((Result<Any, Error>) -> Void)? = nil) {
        queue.async {
            guard self.isRunning else {
                DispatchQueue.main.async { completion?(.failure(CoreError.notRunning)) }
                return
            }
            let id = self.nextId
            self.nextId += 1
            self.pending[id] = { result in DispatchQueue.main.async { completion?(result) } }
            self.write(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
            self.queue.asyncAfter(deadline: .now() + timeout) {
                if let callback = self.pending.removeValue(forKey: id) {
                    callback(.failure(CoreError.timeout(method)))
                }
            }
        }
    }

    func notify(_ method: String, _ params: JSONObject = [:]) {
        queue.async { self.write(["jsonrpc": "2.0", "method": method, "params": params]) }
    }

    private func write(_ message: JSONObject) {
        guard let handle = stdinPipe?.fileHandleForWriting,
              var data = try? JSONSerialization.data(withJSONObject: message, options: []) else { return }
        data.append(0x0A)
        handle.write(data)
    }

    private func failAll() {
        queue.async {
            let callbacks = self.pending.values
            self.pending.removeAll()
            for callback in callbacks { callback(.failure(CoreError.notRunning)) }
        }
    }

    private func receive(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            guard !line.isEmpty,
                  let object = try? JSONSerialization.jsonObject(with: line, options: []) as? JSONObject else { continue }
            dispatch(object)
        }
    }

    private func dispatch(_ message: JSONObject) {
        if let method = message["method"] as? String {
            let params = message["params"] as? JSONObject ?? [:]
            if let id = message["id"] {
                DispatchQueue.main.async {
                    guard let handler = self.handlers[method] else {
                        self.queue.async {
                            self.write(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Unknown method \(method)"] as JSONObject])
                        }
                        return
                    }
                    handler(params) { result in
                        self.queue.async {
                            switch result {
                            case let .success(value):
                                self.write(["jsonrpc": "2.0", "id": id, "result": value])
                            case let .failure(error):
                                self.write(["jsonrpc": "2.0", "id": id, "error": ["code": -32000, "message": error.localizedDescription] as JSONObject])
                            }
                        }
                    }
                }
            } else {
                DispatchQueue.main.async { self.onNotification?(method, params) }
            }
            return
        }
        guard let id = message["id"] as? Int, let callback = pending.removeValue(forKey: id) else { return }
        if let error = message["error"] as? JSONObject {
            callback(.failure(CoreError.remote(code: error["code"] as? Int ?? -1, message: error["message"] as? String ?? "Error")))
        } else {
            callback(.success(message["result"] ?? NSNull()))
        }
    }
}
