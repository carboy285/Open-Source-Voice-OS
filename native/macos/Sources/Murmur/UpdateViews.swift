import SwiftUI

/// Update items in the menu-bar menu: an install button when a release is waiting, otherwise a check.
struct UpdateMenuItems: View {
    @ObservedObject var updater: Updater
    @EnvironmentObject var strings: Strings

    var body: some View {
        switch updater.phase {
        case let .available(version):
            Button(L("update.install", ["version": version])) { updater.install() }
        case let .downloading(version):
            Text(L("update.downloading", ["version": version]))
        case let .installing(version):
            Text(L("update.installing", ["version": version]))
        case .checking:
            Text(L("update.checking"))
        case let .failed(error):
            Text(L("update.failed", ["error": error]))
            Button(L("update.check")) { updater.check(userInitiated: true) }
        case .upToDate, .idle:
            Button(L("update.check")) { updater.check(userInitiated: true) }
        }
    }
}

/// Version, status and the update button for Settings › General.
struct UpdateSettingsSection: View {
    @ObservedObject var updater: Updater
    @EnvironmentObject var strings: Strings

    var body: some View {
        Section {
            HStack {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(L("settings.version", ["version": updater.currentVersion]))
                    if let status {
                        Text(status).font(.caption).foregroundStyle(statusIsError ? Color.red : Color.secondary)
                    }
                }
                Spacer()
                actionButton
            }
        }
    }

    private var status: String? {
        switch updater.phase {
        case .idle: return nil
        case .checking: return L("update.checking")
        case .upToDate: return L("update.up_to_date")
        case let .available(version): return L("update.available", ["version": version])
        case let .downloading(version): return L("update.downloading", ["version": version])
        case let .installing(version): return L("update.installing", ["version": version])
        case let .failed(error): return L("update.failed", ["error": error])
        }
    }

    private var statusIsError: Bool {
        if case .failed = updater.phase { return true }
        return false
    }

    @ViewBuilder private var actionButton: some View {
        switch updater.phase {
        case let .available(version):
            Button(L("update.install", ["version": version])) { updater.install() }
                .buttonStyle(.borderedProminent)
        case .checking, .downloading, .installing:
            ProgressView().controlSize(.small)
        default:
            Button(L("update.check")) { updater.check(userInitiated: true) }
        }
    }
}
