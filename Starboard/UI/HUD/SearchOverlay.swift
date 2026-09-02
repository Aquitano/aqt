import SwiftUI

/// Nonactivating fuzzy-search overlay. Input arrives via the event tap, never
/// through the panel — the frontmost app keeps key focus (BATTLEPLAN Phase 3).
///
/// The panel's frame is owned here and fixed: the hosting view must never
/// auto-size the window (that collapses the HUD to its intrinsic size — the
/// "squished pill" bug), and a height that tracked the result count would make
/// the window jump on every keystroke.
final class SearchPanelController {
    private let panel: HudPanel
    private(set) var shown = false

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
        let rowsHeight = CGFloat(Theme.Metrics.searchRows) * Theme.Metrics.rowHeight + Theme.Metrics.grid * 2
        let height = Theme.Metrics.searchHeader + rowsHeight + Theme.Metrics.searchFooter + 2
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
                .frame(maxHeight: .infinity, alignment: .top)
            Divider().overlay(Theme.Colors.stroke)
            footer
        }
        .frame(width: Theme.Metrics.searchWidth)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(SurfaceBackground())
        .clipShape(RoundedRectangle(cornerRadius: Theme.Metrics.panelRadius))
        .themeAccessibility()
    }

    /// Raycast's command header: back chevron, the query as large plain text
    /// with a static caret, the scope as a trailing dropdown-looking label.
    private var header: some View {
        HStack(spacing: Theme.Metrics.grid * 1.5) {
            Image(systemName: "chevron.left")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            HStack(spacing: 2) {
                if model.query.isEmpty {
                    caret
                    Text(placeholder)
                        .foregroundStyle(.tertiary)
                } else {
                    Text(model.query)
                        .foregroundStyle(.primary)
                    caret
                }
            }
            .font(.system(size: 22, weight: .regular))
            .lineLimit(1)
            Spacer(minLength: Theme.Metrics.grid)
            HStack(spacing: 6) {
                Text(model.scope == .windows ? "Windows" : "Apps")
                    .font(.system(size: 14, weight: .regular))
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, Theme.Metrics.grid * 2.5)
        .frame(height: Theme.Metrics.searchHeader)
    }

    /// Static: the field is a real input, but it is driven by the event tap,
    /// so a blink would only be noise.
    private var caret: some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(Color.primary)
            .frame(width: 1.5, height: 24)
    }

    private var placeholder: String {
        model.scope == .windows ? "Search windows…" : "Search apps and windows…"
    }

    @ViewBuilder
    private var results: some View {
        if model.items.isEmpty {
            Text("No matches")
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .frame(height: 64)
        } else {
            ScrollViewReader { proxy in
                ScrollView(showsIndicators: false) {
                    LazyVStack(spacing: 0) {
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

    /// Raycast's action bar: the command identity leading, the primary action
    /// with its key trailing.
    private var footer: some View {
        HStack(spacing: Theme.Metrics.grid) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 18, height: 18)
            Text("Starboard")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
            Spacer()
            if model.selectedItem != nil {
                Text("Focus")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.primary)
                KeyTag(label: "release ⌘")
            } else if model.query.isEmpty, model.scope == .apps {
                Text("Press a letter, or type to search")
                    .font(.system(size: 13))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, Theme.Metrics.grid * 2)
        .frame(height: Theme.Metrics.searchFooter)
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
                        .font(.system(size: 16))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: Theme.Metrics.rowIcon, height: Theme.Metrics.rowIcon)
            HStack(spacing: Theme.Metrics.grid) {
                if let attributed = item.attributedTitle {
                    Text(attributed)
                        .lineLimit(1)
                } else {
                    Text(item.title)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
                if let attributedSub = item.attributedSubtitle {
                    Text(attributedSub)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if let subtitle = item.subtitle {
                    Text(subtitle)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .font(.system(size: 15))
            Spacer(minLength: Theme.Metrics.grid)
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
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
        .onTapGesture(perform: onSelect)
    }

    private var rowBackground: Color {
        if isSelected { return Theme.Colors.selection }
        return isHovered ? Theme.Colors.hover : .clear
    }

    @MainActor
    private var iconImage: NSImage? {
        item.iconBundleID.flatMap(AppIcons.icon(for:))
    }
}
