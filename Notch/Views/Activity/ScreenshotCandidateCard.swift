import SwiftUI

struct ScreenshotCandidateCard: View {
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var screenshots: ScreenshotMonitor

    var body: some View {
        HStack(spacing: 10) {
            PixelIcon(systemName: "photo", size: 18, tint: .cyan)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(ScreenshotCandidatePolicy.coalescedLabel(count: screenshots.candidates.count))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text("Nothing is copied until you add it")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.65))
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Button("Preview") { preview() }
                .buttonStyle(.borderless)
            Button("Dismiss") { screenshots.dismissAll() }
                .buttonStyle(.borderless)
            Button("Add to Shelf") { screenshots.addAllToShelf() }
                .buttonStyle(.borderedProminent)
                .tint(.white.opacity(0.2))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .glassEffect(.regular, in: .rect(cornerRadius: 14))
        .accessibilityElement(children: .contain)
    }

    private func preview() {
        env.windowController?.beginPreviewing()
        let controller = env.windowController
        screenshots.previewAll { [weak controller] in controller?.endPreviewing() }
    }
}
