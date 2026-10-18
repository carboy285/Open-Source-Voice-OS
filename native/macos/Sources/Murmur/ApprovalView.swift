import SwiftUI

/// Shows the first pending preview. Each new preview (or a refreshed one after Edit) replaces it in place.
struct ApprovalHost: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if let preview = model.approvals.first {
            ApprovalView(preview: preview, anchor: model.windows.approvalAnchor)
                .id("\(preview.callId)-\(preview.edited)-\(preview.confirming)-\(preview.errors.count)")
        } else {
            Color.clear.frame(width: 480, height: 1)
        }
    }
}

/// Edit / Cancel / Send. Send is the default button; Esc and closing the window cancel.
struct ApprovalView: View {
    let preview: Preview
    let anchor: UnitPoint
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var editing = false
    @State private var values: [String: String] = [:]
    @State private var appeared = false
    @State private var showDetails = false

    private var verb: String { L("approval.verb.\(preview.verb)") }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            header
            Text(preview.summary)
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if !preview.errors.isEmpty { errors }
            fields
            DisclosureGroup(L("approval.details"), isExpanded: $showDetails) {
                ScrollView {
                    Text(rawJSON)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 140)
            }
            .font(.callout)
            buttons
            Text(L("approval.expires", ["minutes": String(max(1, Int(preview.expiresAt.timeIntervalSinceNow / 60)))]))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(Space.xl)
        .padding(.top, Space.s)
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
        .surface(cornerRadius: 18)
        .scaleEffect(appeared || reduceMotion ? 1 : 0.92, anchor: anchor)
        .opacity(appeared ? 1 : 0)
        .onAppear {
            values = Dictionary(preview.fields.map { ($0.key, $0.text) }, uniquingKeysWith: { first, _ in first })
            withAnimation(Motion.standard(reduceMotion: reduceMotion)) { appeared = true }
        }
    }

    private var header: some View {
        HStack(spacing: Space.s) {
            Image(systemName: symbol(forIcon: preview.icon))
                .font(.title3)
                .foregroundStyle(preview.destructive ? Color.red : Color.accentColor)
                .accessibilityHidden(true)
            Text(preview.displayName).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            Spacer()
            if preview.edited {
                Text(L("approval.edited"))
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, Space.s)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color.accentColor.opacity(0.15)))
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(L("approval.title")): \(preview.displayName)")
    }

    private var errors: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(L("approval.errors")).font(.callout.weight(.semibold)).foregroundStyle(.red)
            ForEach(preview.errors, id: \.self) { Text($0).font(.callout).foregroundStyle(.red) }
        }
    }

    private var fields: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            ForEach(preview.fields) { field in
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(field.label).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    if editing {
                        editor(for: field)
                    } else {
                        Text(field.text.isEmpty ? "—" : field.text)
                            .font(.body)
                            .lineLimit(field.type == "longtext" ? 8 : 2)
                            .textSelection(.enabled)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder
    private func editor(for field: PreviewField) -> some View {
        let binding = Binding(get: { values[field.key] ?? "" }, set: { values[field.key] = $0 })
        if field.type == "longtext" {
            TextEditor(text: binding)
                .font(.body)
                .frame(minHeight: 90, maxHeight: 180)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.primary.opacity(0.15)))
                .accessibilityLabel(field.label)
        } else {
            TextField(field.label, text: binding)
                .textFieldStyle(.roundedBorder)
                .accessibilityLabel(field.label)
            if field.type == "recipients" {
                Text(L("approval.recipients_hint")).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var buttons: some View {
        HStack(spacing: Space.s) {
            if editing {
                Button(L("approval.save")) { save() }
                    .buttonStyle(PressableButtonStyle(prominent: true))
                    .keyboardShortcut(.defaultAction)
                Spacer()
                Button(L("approval.cancel")) { model.respond(preview, decision: "cancel") }
                    .buttonStyle(PressableButtonStyle())
                    .keyboardShortcut(.cancelAction)
            } else {
                Button(L("approval.edit")) { editing = true }
                    .buttonStyle(PressableButtonStyle())
                    .disabled(preview.fields.isEmpty)
                Spacer()
                Button(L("approval.cancel")) { model.respond(preview, decision: "cancel") }
                    .buttonStyle(PressableButtonStyle())
                    .keyboardShortcut(.cancelAction)
                Button(preview.confirming ? L("approval.confirm") : verb) { model.respond(preview, decision: "approve") }
                    .buttonStyle(PressableButtonStyle(prominent: true, destructive: preview.destructive))
                    .keyboardShortcut(.defaultAction)
                    .accessibilityHint(preview.destructive ? L("approval.confirm") : "")
            }
        }
    }

    /// Sends edited values back; the core validates them and shows the preview again.
    private func save() {
        var input = preview.raw
        for field in preview.fields {
            let text = values[field.key] ?? ""
            if field.value is [Any] {
                input[field.key] = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            } else {
                input[field.key] = text
            }
        }
        editing = false
        model.respond(preview, decision: "edit", input: input)
    }

    private var rawJSON: String {
        guard let data = try? JSONSerialization.data(withJSONObject: preview.raw, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return "" }
        return text
    }
}
