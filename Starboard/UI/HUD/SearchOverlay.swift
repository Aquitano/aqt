import SwiftUI

/// Nonactivating fuzzy-search overlay. Input arrives via the event tap, never
/// through the panel — the frontmost app keeps key focus (BATTLEPLAN Phase 3).
final class SearchPanelController {
    private let panel: HudPanel

    init(content: NSView) {
        let screen = HudPanel.mainScreenBounds
        panel = HudPanel(
            contentRect: Self.frame(screen: screen, width: Theme.Metrics.searchWidth, height: 420)
        )
        panel.hasShadow = true
        // Soft shadow per design system: radius 40, y 16.
        panel.contentView = content
    }

    func show() {
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }
    }

    func hide() {
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.1
            panel.animator().alphaValue = 0
        }, completionHandler: { self.panel.orderOut(nil) })
    }

    /// Centered horizontally, top edge at 28% of screen height.
    private static func frame(screen: NSRect, width: CGFloat, height: CGFloat) -> NSRect {
        NSRect(
            x: screen.midX - width / 2,
            y: screen.maxY - screen.height * 0.28 - height,
            width: width,
            height: height
        )
    }
}

struct SearchOverlayContent: View {
    @State var model: SearchModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Theme.Metrics.grid * 1.5) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                Spacer()
                Text("release ⌘ to switch")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, Theme.Metrics.grid * 2.5)
            .frame(height: 48)

            Divider().overlay(Theme.Colors.stroke)

            if model.items.isEmpty {
                Text("No matches")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(Theme.Metrics.grid * 3)
            } else {
                ScrollViewReader { proxy in
                    ScrollView(showsIndicators: false) {
                        LazyVStack(spacing: 2) {
                            ForEach(Array(model.items.enumerated()), id: \.element.id) { index, item in
                                SearchResultRow(item: item, isSelected: index == model.selectedIndex)
                                    .id(item.id)
                            }
                        }
                        .padding(Theme.Metrics.grid)
                    }
                    .onChange(of: model.selectedIndex) { _, newValue in
                        if let id = model.items.indices.contains(newValue) ? model.items[newValue].id : nil {
                            withAnimation(nil) { proxy.scrollTo(id, anchor: .center) }
                        }
                    }
                }
            }
        }
        .frame(height: 420, alignment: .top)
        .background(SurfaceBackground())
        .clipShape(RoundedRectangle(cornerRadius: Theme.Metrics.panelRadius))
    }
}

struct SearchResultRow: View {
    let item: SearchModel.Item
    let isSelected: Bool

    var body: some View {
        HStack(spacing: Theme.Metrics.grid * 1.5) {
            if let icon = iconImage {
                Image(nsImage: icon)
                    .resizable()
                    .frame(width: 28, height: 28)
            }
            Text(item.name)
                .font(.system(size: 13))
                .lineLimit(1)
            Spacer()
            if let letter = item.letter {
                KeyCap(character: letter)
            }
        }
        .padding(.horizontal, Theme.Metrics.grid * 1.5)
        .frame(height: Theme.Metrics.rowHeight)
        .background(
            RoundedRectangle(cornerRadius: Theme.Metrics.rowRadius)
                .fill(isSelected ? Theme.Colors.selection : .clear)
        )
        .overlay(alignment: .leading) {
            if isSelected {
                Capsule()
                    .fill(Theme.Colors.accent)
                    .frame(width: 2)
                    .padding(.vertical, 8)
            }
        }
        .contentShape(Rectangle())
    }

    private var iconImage: NSImage? {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: item.bundleID) else {
            return nil
        }
        return NSWorkspace.shared.icon(forFile: url.path)
    }
}
