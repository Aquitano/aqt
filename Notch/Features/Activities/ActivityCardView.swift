import SwiftUI

/// One activity rendered as a horizontal glass card: symbol + title + subtitle.
/// Used inside the expanded home surface and the activity cycle, so it sits on
/// content where glass is allowed (never on the black pill). Stays compact and
/// sizes to its text.
struct ActivityCardView: View {
    let activity: Activity
    var namespace: Namespace.ID? = nil

    var body: some View {
        let content = ActivityPresenter.card(for: activity.kind)

        HStack(spacing: 10) {
            PixelIcon(systemName: ActivityPresenter.symbol(for: activity.kind),
                      size: 17, tint: content.tint)
                .frame(width: 22)

            VStack(alignment: .leading, spacing: 1) {
                Text(content.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)

                if let subtitle = content.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.white.opacity(0.65))
                        .lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .combine)
    }
}
