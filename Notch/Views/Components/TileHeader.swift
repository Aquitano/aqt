import SwiftUI

/// Small uppercase-weight section label used at the top of info tiles. Keeps the
/// "quiet header, loud content" rhythm consistent across the widget grid.
struct TileHeader: View {
    let title: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage)
                .font(.system(size: 10, weight: .semibold))
            Text(title)
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(.white.opacity(0.55))
        .lineLimit(1)
        .fixedSize()
    }
}
