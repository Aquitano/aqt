import SwiftUI

/// Nonactivating fuzzy-search overlay. Input arrives via the event tap, never
/// through the panel — the frontmost app keeps key focus (BATTLEPLAN Phase 3).
///
/// The panel's frame is owned here and driven by the row count; the hosting
/// view must never auto-size the window (that collapses the HUD to its
/// intrinsic size — the "squished pill" bug).
final class SearchPanelController {
    private let panel: HudPanel
    private var pendingShow: DispatchWorkItem?
    private var shown = false

    init(content: NSView) {
        panel = HudPanel(contentRect: NSRect(x: 0, y: 0, width: Theme.Metrics.searchWidth, height: 120))
        panel.contentView = content
    }

    /// Shows (or resizes) the panel for `rowCount` results. `delayed` postpones
    /// the first appearance slightly — a quick rcmd+letter switch shouldn't
    /// flash the overlay, but holding with intent gets feedback fast.
    func present(rowCount: Int, delayed: Bool) {
        pendingShow?.cancel()
        let frame = Self.frame(rowCount: rowCount)

        if shown {
            panel.setFrame(frame, display: true)
            return
        }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.panel.setFrame(frame, display: true)
            self.shown = true
            self.panel.alphaValue = 0
            self.panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                self.panel.animator().alphaValue = 1
            }
        }
        pendingShow = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (delayed ? 0.3 : 0), execute: work)
    }

    func hide() {
        pendingShow?.cancel()
        pendingShow = nil
        guard shown else { return }
        shown = false
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.1
            panel.animator().alphaValue = 0
        }, completionHandler: { self.panel.orderOut(nil) })
    }

    /// Centered horizontally, top edge at 28% of screen height; height follows
    /// the results (capped at 8 rows) so there is no dead space below.
    private static func frame(rowCount: Int) -> NSRect {
        let width = Theme.Metrics.searchWidth
        let rowsHeight: CGFloat = rowCount == 0
            ? 64
            : CGFloat(min(rowCount, 8)) * (Theme.Metrics.rowHeight + 2) + Theme.Metrics.grid * 2
        let height = 52 + rowsHeight
        let screen = HudPanel.mainScreenBounds
        return NSRect(
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
            header
            Divider().overlay(Theme.Colors.stroke)
            results
        }
        .frame(width: Theme.Metrics.searchWidth)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(SurfaceBackground())
        .clipShape(RoundedRectangle(cornerRadius: Theme.Metrics.panelRadius))
        .themeAccessibility()
    }

    /// Raycast-style search field: the typed query is the hero, with the scope
    /// and the release hint as quiet trailing details.
    private var header: some View {
        HStack(spacing: Theme.Metrics.grid * 1.5) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.secondary)
            Text(model.query.isEmpty ? placeholder : model.query)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(model.query.isEmpty ? .secondary : .primary)
                .lineLimit(1)
            Spacer()
            Text(model.scope == .windows ? "WINDOWS" : "APPS")
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.6)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(Capsule().fill(Color.white.opacity(0.08)))
                .foregroundStyle(.secondary)
            Text("release ⌘ to open")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, Theme.Metrics.grid * 2.5)
        .frame(height: 52)
    }

    private var placeholder: String {
        model.scope == .windows ? "Type to filter windows…" : "Type to search…"
    }

    @ViewBuilder
    private var results: some View {
        if model.items.isEmpty {
            Text("No matches")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
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
}

struct SearchResultRow: View {
    let item: SearchModel.Item
    let isSelected: Bool

    var body: some View {
        HStack(spacing: Theme.Metrics.grid * 1.5) {
            Group {
                if let icon = iconImage {
                    Image(nsImage: icon).resizable()
                } else {
                    Image(systemName: "macwindow")
                        .font(.system(size: 20))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .font(.system(size: 13))
                    .lineLimit(1)
                if let subtitle = item.subtitle {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            if isSelected {
                Text("⏎")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.tertiary)
            }
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
        guard let bundleID = item.iconBundleID,
              let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else {
            return nil
        }
        return NSWorkspace.shared.icon(forFile: url.path)
    }
}
