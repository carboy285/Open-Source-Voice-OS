import SwiftUI

/// A black shape whose top joins the notch: square top corners, rounded bottom corners.
struct NotchShape: Shape {
    var bottomRadius: CGFloat

    var animatableData: CGFloat {
        get { bottomRadius }
        set { bottomRadius = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let radius = max(0, min(bottomRadius, rect.height / 2, rect.width / 2))
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - radius))
        path.addArc(
            tangent1End: CGPoint(x: rect.maxX, y: rect.maxY),
            tangent2End: CGPoint(x: rect.maxX - radius, y: rect.maxY),
            radius: radius
        )
        path.addLine(to: CGPoint(x: rect.minX + radius, y: rect.maxY))
        path.addArc(
            tangent1End: CGPoint(x: rect.minX, y: rect.maxY),
            tangent2End: CGPoint(x: rect.minX, y: rect.maxY - radius),
            radius: radius
        )
        path.closeSubpath()
        return path
    }
}

/// Natural content heights, so the shape can grow to fit a card.
struct NotchHeightKey: PreferenceKey {
    static let defaultValue: [String: CGFloat] = [:]

    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

/// Fills the fixed-size panel. The surface sits at the top center; a waiting badge hangs beside it.
struct NotchRoot: View {
    @ObservedObject var controller: NotchController
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(controller: NotchController) {
        self.controller = controller
    }

    private var crossFade: Animation? { reduceMotion ? Motion.fade : nil }
    /// The badge follows the shape's edge with the same spring.
    private var follow: Animation? { reduceMotion ? nil : Motion.standard }

    var body: some View {
        let size = controller.panelSize
        ZStack(alignment: .top) {
            NotchSurfaceView(controller: controller, surface: controller.surface)
                // Reduce Motion: each surface is its own view, so they cross-fade instead of morphing.
                .id(reduceMotion ? controller.surface.key : "notch")
                .transition(.opacity)
                .frame(width: size.width, height: size.height, alignment: .top)
            if controller.showsBadge {
                WaitingBadge(count: model.approvals.count, height: controller.geometry.notchSize.height) {
                    controller.focusApproval()
                }
                .alignmentGuide(HorizontalAlignment.center) { _ in
                    -(controller.shapeSize.width / 2 + NotchController.badgeGap)
                }
                .transition(.opacity)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .top)
        .animation(crossFade, value: controller.surface)
        .animation(follow, value: controller.shapeSize)
        .animation(Motion.standard(reduceMotion: reduceMotion), value: controller.showsBadge)
        .environment(\.colorScheme, .dark)
        .onPreferenceChange(NotchHeightKey.self) { values in
            controller.setMeasured(values)
        }
    }
}

/// The growing shape and the active surface's content, clipped to it.
struct NotchSurfaceView: View {
    @ObservedObject var controller: NotchController
    /// Passed in, so a surface fading out under Reduce Motion keeps its own size and content.
    let surface: NotchSurface
    @EnvironmentObject var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    /// Critically damped, so the shape never overshoots; width and height move together.
    private var grow: Animation? { reduceMotion ? nil : Motion.standard }

    var body: some View {
        let size = controller.shapeSize(for: surface)
        let radius = controller.cornerRadius(for: surface)
        let hidden = surface == .hidden
        let isApproval: Bool = { if case .approval = surface { return true } else { return false } }()
        ZStack(alignment: .top) {
            NotchBackground(notchHeight: controller.geometry.notchSize.height, height: size.height, glow: isApproval)
            content
        }
        .frame(width: size.width, height: size.height, alignment: .top)
        .clipShape(NotchShape(bottomRadius: radius))
        .overlay {
            if contrast == .increased {
                NotchShape(bottomRadius: radius).stroke(Color.white.opacity(0.8), lineWidth: 1)
            }
        }
        .shadow(color: .black.opacity(hidden ? 0 : 0.3), radius: 12, y: 4)
        .opacity(hidden ? 0 : 1)
        .animation(grow, value: surface)
        .animation(grow, value: size)
    }

    @ViewBuilder
    private var content: some View {
        let notch = controller.geometry.notchSize
        let width = controller.shapeSize(for: surface).width
        switch surface {
        case .hidden:
            EmptyView()
        case .listening:
            ListeningContent(notch: notch, width: width)
                .transition(.opacity)
        case .progress(let id):
            if let task = model.tasks[id] {
                ProgressContent(task: task, notch: notch, width: width)
                    .transition(.opacity)
            }
        case .report:
            ReportContent(controller: controller, notch: notch, width: width)
                .transition(.opacity)
        case .approval(let id):
            if let preview = model.approvals.first(where: { $0.callId == id }) {
                ApprovalCard(controller: controller, preview: preview, notch: notch, width: width)
                    .id("\(preview.callId)-\(preview.edited)-\(preview.confirming)-\(preview.errors.count)")
                    .transition(.opacity)
            }
        }
    }
}

// MARK: Listening

/// Level and mode in the wings beside the notch; the mode and the current step underneath.
struct ListeningContent: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    let notch: CGSize
    let width: CGFloat

    private var mode: String {
        switch model.action {
        case .dictate: return L("notch.mode.dictate")
        case .agent: return L("notch.mode.ask")
        case .edit: return L("notch.mode.edit")
        }
    }

    private var modeSymbol: String {
        switch model.action {
        case .dictate: return "mic.fill"
        case .agent: return "sparkles"
        case .edit: return "pencil"
        }
    }

    /// While the key is held: the mode and how to cancel. After release: the step (transcribing, cleaning…).
    private var line: String {
        if model.state == .listening { return "\(mode) · \(L("indicator.cancel_hint"))" }
        return "\(mode) · \(L(model.state.menuKey))"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                leading.frame(maxWidth: .infinity)
                Color.clear.frame(width: notch.width)
                Image(systemName: modeSymbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(maxWidth: .infinity)
            }
            .frame(height: notch.height)
            Text(line)
                .font(.callout.weight(.medium))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.horizontal, Space.l)
                .frame(height: NotchController.listeningExtra - 4)
        }
        .frame(width: width)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line)
        .accessibilityAddTraits(.updatesFrequently)
    }

    @ViewBuilder
    private var leading: some View {
        if model.state == .listening {
            LevelBars(level: model.level)
        } else {
            ProgressView().controlSize(.small)
        }
    }
}

struct LevelBars: View {
    var level: Float
    private let weights: [Float] = [0.5, 0.8, 1, 0.8, 0.5]

    var body: some View {
        HStack(spacing: 3) {
            ForEach(weights.indices, id: \.self) { index in
                Capsule()
                    .fill(Color.white)
                    .frame(width: 3, height: CGFloat(4 + 14 * min(1, level * weights[index] * 1.4)))
            }
        }
        .frame(height: 18)
        .animation(.spring(response: 0.15, dampingFraction: 1.0), value: level)
        .accessibilityHidden(true)
    }
}

// MARK: Task progress

/// The running task's step and step number. A click opens the side panel.
struct ProgressContent: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    let task: TaskInfo
    let notch: CGSize
    let width: CGFloat

    private var stepNumber: Int { max(1, task.steps.count + (task.currentStep == nil ? 0 : 1)) }

    private var line: String {
        let step = L("notch.step", ["count": String(stepNumber)])
        return "\(step) · \(task.currentStep ?? L("panel.status.\(task.status)"))"
    }

    var body: some View {
        Button {
            model.showPanel()
        } label: {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    ProgressView().controlSize(.small).frame(maxWidth: .infinity)
                    Color.clear.frame(width: notch.width)
                    Text(String(stepNumber))
                        .font(.callout.monospacedDigit().weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                }
                .frame(height: notch.height)
                Text(line)
                    .font(.callout)
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, Space.l)
                    .frame(height: NotchController.listeningExtra - 4)
            }
            .frame(width: width)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(line)
        .accessibilityHint(L("notch.open_tasks"))
    }
}

// MARK: Change report

/// The change summary under the notch. Hover or the chevron shows the full list, with Undo for a learned word.
struct ReportContent: View {
    @ObservedObject var controller: NotchController
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    let notch: CGSize
    let width: CGFloat

    private var expanded: Bool { controller.reportExpanded }

    private var expandable: Bool {
        model.report.count > 1 || (model.reportMessage?.count ?? 0) > 80 || model.undoEntryId != nil
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: Space.s) {
                header
                if let message = model.reportMessage, !message.isEmpty {
                    Text(message)
                        .font(.body)
                        .foregroundStyle(.white)
                        .lineLimit(expanded ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                if expanded {
                    ForEach(model.report) { item in
                        ReportRow(item: item)
                    }
                } else if let first = model.report.first {
                    compactLine(first)
                }
                if model.state == .error {
                    Button(L("error.retry")) { model.retryDictation() }
                        .buttonStyle(PressableButtonStyle(prominent: true))
                }
            }
            .padding(.horizontal, Space.l)
            .padding(.top, Space.xs)
            .padding(.bottom, Space.m)
            .frame(width: width, alignment: .leading)
            .background(GeometryReader { proxy in
                Color.clear.preference(key: NotchHeightKey.self, value: ["report": proxy.size.height])
            })
        }
        .frame(width: width, height: controller.contentHeight("report"))
        .padding(.top, notch.height)
        .onHover { hovering in controller.reportHover(hovering) }
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(spacing: Space.s) {
            Text(model.report.isEmpty ? L("app.name") : L("report.title"))
                .font(.headline)
                .foregroundStyle(.white)
            Spacer()
            if expandable {
                Button {
                    controller.reportExpanded.toggle()
                } label: {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel(expanded ? L("notch.show_less") : L("notch.show_all"))
            }
            Button {
                model.dismissReport()
            } label: {
                Image(systemName: "xmark").font(.caption.weight(.semibold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel(L("notch.close"))
        }
    }

    private func compactLine(_ first: ReportItem) -> some View {
        let more = model.report.count - 1
        let text = more > 0 ? "\(first.label)  +\(more)" : first.label
        return Label(text, systemImage: ReportRow.icon(first.category))
            .font(.callout)
            .foregroundStyle(.white)
            .lineLimit(1)
    }
}

struct ReportRow: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    let item: ReportItem

    static func icon(_ category: String) -> String {
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
        HStack(spacing: Space.s) {
            Label(item.label, systemImage: ReportRow.icon(item.category))
                .font(.callout)
                .foregroundStyle(.white)
            Spacer(minLength: Space.s)
            if item.category == "dictionary_added", model.undoEntryId != nil {
                Button(L("report.undo")) { model.undoLearnedWord() }
                    .buttonStyle(PressableButtonStyle())
                    .accessibilityLabel("\(L("report.undo")): \(item.label)")
            }
        }
    }
}

// MARK: Approval

/// The approval preview on the dark notch surface, with a keyboard hint underneath.
struct ApprovalCard: View {
    @ObservedObject var controller: NotchController
    @EnvironmentObject var strings: Strings
    let preview: Preview
    let notch: CGSize
    let width: CGFloat

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: Space.m) {
                ApprovalView(preview: preview, width: width - Space.l * 2)
                footer
            }
            .padding(.horizontal, Space.l)
            .padding(.top, Space.s)
            .padding(.bottom, Space.l)
            .frame(width: width, alignment: .leading)
            .background(GeometryReader { proxy in
                Color.clear.preference(key: NotchHeightKey.self, value: ["approval": proxy.size.height])
            })
        }
        .frame(width: width, height: controller.contentHeight("approval"))
        .padding(.top, notch.height)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("notch.approval_needed", ["summary": preview.summary]))
    }

    private var footer: some View {
        HStack(spacing: Space.s) {
            Text(controller.focused ? L("notch.keys_hint") : L("notch.focus_hint"))
            Spacer()
            if controller.queuedBehindCard > 0 {
                Text(L.count("notch.waiting", controller.queuedBehindCard))
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

// MARK: Waiting badge

/// "1 waiting" beside the notch while an approval waits behind listening or a report. Pulses slowly unless Reduce Motion is on.
struct WaitingBadge: View {
    @EnvironmentObject var strings: Strings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    let count: Int
    let height: CGFloat
    let action: () -> Void
    @State private var pulse = false

    /// One cycle every 2.5 s: well under the "at most once every 2 s" limit.
    private var pulseAnimation: Animation? {
        reduceMotion ? nil : Animation.easeInOut(duration: 1.25).repeatForever(autoreverses: true)
    }

    private var strokeOpacity: Double {
        if contrast == .increased { return 0.8 }
        return pulse && !reduceMotion ? 0.32 : 0.1
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.xs) {
                Image(systemName: "hand.raised.fill")
                    .font(.caption)
                    .foregroundStyle(Color.orange)
                Text(L.count("notch.waiting", count))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
            }
            .padding(.horizontal, Space.m)
            .frame(height: height)
            .background(NotchShape(bottomRadius: 10).fill(Color.black))
            .overlay(
                NotchShape(bottomRadius: 10)
                    .stroke(Color.white.opacity(strokeOpacity), lineWidth: 1)
                    .animation(pulseAnimation, value: pulse)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .onAppear { pulse = !reduceMotion }
        .onChange(of: reduceMotion) { value in pulse = !value }
        .accessibilityLabel(L.count("notch.waiting", count))
        .accessibilityHint(L("notch.waiting.hint"))
    }
}
