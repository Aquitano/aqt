import SwiftUI

/// The search overlay's panel. Keys reach it through the event tap, so the
/// frontmost app keeps key focus while it is up.
///
/// The frame is fixed. A hosting view that sized the window to its content
/// would shrink the panel to a pill, and a height that followed the result
/// count would make it jump on every keystroke.
@MainActor
final class SearchPanelController {
    private let panel: HudPanel

    init(rootView: some View) {
        panel = HudPanel(contentRect: Self.frame())
        let hosting = NSHostingView(rootView: rootView)
        hosting.sizingOptions = []
        panel.contentView = hosting
    }

    func present() {
        guard !panel.isVisible else { return }
        panel.setFrame(Self.frame(), display: true)
        panel.orderFrontRegardless()
    }

    func hide() {
        panel.orderOut(nil)
    }

    /// Centered horizontally on the screen under the pointer, top edge at 28%
    /// of its height, tall enough for a full page of results.
    private static func frame() -> NSRect {
        let width = Theme.Metrics.searchWidth
        let rowsHeight = CGFloat(Theme.Metrics.searchRows) * Theme.Metrics.rowHeight + Theme.Metrics.grid * 2
        let height = Theme.Metrics.searchHeader + rowsHeight + Theme.Metrics.searchFooter + 2
        let screen = HudPanel.pointerScreenFrame
        return NSRect(
            x: screen.midX - width / 2,
            y: screen.maxY - screen.height * 0.28 - height,
            width: width,
            height: height
        )
    }
}

struct SearchOverlayContent: View {
    let model: SearchModel
    let onSelect: (SearchModel.Item) -> Void

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
    }

    /// Raycast's command header: back chevron, then the query.
    private var header: some View {
        HStack(spacing: Theme.Metrics.grid * 1.5) {
            Image(systemName: "chevron.left")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            HStack(spacing: 2) {
                if model.query.isEmpty {
                    caret
                    Text("Search apps…")
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
        }
        .padding(.horizontal, Theme.Metrics.grid * 2.5)
        .frame(height: Theme.Metrics.searchHeader)
    }

    /// The query only changes on key events, so the caret doesn't blink.
    private var caret: some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(Color.primary)
            .frame(width: 1.5, height: 24)
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
                                onSelect(item)
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
            } else if model.query.isEmpty {
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
    let onSelect: () -> Void

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: Theme.Metrics.grid * 1.5) {
            Group {
                if let icon = iconImage {
                    Image(nsImage: icon).resizable()
                } else {
                    Image(systemName: "app.dashed")
                        .font(.system(size: 16))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: Theme.Metrics.rowIcon, height: Theme.Metrics.rowIcon)
            HStack(spacing: Theme.Metrics.grid) {
                Text(title)
                    .lineLimit(1)
                if !item.isRunning {
                    Text("Launch")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .font(.system(size: 15))
            Spacer(minLength: Theme.Metrics.grid)
            if let letter = item.letter {
                KeyTag(label: letter.uppercased())
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
        if isSelected {
            return Theme.Colors.selection
        }
        return isHovered ? Theme.Colors.hover : .clear
    }

    private var iconImage: NSImage? {
        AppIcons.icon(for: item.bundleID)
    }

    private var title: AttributedString {
        var text = AttributedString(item.title)
        let characters = text.characters
        for offset in item.matchedIndices where offset < characters.count {
            let start = characters.index(characters.startIndex, offsetBy: offset)
            let range = start ..< characters.index(after: start)
            text[range].foregroundColor = Theme.Colors.accent
            text[range].inlinePresentationIntent = .stronglyEmphasized
        }
        return text
    }
}
