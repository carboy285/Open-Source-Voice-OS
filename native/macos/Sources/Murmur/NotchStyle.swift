import SwiftUI

/// Colors for the dark notch surface. The top stays pure black so the surface joins the hardware notch.
enum NotchPalette {
    static let bottom = Color(red: 0.086, green: 0.094, blue: 0.114)
    static let card = Color.white.opacity(0.055)
    static let band = Color.white.opacity(0.05)
    static let hairline = Color.white.opacity(0.10)
    static let chip = Color(red: 0.24, green: 0.31, blue: 0.47).opacity(0.55)
    static let chipText = Color(red: 0.78, green: 0.84, blue: 0.99)
    static let accent = Color(red: 0.30, green: 0.50, blue: 0.98)
}

/// The surface fill: black through the notch, easing into a deep charcoal, with a faint blue glow along the bottom edge
/// while a card is showing. Reduce Transparency and Increase Contrast get plain black.
struct NotchBackground: View {
    var notchHeight: CGFloat
    var height: CGFloat
    var glow: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        if reduceTransparency || contrast == .increased {
            Color.black
        } else {
            let fraction = height > 0 ? min(0.9, max(0, notchHeight / height)) : 0
            ZStack {
                LinearGradient(
                    stops: [
                        .init(color: .black, location: 0),
                        .init(color: .black, location: fraction),
                        .init(color: NotchPalette.bottom, location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                if glow {
                    LinearGradient(
                        colors: [.clear, NotchPalette.accent.opacity(0.30)],
                        startPoint: UnitPoint(x: 0.5, y: 0.8),
                        endPoint: .bottom
                    )
                }
            }
        }
    }
}

/// Content that fades in with a small rise and a soft blur, one item after another. With Reduce Motion it is a plain fade.
struct FadeIn: ViewModifier {
    let index: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 6)
            .blur(radius: shown || reduceMotion ? 0 : 5)
            .onAppear {
                let animation = reduceMotion ? Motion.fade : Animation.easeOut(duration: 0.38).delay(0.05 + Double(index) * 0.06)
                withAnimation(animation) { shown = true }
            }
    }
}

extension View {
    func fadeIn(_ index: Int = 0) -> some View { modifier(FadeIn(index: index)) }
}
