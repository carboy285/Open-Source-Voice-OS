import SwiftUI

/// Non-blocking panel docked to the right edge: running tasks, pending approvals and history. No scrim.
struct SidePanelView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var query = ""
    @State private var request = ""

    var body: some View {
        GeometryReader { proxy in
            content
                .frame(width: proxy.size.width, height: proxy.size.height)
                .surface(cornerRadius: 16)
                .shadow(color: .black.opacity(0.18), radius: 20, x: -4)
                // Enters from the right edge and leaves the same way. A new target starts from the current position.
                .offset(x: model.panelVisible || reduceMotion ? 0 : proxy.size.width + 24)
                .opacity(reduceMotion && !model.panelVisible ? 0 : 1)
                .animation(Motion.panel(reduceMotion: reduceMotion), value: model.panelVisible)
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(L("panel.title")).font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Spacer()
                Button {
                    model.hidePanel()
                } label: {
                    Image(systemName: "sidebar.right")
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .accessibilityLabel(L("approval.cancel"))
            }
            .padding(Space.l)

            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    HStack {
                        Text(L(model.state.menuKey)).font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button("Cancel") { model.cancelCurrentRequest() }
                    }
                    if let review = model.editReview {
                        VStack(alignment: .leading, spacing: Space.s) {
                            Text("Review voice edit").font(.headline)
                            Text("Original").font(.caption).foregroundStyle(.secondary)
                            Text(review.before).textSelection(.enabled)
                            Text("Proposed edit").font(.caption).foregroundStyle(.secondary)
                            Text(review.after).textSelection(.enabled)
                            HStack {
                                Button("Replace selection") { model.reviewEdit(true) }.buttonStyle(PressableButtonStyle(prominent: true))
                                Button("Keep original") { model.reviewEdit(false) }
                            }
                        }.padding(Space.m).background(RoundedRectangle(cornerRadius: 10).fill(Color.orange.opacity(0.1)))
                    }
                    recovery
                    VStack(alignment: .leading, spacing: Space.s) {
                        Text("Ask or follow up").font(.headline)
                        TextField("Your request", text: $request).textFieldStyle(.roundedBorder)
                            .onSubmit { sendRequest() }
                        Button("Send") { sendRequest() }.disabled(request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.editReview != nil)
                    }
                    if !model.approvals.isEmpty { approvals }
                    if !model.activeTasks.isEmpty { current }
                    history
                }
                .padding(.horizontal, Space.l)
                .padding(.bottom, Space.l)
            }
        }
    }

    private func sendRequest() {
        model.askFromPanel(request)
        request = ""
    }

    private var recovery: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack {
                Text("Dictation & edits").font(.headline)
                Spacer()
                Button("Clear") { model.clearRecovery() }.buttonStyle(.link)
            }
            if model.recovery.isEmpty {
                Text("Results will appear here. Only the latest result is kept unless session history is enabled in Dictation settings.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(model.recovery) { entry in
                VStack(alignment: .leading, spacing: Space.s) {
                    Text("\(entry.mode) · \(entry.status)").font(.caption).foregroundStyle(.secondary)
                    Text(entry.text.isEmpty ? entry.transcript : entry.text).textSelection(.enabled)
                    if let error = entry.error { Text(error).font(.caption).foregroundStyle(.secondary) }
                    HStack {
                        Button("Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(entry.text.isEmpty ? entry.transcript : entry.text, forType: .string)
                        }
                        if !entry.text.isEmpty { Button("Reinsert…") { model.recover(entry, retry: false) } }
                        Button("Retry…") { model.recover(entry, retry: true) }
                    }.buttonStyle(.link)
                }.padding(Space.m).background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.04)))
            }
        }
    }

    private var approvals: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            ForEach(model.approvals) { preview in
                HStack {
                    Image(systemName: "hand.raised.fill").foregroundStyle(.orange).accessibilityHidden(true)
                    Text(preview.summary).font(.callout).lineLimit(2)
                    Spacer()
                    Button(L("panel.approve_pending")) { model.windows.showApproval() }
                        .buttonStyle(PressableButtonStyle(prominent: true))
                }
                .padding(Space.m)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.orange.opacity(0.12)))
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var current: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(L("panel.current")).font(.headline)
            ForEach(model.activeTasks) { task in
                VStack(alignment: .leading, spacing: Space.s) {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text(L("panel.status.\(task.status)")).font(.callout.weight(.medium))
                        Spacer()
                        Button(L("panel.cancel_task")) { model.cancelTask(task.id) }
                            .buttonStyle(PressableButtonStyle())
                    }
                    if let step = task.currentStep {
                        Text(step).font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                    steps(task.steps)
                }
                .padding(Space.m)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
            }
        }
    }

    private func steps(_ steps: [TaskStep]) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            ForEach(steps) { step in
                HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                    Image(systemName: step.approval == "cancelled" || step.approval == "expired" ? "xmark.circle" : "checkmark.circle")
                        .foregroundStyle(step.approval == "cancelled" || step.approval == "expired" ? Color.secondary : Color.green)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(step.inputSummary).font(.callout).lineLimit(2)
                        Text(L("panel.approval.\(step.approval)")).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(L("panel.history")).font(.headline)
            TextField(L("panel.search"), text: $query)
                .textFieldStyle(.roundedBorder)
                .onSubmit { model.refreshHistory(query: query) }
                .onChange(of: query) { value in model.refreshHistory(query: value) }
            let finished = model.history.filter { !$0.isActive }
            if finished.isEmpty {
                Text(L("panel.empty", ["key": "\(model.hotkeyName) + Shift"]))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, Space.s)
            }
            ForEach(finished) { task in
                VStack(alignment: .leading, spacing: Space.xs) {
                    HStack {
                        Text(task.transcript ?? L("panel.transcript_hidden")).font(.callout.weight(.medium)).lineLimit(2)
                        Spacer()
                        Text(L("panel.status.\(task.status)")).font(.caption).foregroundStyle(.secondary)
                    }
                    if !task.reply.isEmpty {
                        Text(task.reply).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    HStack {
                        Text(task.startedAt, style: .relative).font(.caption).foregroundStyle(.tertiary)
                        Spacer()
                        Button(task.status == "failed" ? L("panel.retry") : L("panel.run_again")) { model.runAgain(task.id) }
                            .buttonStyle(.link)
                            .disabled(task.transcript == nil)
                    }
                }
                .padding(Space.m)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.04)))
                .accessibilityElement(children: .contain)
            }
        }
    }
}
