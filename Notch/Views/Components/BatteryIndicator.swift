import SwiftUI

/// A drawn battery glyph: outline, terminal nub, a proportional fill, and a bolt
/// when charging. SF Symbols only ships fixed quarter-step battery glyphs and has
/// no `battery.<level>.bolt` variant, so drawing it ourselves is both correct and
/// lets the fill track the real percentage.
struct BatteryIndicator: View {
    let level: Int          // 0...100
    let charging: Bool
    let tint: Color

    var width: CGFloat = 26
    var height: CGFloat = 13

    private var fraction: CGFloat { min(max(CGFloat(level) / 100, 0), 1) }

    var body: some View {
        HStack(spacing: 1.5) {
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3.5, style: .continuous)
                    .stroke(.white.opacity(0.45), lineWidth: 1.2)

                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(tint)
                    .padding(2)
                    .frame(width: max(2, (width - 4) * fraction + 4))

                if charging {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 8, weight: .heavy))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .shadow(radius: 1)
                }
            }
            .frame(width: width, height: height)

            Capsule(style: .continuous)
                .fill(.white.opacity(0.45))
                .frame(width: 2, height: height * 0.42)
        }
        .animation(.snappy, value: level)
        .animation(.snappy, value: charging)
    }
}
