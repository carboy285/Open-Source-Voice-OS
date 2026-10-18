import SwiftUI

/// The approval preview drawn as a card that fits the task: a header with the app, the title with an accent rule,
/// then rows for the time, people, place or message. The core picks the layout; this only draws it.
struct PreviewCardView: View {
    let card: PreviewCard
    let destructive: Bool
    @EnvironmentObject var strings: Strings

    private var kindLabel: String {
        card.kind == "generic" || card.app.isEmpty ? card.app : L("card.kind.\(card.kind)")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header.fadeIn(0)
            VStack(alignment: .leading, spacing: Space.m) {
                titleBlock.fadeIn(1)
                ForEach(Array(card.rows.enumerated()), id: \.element.id) { index, row in
                    rowView(row).fadeIn(index + 2)
                }
            }
            .padding(Space.l)
        }
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(NotchPalette.card))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(NotchPalette.hairline, lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(spacing: Space.s) {
            Image(systemName: symbol(forIcon: card.icon))
                .font(.body)
                .foregroundStyle(destructive ? Color.red : NotchPalette.accent)
                .accessibilityHidden(true)
            Text(kindLabel)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
            Spacer()
            if card.kind != "generic", !card.app.isEmpty {
                Text(card.app).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.s + 2)
        .background(NotchPalette.band)
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(card.title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Capsule()
                .fill(destructive ? Color.red : NotchPalette.accent)
                .frame(height: 2)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private func rowView(_ row: CardRowInfo) -> some View {
        HStack(alignment: .top, spacing: Space.m) {
            Image(systemName: PreviewCard.symbol(row.icon))
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 20)
                .accessibilityHidden(true)
            switch row.style {
            case "chips":
                chips(row)
            case "body":
                Text(row.values.joined(separator: " "))
                    .font(.callout)
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
            default:
                Text(row.label.map { "\($0): \(row.values.joined(separator: ", "))" } ?? row.values.joined(separator: ", "))
                    .font(.body)
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Up to three pills, then "+N" for the rest.
    private func chips(_ row: CardRowInfo) -> some View {
        let shown = Array(row.values.prefix(3))
        let more = row.values.count - shown.count
        return HStack(spacing: Space.s - 2) {
            ForEach(shown, id: \.self) { value in chip(value) }
            if more > 0 { chip("+\(more)") }
        }
    }

    private func chip(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(NotchPalette.chipText)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, Space.m)
            .padding(.vertical, 4)
            .background(Capsule().fill(NotchPalette.chip))
    }
}
