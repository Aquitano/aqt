import SwiftUI

/// Nonactivating fuzzy-search overlay. Input arrives via the event tap, never
/// through the panel — the frontmost app keeps key focus (BATTLEPLAN Phase 3).
///
/// The panel's frame is owned here and fixed: the hosting view must never
/// auto-size the window (that collapses the HUD to its intrinsic size — the
/// "squished pill" bug), and a height that tracked the result count would make
/// the window jump on every keystroke.
final class SearchPanelController {
    /// The panel is always sized for a full page of results.
    private static let visibleRows = 8

    private let panel: HudPanel
    private var shown = false

    init(content: NSView) {
        panel = HudPanel(contentRect: Self.frame())
        panel.contentView = content
    }

    /// Shows the panel. Appearance is instant — the caller decides when the
    /// overlay is due (AppSwitcher's hold timer); a fade behind a keystroke
    /// would only read as lag.
    func present() {
        guard !shown else { return }
        panel.setFrame(Self.frame(), display: true)
        shown = true
        panel.alphaValue = 1
        panel.orderFrontRegardless()
    }

    func hide() {
        guard shown else { return }
        shown = false
        panel.orderOut(nil)
    }

    /// Centered horizontally on the screen under the pointer, top edge at 28%
    /// of its height, tall enough for a full page of results.
    private static func frame() -> NSRect {
        let width = Theme.Metrics.searchWidth
        let rowsHeight = CGFloat(visibleRows) * (Theme.Metrics.rowHeight + 2) + Theme.Metrics.grid * 2
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
            HStack(spacing: 3) {
                Text(model.query.isEmpty ? placeholder : model.query)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(model.query.isEmpty ? .secondary : .primary)
                    .lineLimit(1)
                // Static caret: the field is a real input, but it is driven by
                // the event tap, so a blink would only be noise.
                if !model.query.isEmpty {
                    RoundedRectangle(cornerRadius: 0.75)
                        .fill(Theme.Colors.accent)
                        .frame(width: 1.5, height: 18)
                }
            }
            Spacer()
            Text(model.scope == .windows ? "WINDOWS" : "APPS")
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.6)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(Capsule().fill(Color.white.opacity(0.08)))
                .foregroundStyle(.secondary)
            if model.selectedItem != nil {
                Text("release ⌘ to open")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, Theme.Metrics.grid * 2.5)
        .frame(height: 52)
    }

    private var placeholder: String {
        model.scope == .windows ? "Type to filter windows…" : "Type to search, or press a letter"
    }

    @ViewBuilder
    private var results: some View {
        if model.items.isEmpty {
            Text("No matches")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .frame(height: 64)
        } else {
            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    LazyVStack(spacing: 2) {
                        ForEach(Array(model.items.enumerated()), id: \.element.id) { index, item in
                            SearchResultRow(item: item, isSelected: index == model.selectedIndex) {
                                model.commit(item)
                            }
                            .id(item.id)
                        }
                    }
                    .padding(Theme.Metrics.grid)
                }
                .onChange(of: model.selectedIndex) { _, newValue in
                    if let newValue, model.items.indices.contains(newValue) {
                        // No anchor: scroll the minimum needed to reveal the row.
                        withAnimation(nil) { proxy.scrollTo(model.items[newValue].id) }
                    }
                }
            }
        }
    }
}

struct SearchResultRow: View {
    let item: SearchModel.Item
    let isSelected: Bool
    var onSelect: () -> Void = {}

    @State private var isHovered = false

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
                .fill(rowBackground)
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
        .onHover { isHovered = $0 }
        .onTapGesture(perform: onSelect)
    }

    private var rowBackground: Color {
        if isSelected { return Theme.Colors.selection }
        return isHovered ? Color.primary.opacity(0.06) : .clear
    }

    @MainActor
    private var iconImage: NSImage? {
        item.iconBundleID.flatMap(AppIcons.icon(for:))
    }
}
