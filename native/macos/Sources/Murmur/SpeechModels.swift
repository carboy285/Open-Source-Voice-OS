import SwiftUI

/// A speech model from the core's catalog, with its local state.
struct SpeechModelInfo: Identifiable, Equatable {
    let id: String
    let name: String
    let variant: String
    let approxMB: Int
    let installed: Bool
    let recommended: Bool
    let downloading: Bool
    let bytes: Int?

    init(_ object: JSONObject) {
        id = object["id"] as? String ?? ""
        name = object["name"] as? String ?? ""
        variant = object["variant"] as? String ?? ""
        approxMB = object["approxMB"] as? Int ?? 0
        installed = object["installed"] as? Bool ?? false
        recommended = object["recommended"] as? Bool ?? false
        downloading = object["downloading"] as? Bool ?? false
        bytes = object["bytes"] as? Int
    }
}

/// Downloaded NVIDIA models and the speech engine choice. The core downloads and verifies the files
/// (into Application Support/Murmur/models); this mirrors its state for the UI.
final class SpeechModelStore: ObservableObject {
    @Published private(set) var models: [SpeechModelInfo] = []
    @Published private(set) var active = ""
    @Published private(set) var engine = "parakeet"
    @Published private(set) var directory = ""
    /// 0...1 while downloading; nil when the size isn't known yet.
    @Published private(set) var progress: [String: Double?] = [:]
    @Published private(set) var errors: [String: String] = [:]

    private let core: CoreClient
    var onFinished: ((SpeechModelInfo) -> Void)?
    var onChange: (() -> Void)?

    init(core: CoreClient) {
        self.core = core
    }

    var recommended: SpeechModelInfo? { models.first(where: \.recommended) ?? models.first }

    /// A Parakeet model is downloaded and selected.
    var ready: Bool { models.contains { $0.id == active && $0.installed } }

    func refresh() {
        core.request("models.list") { [weak self] result in
            if case let .success(value) = result, let object = value as? JSONObject { self?.apply(object) }
        }
    }

    func download(_ id: String) {
        errors[id] = nil
        progress[id] = .some(nil)
        core.request("models.download", ["id": id]) { [weak self] result in
            if case let .failure(error) = result {
                self?.progress[id] = nil
                self?.errors[id] = error.localizedDescription
            }
            self?.refresh()
        }
    }

    func cancel(_ id: String) {
        core.request("models.cancel", ["id": id])
    }

    func use(_ id: String) {
        core.request("models.use", ["id": id]) { [weak self] result in self?.handleState(result) }
    }

    func remove(_ id: String) {
        core.request("models.remove", ["id": id]) { [weak self] result in self?.handleState(result) }
    }

    func setEngine(_ value: String) {
        engine = value
        core.request("settings.set", ["key": "stt.engine", "value": value]) { [weak self] _ in
            self?.refresh()
            self?.onChange?()
        }
    }

    /// `models.progress` and `models.done` from the core.
    func handle(_ method: String, _ params: JSONObject) {
        guard let id = params["id"] as? String else { return }
        switch method {
        case "models.progress":
            let received = params["received"] as? Double ?? Double(params["received"] as? Int ?? 0)
            let total = params["total"] as? Double ?? (params["total"] as? Int).map(Double.init)
            if let total, total > 0 {
                progress[id] = .some(min(1, received / total))
            } else {
                progress[id] = .some(nil)
            }
        case "models.done":
            progress[id] = nil
            if params["ok"] as? Bool == true {
                errors[id] = nil
                core.request("models.list") { [weak self] result in
                    guard let self, case let .success(value) = result, let object = value as? JSONObject else { return }
                    self.apply(object)
                    if let info = self.models.first(where: { $0.id == id }) { self.onFinished?(info) }
                }
            } else {
                let message = params["error"] as? String ?? ""
                if !message.isEmpty, !message.contains("cancelled") { errors[id] = message }
                refresh()
            }
        default:
            break
        }
    }

    private func handleState(_ result: Result<Any, Error>) {
        switch result {
        case let .success(value):
            if let object = value as? JSONObject { apply(object) }
            onChange?()
        case let .failure(error):
            NSLog("Murmur: model change failed: %@", error.localizedDescription)
        }
    }

    private func apply(_ object: JSONObject) {
        models = (object["models"] as? [JSONObject] ?? []).map(SpeechModelInfo.init)
        active = object["active"] as? String ?? ""
        engine = object["engine"] as? String ?? "parakeet"
        directory = object["dir"] as? String ?? ""
        for model in models where model.downloading && progress[model.id] == nil {
            progress[model.id] = .some(nil)
        }
    }
}

/// One downloadable model: variant, size, and Download / Cancel / Use / Delete.
struct SpeechModelRow: View {
    let info: SpeechModelInfo
    @ObservedObject var store: SpeechModelStore
    @EnvironmentObject var strings: Strings

    private var isActive: Bool { info.installed && info.id == store.active && store.engine == "parakeet" }
    private var isDownloading: Bool { store.progress[info.id] != nil }

    var body: some View {
        HStack(alignment: .center, spacing: Space.m) {
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack(spacing: Space.s) {
                    Text(L("models.variant.\(info.variant)")).font(.body.weight(.medium))
                    if info.recommended {
                        Text(L("models.recommended"))
                            .font(.caption.weight(.medium))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.accentColor.opacity(0.15)))
                    }
                }
                if isDownloading {
                    if let fraction = store.progress[info.id] ?? nil {
                        ProgressView(value: fraction).frame(maxWidth: 220)
                    } else {
                        ProgressView().progressViewStyle(.linear).frame(maxWidth: 220)
                    }
                } else if let error = store.errors[info.id] {
                    Text(L("models.failed", ["error": error])).font(.caption).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(sizeText).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            buttons
        }
        .accessibilityElement(children: .contain)
    }

    private var sizeText: String {
        if let bytes = info.bytes { return L("models.size_exact", ["size": String(bytes / 1_000_000)]) }
        return L("models.size", ["size": String(info.approxMB)])
    }

    @ViewBuilder private var buttons: some View {
        if isDownloading {
            Button(L("models.cancel")) { store.cancel(info.id) }
        } else if isActive {
            Label(L("models.in_use"), systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
                .labelStyle(.titleAndIcon)
            Button(L("models.remove")) { store.remove(info.id) }
        } else if info.installed {
            Button(L("models.use")) { store.use(info.id) }
            Button(L("models.remove")) { store.remove(info.id) }
        } else {
            Button(L("models.download")) { store.download(info.id) }
                .buttonStyle(.borderedProminent)
        }
    }
}

/// Onboarding row: downloads the recommended model, or shows that one is ready.
struct OnboardingModelRow: View {
    @ObservedObject var store: SpeechModelStore
    @EnvironmentObject var strings: Strings

    var body: some View {
        HStack(alignment: .top, spacing: Space.m) {
            Image(systemName: "waveform.badge.mic")
                .font(.title2)
                .frame(width: 32)
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack {
                    Text(L("onboarding.model.title")).font(.headline)
                    Spacer()
                    if store.ready {
                        Label(L("onboarding.status.granted"), systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green).font(.callout)
                    }
                }
                Text(L("onboarding.model.body", ["size": String(store.recommended?.approxMB ?? 680)]))
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if !store.ready, let model = store.recommended {
                    SpeechModelRow(info: model, store: store).padding(.top, Space.xs)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}
