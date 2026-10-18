import SwiftUI

/// First run: microphone (required), accessibility and screen recording (optional), each with a live status.
struct OnboardingView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            VStack(alignment: .leading, spacing: Space.s) {
                Text(L("onboarding.title")).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Text(L("onboarding.subtitle")).font(.body).foregroundStyle(.secondary)
            }
            row(
                icon: "mic.fill",
                title: L("onboarding.mic.title"),
                body: L("onboarding.mic.body"),
                status: model.micStatus,
                optional: false,
                request: { Permissions.requestMicrophone { _ in model.micStatus = Permissions.microphone } },
                pane: "Privacy_Microphone"
            )
            row(
                icon: "accessibility",
                title: L("onboarding.ax.title"),
                body: L("onboarding.ax.body"),
                status: model.axStatus,
                optional: false,
                request: { Permissions.requestAccessibility() },
                pane: "Privacy_Accessibility"
            )
            row(
                icon: "rectangle.dashed.badge.record",
                title: L("onboarding.screen.title"),
                body: L("onboarding.screen.body"),
                status: model.screenStatus,
                optional: true,
                request: { Permissions.requestScreenRecording() },
                pane: "Privacy_ScreenCapture"
            )
            OnboardingModelRow(store: model.speech)
            HStack {
                Text(L("menu.hotkey.dictate", ["key": model.hotkeyName])).font(.callout).foregroundStyle(.secondary)
                Spacer()
                Button(L("onboarding.done")) { model.windows.closeOnboarding() }
                    .buttonStyle(PressableButtonStyle(prominent: true))
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.micStatus != .granted)
            }
        }
        .padding(Space.xl)
        .frame(width: 520)
    }

    private func row(icon: String, title: String, body: String, status: PermissionStatus, optional: Bool, request: @escaping () -> Void, pane: String) -> some View {
        HStack(alignment: .top, spacing: Space.m) {
            Image(systemName: icon)
                .font(.title2)
                .frame(width: 32)
                .foregroundStyle(Color.accentColor)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack {
                    Text(title).font(.headline)
                    Spacer()
                    statusBadge(status, optional: optional)
                }
                Text(body).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if status != .granted {
                    HStack(spacing: Space.s) {
                        Button(L("onboarding.request"), action: request).buttonStyle(PressableButtonStyle(prominent: !optional))
                        Button(L("onboarding.open_settings")) { Permissions.openSettings(pane) }.buttonStyle(PressableButtonStyle())
                    }
                    .padding(.top, Space.xs)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func statusBadge(_ status: PermissionStatus, optional: Bool) -> some View {
        let text = status == .granted ? L(status.key) : optional ? L("onboarding.status.optional") : L(status.key)
        let color: Color = status == .granted ? .green : status == .denied ? .red : .secondary
        return Label(text, systemImage: status == .granted ? "checkmark.circle.fill" : "circle")
            .font(.caption.weight(.medium))
            .foregroundStyle(color)
    }
}
