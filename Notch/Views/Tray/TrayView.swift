import AppKit
import SwiftUI

/// A keyboard-capable temporary workspace. Selection changes are intentionally
/// instant: arrows, Command-click, Space, and Command-V are frequent actions and
/// should never wait for decorative motion.
struct TrayView: View {
    @EnvironmentObject private var tray: TrayManager
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var state: NotchState
    @EnvironmentObject private var settings: Settings

    @State private var selection = Set<UUID>()
    @State private var renameItem: TrayItem?
    @State private var renameText = ""
    @State private var confirmLargePaste = false
    @FocusState private var hasKeyboardFocus: Bool

    private let tileSize = CGSize(width: 82, height: 96)
    private let thumbSize: CGFloat = 50

    var body: some View {
        VStack(spacing: 10) {
            if tray.items.isEmpty { emptyHint } else { itemRow }
            toolbar
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .focusable()
        .focused($hasKeyboardFocus)
        .onKeyPress(.space) {
            previewSelection()
            return .handled
        }
        .onKeyPress(.leftArrow) {
            moveSelection(by: -1)
            return .handled
        }
        .onKeyPress(.rightArrow) {
            moveSelection(by: 1)
            return .handled
        }
        .onKeyPress(.escape) {
            if tray.quickLook.isVisible {
                tray.quickLook.close()
            } else {
                state.collapseImmediately()
            }
            return .handled
        }
        .onAppear {
            env.windowController?.beginTrayInteraction()
            Task { @MainActor in
                await Task.yield()
                hasKeyboardFocus = true
            }
        }
        .onDisappear {
            tray.quickLook.close()
            env.windowController?.endTrayInteraction()
        }
        .onChange(of: tray.items.map(\.id)) { _, ids in
            selection.formIntersection(ids)
        }
        .confirmationDialog(
            "Paste a large batch into Shelf?",
            isPresented: $confirmLargePaste,
            titleVisibility: .visible
        ) {
            Button("Paste") { tray.pasteFromClipboard() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Notch will copy the content into its managed temporary storage.")
        }
        .alert("Rename Item", isPresented: Binding(
            get: { renameItem != nil },
            set: { if !$0 { renameItem = nil } }
        )) {
            TextField("Name", text: $renameText)
            Button("Rename") {
                if let item = renameItem { tray.rename(item, to: renameText) }
                renameItem = nil
            }
            Button("Cancel", role: .cancel) { renameItem = nil }
        }
    }

    private var emptyHint: some View {
        VStack(spacing: 8) {
            PixelIcon(systemName: "tray.and.arrow.down", size: 28,
                      tint: .white.opacity(0.55))
            Text("Drop or paste files, images, links, and text")
                .font(.callout)
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var itemRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHGrid(rows: [GridItem(.fixed(tileSize.height))], spacing: 10) {
                ForEach(tray.items) { item in
                    tile(for: item)
                        .onDrag { tray.itemProvider(for: item) }
                        .contextMenu { contextMenu(for: item) }
                }
            }
            .padding(.horizontal, 2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func tile(for item: TrayItem) -> some View {
        let selected = selection.contains(item.id)
        return Button {
            select(item, toggling: NSEvent.modifierFlags.contains(.command))
        } label: {
            VStack(spacing: 6) {
                Image(nsImage: thumbnail(for: item))
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: thumbSize, height: thumbSize)

                VStack(spacing: 1) {
                    Text(item.displayName)
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
            .background(.white.opacity(selected ? 0.16 : 0.04), in: .rect(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(selected ? .white.opacity(0.72) : .white.opacity(0.10), lineWidth: 1)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .simultaneousGesture(TapGesture(count: 2).onEnded {
            select(item, toggling: false)
            tray.open(item)
        })
        .accessibilityLabel("\(item.displayName), \(item.kind.rawValue)")
        .accessibilityValue(selected ? "Selected" : "Not selected")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            Text(countText)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 4)
            actionButton("doc.on.clipboard", label: "Paste", disabled: false) {
                if tray.clipboardRequiresConfirmation() {
                    confirmLargePaste = true
                } else {
                    tray.pasteFromClipboard()
                }
            }
            .keyboardShortcut("v", modifiers: .command)
            actionButton("eye", label: "Quick Look", disabled: selectedItems.isEmpty) {
                previewSelection()
            }
            actionButton("arrow.up.forward.app", label: "Open", disabled: selectedItems.isEmpty) {
                selectedItems.forEach(tray.open)
            }
            actionButton(settings.shareMethod.symbol, label: "Share", disabled: selectedItems.isEmpty) {
                shareSelection()
            }
            actionButton("trash", label: "Remove", disabled: selectedItems.isEmpty) {
                removeSelection()
            }
        }
    }

    private func actionButton(
        _ symbol: String,
        label: String,
        disabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            PixelIcon(
                systemName: symbol, size: 14,
                tint: .white.opacity(disabled ? 0.28 : 0.82)
            )
            .frame(width: 28, height: 26)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .help(label)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func contextMenu(for item: TrayItem) -> some View {
        let chosen = contextSelection(for: item)
        Button("Quick Look") { preview(chosen) }
        Button(item.kind == .url ? "Open Link" : "Open") { chosen.forEach(tray.open) }
        Button("Reveal in Finder") {
            NSWorkspace.shared.activateFileViewerSelecting(chosen.map(tray.fileURL))
        }
        Divider()
        Button("Compress") { tray.compress(chosen) }
        Button(chosen.count == 1 ? "Copy Path" : "Copy Paths") { tray.copyPaths(chosen) }
        if chosen.contains(where: { $0.kind == .text || $0.kind == .url }) {
            Button("Copy Content") { tray.copyContent(chosen) }
        }
        if chosen.count == 1, let only = chosen.first {
            Button("Rename…") { beginRename(only) }
        }
        Button("Share") { share(chosen) }
        let allPinned = chosen.allSatisfy(\.isPinned)
        Button(allPinned ? "Unpin" : "Keep Indefinitely") {
            tray.setPinned(chosen, pinned: !allPinned)
        }
        Divider()
        Button("Remove", role: .destructive) {
            tray.remove(chosen)
            selection.subtract(chosen.map(\.id))
        }
    }

    private var selectedItems: [TrayItem] {
        tray.items(withIDs: selection)
    }

    private func contextSelection(for item: TrayItem) -> [TrayItem] {
        selection.contains(item.id) ? selectedItems : [item]
    }

    private func select(_ item: TrayItem, toggling: Bool) {
        if toggling {
            if !selection.insert(item.id).inserted { selection.remove(item.id) }
        } else {
            selection = [item.id]
        }
        hasKeyboardFocus = true
    }

    private func moveSelection(by offset: Int) {
        guard !tray.items.isEmpty else { return }
        let current = selection.first.flatMap { id in
            tray.items.firstIndex(where: { $0.id == id })
        } ?? (offset > 0 ? -1 : tray.items.count)
        let next = min(max(current + offset, 0), tray.items.count - 1)
        selection = [tray.items[next].id]
    }

    private func previewSelection() {
        let chosen = selectedItems.isEmpty ? Array(tray.items.prefix(1)) : selectedItems
        preview(chosen)
    }

    private func preview(_ items: [TrayItem]) {
        guard !items.isEmpty else { return }
        env.windowController?.beginPreviewing()
        let controller = env.windowController
        tray.quickLook.present(items: items, storageRoot: tray.storageRoot) { [weak controller] in
            controller?.endPreviewing()
        }
    }

    private func shareSelection() { share(selectedItems) }

    private func share(_ items: [TrayItem]) {
        guard !items.isEmpty else { return }
        tray.quickLook.close()
        env.share(items: items.map(shareRepresentation), via: settings.shareMethod)
    }

    private func shareRepresentation(_ item: TrayItem) -> Any {
        switch item.kind {
        case .url:
            if let raw = item.sourceURL, let url = URL(string: raw) { return url }
            return tray.fileURL(for: item)
        case .text:
            return item.text ?? tray.fileURL(for: item)
        case .file, .image:
            return tray.fileURL(for: item)
        }
    }

    private func removeSelection() {
        let chosen = selectedItems
        tray.remove(chosen)
        selection.subtract(chosen.map(\.id))
    }

    private func beginRename(_ item: TrayItem) {
        renameText = item.displayName
        renameItem = item
    }

    private func thumbnail(for item: TrayItem) -> NSImage {
        tray.thumbnail(for: item) ?? NSWorkspace.shared.icon(for: item.contentType)
    }

    private var countText: String {
        if selection.isEmpty {
            return tray.items.count == 1 ? "1 item" : "\(tray.items.count) items"
        }
        return "\(selection.count) selected"
    }

    private static func sizeText(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}
