import SwiftUI

/// The preview content of the approval card at the notch: Edit / Cancel / Send.
/// Once the card is focused, ⌘Return approves (or saves while editing) and Esc cancels. Plain Return never approves.
struct ApprovalView: View {
    let preview: Preview
    let width: CGFloat
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @State private var editing = false
    @State private var values: [String: String] = [:]
    @State private var showDetails = false

    init(preview: Preview, width: CGFloat) {
        self.preview = preview
        self.width = width
    }

    private var verb: String { L("approval.verb.\(preview.verb)") }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            if let card = preview.card, !editing {
                PreviewCardView(card: card, destructive: preview.destructive)
            } else {
                header
                Text(preview.summary)
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            if !preview.errors.isEmpty { errors }
            if preview.card == nil || editing { fields }
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
        .frame(width: width, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .onAppear {
            values = Dictionary(preview.fields.map { ($0.key, $0.text) }, uniquingKeysWith: { first, _ in first })
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
                    .keyboardShortcut(.return, modifiers: .command)
                Spacer()
                Button(L("approval.cancel")) { model.respond(preview, decision: "cancel") }
                    .buttonStyle(PressableButtonStyle())
                    .keyboardShortcut(.cancelAction)
            } else {
                if let text = preview.card?.badgeText {
                    Label(text, systemImage: PreviewCard.symbol(preview.card?.badgeIcon ?? "video"))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Button(L("approval.edit")) { editing = true }
                    .buttonStyle(PressableButtonStyle())
                    .disabled(preview.fields.isEmpty)
                    .accessibilityLabel(L("approval.edit"))
                Spacer()
                Button(L("approval.cancel")) { model.respond(preview, decision: "cancel") }
                    .buttonStyle(PressableButtonStyle())
                    .keyboardShortcut(.cancelAction)
                Button(preview.confirming ? L("approval.confirm") : verb) { model.respond(preview, decision: "approve") }
                    .buttonStyle(PressableButtonStyle(prominent: true, destructive: preview.destructive))
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityLabel(preview.confirming ? L("approval.confirm") : verb)
                    .accessibilityHint(L("notch.keys_hint"))
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
