import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// The file shelf inside the expanded panel: a horizontal row of staged files
/// with outbound drag, per-item actions, and bulk AirDrop / Clear controls.
/// Lives only inside the expanded surface, so glass on the tiles is fine.
struct TrayView: View {
    @EnvironmentObject private var tray: TrayManager
    @EnvironmentObject private var env: AppEnvironment

    private let tileSize = CGSize(width: 78, height: 88)
    private let thumbSize: CGFloat = 50

    var body: some View {
        VStack(spacing: 10) {
            if tray.items.isEmpty {
                emptyHint
            } else {
                itemRow
                toolbar
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    // MARK: - Empty state

    private var emptyHint: some View {
        VStack(spacing: 8) {
            PixelIcon(systemName: "tray.and.arrow.down", size: 28,
                      tint: .white.opacity(0.55))
            Text("Drop files here")
                .font(.callout)
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Items

    private var itemRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHGrid(rows: [GridItem(.fixed(tileSize.height))], spacing: 10) {
                ForEach(tray.items) { item in
                    tile(for: item)
                        .onDrag {
                            NSItemProvider(contentsOf: tray.fileURL(for: item)) ?? NSItemProvider()
                        }
                        .contextMenu {
                            Button("AirDrop") { env.airDrop([item]) }
                            Button("Reveal in Finder") {
                                NSWorkspace.shared.activateFileViewerSelecting([tray.fileURL(for: item)])
                            }
                            Button("Remove", role: .destructive) { tray.remove(item) }
                        }
                }
            }
            .padding(.horizontal, 2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func tile(for item: DropItem) -> some View {
        VStack(spacing: 6) {
            Image(nsImage: thumbnail(for: item))
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: thumbSize, height: thumbSize)

            VStack(spacing: 1) {
                Text(item.fileName)
                    .font(.caption2)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(Self.sizeText(item.byteSize))
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(8)
        .frame(width: tileSize.width, height: tileSize.height)
        .glassEffect(.regular, in: .rect(cornerRadius: 12))
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack(spacing: 10) {
            Text(countText)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            GlassButton(systemName: "airdrop", size: 30) { env.airDrop(tray.items) }
            GlassButton(systemName: "trash", size: 30) { tray.clear() }
        }
    }

    // MARK: - Helpers

    /// Quick Look thumbnail when available, otherwise the system icon for the type.
    private func thumbnail(for item: DropItem) -> NSImage {
        tray.thumbnail(for: item) ?? NSWorkspace.shared.icon(for: item.contentType)
    }

    private var countText: String {
        tray.items.count == 1 ? "1 item" : "\(tray.items.count) items"
    }

    private static func sizeText(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}
