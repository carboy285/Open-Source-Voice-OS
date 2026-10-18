import SwiftUI

/// Motion and spacing rules shared by every surface.
enum Motion {
    /// Default: critically damped, settles with no overshoot.
    static let standard = Animation.spring(response: 0.35, dampingFraction: 1.0)
    /// Side panel sliding in from its edge.
    static let panel = Animation.spring(response: 0.3, dampingFraction: 0.8)
    /// Reduce Motion: a short cross-fade instead of movement.
    static let fade = Animation.easeInOut(duration: 0.18)

    static func standard(reduceMotion: Bool) -> Animation { reduceMotion ? fade : standard }
    static func panel(reduceMotion: Bool) -> Animation { reduceMotion ? fade : panel }
}

/// 4/8 pt grid.
enum Space {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
}

/// Translucent material, or a solid fill when Reduce Transparency is on.
struct SurfaceBackground: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var cornerRadius: CGFloat = 14

    func body(content: Content) -> some View {
        content.background {
            let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            if reduceTransparency {
                shape.fill(Color(nsColor: .windowBackgroundColor))
            } else {
                shape.fill(.ultraThinMaterial)
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
        }
    }
}

extension View {
    func surface(cornerRadius: CGFloat = 14) -> some View { modifier(SurfaceBackground(cornerRadius: cornerRadius)) }
}

/// Pressed state shows on mouse-down, with no delay.
struct PressableButtonStyle: ButtonStyle {
    var prominent = false
    var destructive = false

    func makeBody(configuration: Configuration) -> some View {
        let tint: Color = destructive ? .red : .accentColor
        configuration.label
            .font(.body.weight(prominent ? .semibold : .regular))
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.s - 2)
            .foregroundStyle(prominent ? Color.white : Color.primary)
            .background {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(prominent ? tint : Color.primary.opacity(0.08))
                    .brightness(configuration.isPressed ? -0.08 : 0)
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.2, dampingFraction: 1.0), value: configuration.isPressed)
    }
}
