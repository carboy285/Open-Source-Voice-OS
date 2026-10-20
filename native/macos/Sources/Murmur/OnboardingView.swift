import SwiftUI

/// A guided setup with a safe practice area and a separate test of actual hotkey insertion.
struct OnboardingView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @State private var step = 0
    @State private var testText = ""
    init(initialStep: Int = 0) { _step = State(initialValue: min(3, max(0, initialStep))) }

    private let steps = ["setup.welcome", "setup.permissions", "setup.model", "setup.practice"]

    private var ready: Bool {
        model.micStatus == .granted && model.axStatus == .granted &&
        (model.speech.ready || !(model.settings["stt.model"] as? String ?? "").isEmpty)
    }
    private var canContinue: Bool {
        if step == 1 { return model.micStatus == .granted && model.axStatus == .granted }
        if step == 2 { return ready }
        return !model.setupRecording && !model.setupBusy
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: Space.l) {
                Image(systemName: "waveform.circle.fill").font(.system(size: 46)).foregroundStyle(Color.accentColor).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(L("setup.title")).font(.title.weight(.bold))
                    Text(L("setup.subtitle")).font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(step + 1) / 4").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            .padding(Space.xl)
            HStack(spacing: Space.s) {
                ForEach(steps.indices, id: \.self) { index in
                    HStack(spacing: Space.xs) {
                        Image(systemName: index < step ? "checkmark.circle.fill" : "\(index + 1).circle\(index == step ? ".fill" : "")")
                        Text(L(steps[index])).font(.caption.weight(index == step ? .semibold : .regular))
                    }
                    .foregroundStyle(index <= step ? Color.accentColor : .secondary)
                    .frame(maxWidth: .infinity)
                }
            }.padding(.horizontal, Space.xl).padding(.bottom, Space.l)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    Text(L(steps[step])).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                    content
                }.frame(maxWidth: .infinity, alignment: .leading).padding(Space.xl)
            }
            Divider()
            HStack {
                if step > 0 { Button(L("setup.back")) { step -= 1 }.buttonStyle(PressableButtonStyle()).disabled(model.setupRecording || model.setupBusy) }
                Spacer()
                if step == 3 {
                    Button(L("setup.finish")) { model.windows.closeOnboarding() }
                        .buttonStyle(PressableButtonStyle(prominent: true)).disabled(!ready || model.setupRecording || model.setupBusy)
                        .opacity(ready && !model.setupRecording && !model.setupBusy ? 1 : 0.45)
                } else {
                    Button(L(step == 0 ? "setup.begin" : "setup.next")) { step += 1 }
                        .buttonStyle(PressableButtonStyle(prominent: true)).disabled(!canContinue).opacity(canContinue ? 1 : 0.45).keyboardShortcut(.defaultAction)
                }
            }.padding(Space.l)
        }
        .frame(width: 640, height: 680)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { model.speech.refresh(); model.refreshSettings() }
        .onDisappear { model.cancelSetupPractice() }
    }

    @ViewBuilder private var content: some View {
        switch step {
        case 0:
            Text(L("setup.intro")).font(.body).foregroundStyle(.secondary)
            feature("mic.fill", "setup.dictate.title", L("setup.dictate.body", ["key": model.hotkeyName]))
            feature("pencil.line", "setup.edit.title", L("setup.edit.body", ["key": model.hotkeyName]))
            feature("sparkles", "setup.ask.title", L("setup.ask.body", ["key": model.hotkeyName]))
            Label(L("setup.privacy"), systemImage: "lock.shield").font(.callout).foregroundStyle(.secondary).padding(Space.m)
        case 1:
            Text(L("setup.permissions.help")).foregroundStyle(.secondary)
            permission("mic.fill", "onboarding.mic.title", "onboarding.mic.body", model.micStatus, "Privacy_Microphone") {
                Permissions.requestMicrophone { _ in model.micStatus = Permissions.microphone }
            }
            permission("accessibility", "onboarding.ax.title", "onboarding.ax.body", model.axStatus, "Privacy_Accessibility") { Permissions.requestAccessibility() }
            Button(L("setup.input_monitoring")) { Permissions.openSettings("Privacy_ListenEvent") }.buttonStyle(PressableButtonStyle())
            Text(L("setup.permissions.fix")).font(.caption).foregroundStyle(.secondary)
        case 2:
            Text(L("setup.model.help")).foregroundStyle(.secondary)
            OnboardingModelRow(store: model.speech)
            Text(L("setup.model.note")).font(.caption).foregroundStyle(.secondary)
            Button(L("setup.open_settings")) { model.windows.showSettings() }.buttonStyle(PressableButtonStyle())
        default:
            Text(L("setup.practice.help")).foregroundStyle(.secondary)
            HStack {
                Button(L(model.setupRecording ? "setup.stop" : "setup.record")) { model.toggleSetupPractice() }
                    .buttonStyle(PressableButtonStyle(prominent: true)).disabled(model.setupBusy)
                if model.setupRecording { ProgressView(value: Double(model.level)).frame(width: 110) }
                if model.setupBusy { ProgressView().controlSize(.small) }
            }
            if !model.setupTranscript.isEmpty {
                Label(L("setup.speech_pass"), systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                Text(model.setupTranscript).textSelection(.enabled).padding(Space.m).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
            }
            if let error = model.setupError { Text(error).font(.callout).foregroundStyle(.red) }
            Text(L("setup.hotkey.help", ["key": model.hotkeyName])).font(.callout)
            TextEditor(text: $testText).font(.body).frame(height: 72).padding(6).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                .accessibilityLabel(L("setup.test_field"))

            Label(L(model.setupInserted ? "setup.insert_pass" : "setup.insert_pending"), systemImage: model.setupInserted ? "checkmark.circle.fill" : "circle").font(.caption).foregroundStyle(model.setupInserted ? .green : .secondary)
            DisclosureGroup(L("setup.extras")) {
                VStack(alignment: .leading, spacing: Space.m) {
                    permission("viewfinder", "onboarding.screen.title", "onboarding.screen.body", model.screenStatus, "Privacy_ScreenCapture") { Permissions.requestScreenRecording() }
                    Text(L("setup.ai_optional")).font(.caption).foregroundStyle(.secondary)
                    Button(L("setup.open_settings")) { model.windows.showSettings() }.buttonStyle(PressableButtonStyle())
                }.padding(.top, Space.s)
            }
        }
    }

    private func feature(_ icon: String, _ title: String, _ body: String) -> some View {
        HStack(alignment: .top, spacing: Space.m) {
            Image(systemName: icon).font(.title2).frame(width: 32).foregroundStyle(Color.accentColor).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.xs) { Text(L(title)).font(.headline); Text(body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }.padding(Space.l).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14))
    }

    private func permission(_ icon: String, _ title: String, _ body: String, _ status: PermissionStatus, _ pane: String, request: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack { Label(L(title), systemImage: icon).font(.headline); Spacer(); Label(L(status.key), systemImage: status == .granted ? "checkmark.circle.fill" : "circle").font(.caption).foregroundStyle(status == .granted ? .green : .secondary) }
            Text(L(body)).font(.callout).foregroundStyle(.secondary)
            if status != .granted {
                HStack { Button(L("onboarding.request"), action: request).buttonStyle(PressableButtonStyle(prominent: true)); Button(L("onboarding.open_settings")) { Permissions.openSettings(pane) }.buttonStyle(PressableButtonStyle()) }
            }
        }.padding(Space.l).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14))
    }
}
