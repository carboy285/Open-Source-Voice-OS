import SwiftUI

/// The listening capsule, with the change report growing upward out of it.
struct IndicatorView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var label: String {
        switch model.state {
        case .listening: return model.action == .agent ? L("indicator.agent") : L("indicator.listening")
        case .error: return L("menu.state.error")
        case .done: return L("menu.state.done")
        default: return L("indicator.working")
        }
    }

    private var popTransition: AnyTransition {
        reduceMotion ? .opacity : .scale(scale: 0.85, anchor: .bottom).combined(with: .opacity)
    }

    var body: some View {
        VStack(spacing: Space.s) {
            Spacer(minLength: 0)
            if model.reportVisible {
                ReportCard()
                    .transition(popTransition)
            }
            if model.indicatorVisible {
                capsule
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
            }
        }
        .padding(Space.m)
        .frame(width: WindowManager.indicatorSize.width, height: WindowManager.indicatorSize.height, alignment: .bottom)
        .animation(Motion.standard(reduceMotion: reduceMotion), value: model.reportVisible)
        .animation(Motion.standard(reduceMotion: reduceMotion), value: model.indicatorVisible)
        .animation(Motion.standard(reduceMotion: reduceMotion), value: model.state)
    }

    private var capsule: some View {
        HStack(spacing: Space.s) {
            if model.state == .listening {
                LevelBars(level: model.level)
            } else if model.state == .error {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            } else if model.state == .done {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            } else {
                ProgressView().controlSize(.small)
            }
            Text(label).font(.callout.weight(.medium))
            if model.state == .listening {
                Text(L("indicator.cancel_hint")).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.s + 2)
        .surface(cornerRadius: 22)
        .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

struct LevelBars: View {
    var level: Float
    private let weights: [Float] = [0.5, 0.8, 1, 0.8, 0.5]

    var body: some View {
        HStack(spacing: 3) {
            ForEach(weights.indices, id: \.self) { index in
                Capsule()
                    .fill(Color.accentColor)
                    .frame(width: 3, height: CGFloat(4 + 14 * min(1, level * weights[index] * 1.4)))
            }
        }
        .frame(height: 18)
        .animation(.spring(response: 0.15, dampingFraction: 1.0), value: level)
        .accessibilityHidden(true)
    }
}

/// What cleanup changed, or a short message (reply, "Didn't catch that", an error with Retry).
struct ReportCard: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings

    private func icon(_ category: String) -> String {
        switch category {
        case "filler_removed": return "scissors"
        case "dictionary_applied", "dictionary_added": return "character.book.closed"
        case "spelling_fixed": return "textformat.abc"
        case "grammar_fixed": return "text.badge.checkmark"
        case "list_formatted": return "list.bullet"
        case "polish_rejected": return "arrow.uturn.backward"
        default: return "textformat"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack {
                Text(model.report.isEmpty ? L("app.name") : L("report.title"))
                    .font(.headline)
                Spacer()
                Button {
                    model.dismissReport()
                } label: {
                    Image(systemName: "xmark").font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel(L("approval.cancel"))
                .keyboardShortcut(.cancelAction)
            }
            if let message = model.reportMessage, !message.isEmpty {
                Text(message)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            ForEach(model.report) { item in
                Label(item.label, systemImage: icon(item.category))
                    .font(.callout)
            }
            if model.state == .error {
                Button(L("error.retry")) { model.retryDictation() }
                    .buttonStyle(PressableButtonStyle(prominent: true))
            }
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surface()
        .shadow(color: .black.opacity(0.15), radius: 16, y: 6)
        .accessibilityElement(children: .contain)
    }
}
