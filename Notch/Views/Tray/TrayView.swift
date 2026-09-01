import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// A keyboard-capable temporary workspace. Selection changes are intentionally
/// instant: arrows, Command-click, Space, and Command-V are frequent actions and
/// should never wait for decorative motion.
struct TrayView: View {
    @Environment(TrayManager.self) private var tray
    @Environment(AppEnvironment.self) private var env
    @Environment(NotchState.self) private var state
    @Environment(Settings.self) private var settings

    @State private var selection = Set<UUID>()
    @State private var renameItem: TrayItem?
    @State private var renameText = ""
    @State private var confirmLargePaste = false
    @State private var collectionEditor: CollectionEditor?
    @State private var collectionName = ""
    @State private var collectionPendingDeletion: TrayCollection?
    @FocusState private var hasKeyboardFocus: Bool

    private let tileSize = CGSize(width: 82, height: 110)
    private let thumbSize: CGFloat = 50

    var body: some View {
        VStack(spacing: 10) {
            collectionBar
            if tray.activeItems.isEmpty { emptyHint } else { itemRow }
            toolbar
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .focusable()
        .focused($hasKeyboardFocus)
        // The container takes keyboard focus for Space/arrows/Command-V, but the
        // system focus halo reads as a bright debug rectangle around the Shelf.
        // Selection tiles already provide the visible keyboard-focus affordance.
        .focusEffectDisabled()
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
        .onChange(of: tray.activeItems.map(\.id)) { _, ids in
            selection.formIntersection(ids)
        }
        .confirmationDialog(
            "Paste a large batch into \(tray.activeCollection.name)?",
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
        .alert(collectionEditor?.title ?? "Collection", isPresented: Binding(
            get: { collectionEditor != nil },
            set: { if !$0 { collectionEditor = nil } }
        )) {
            TextField("Name", text: $collectionName)
            Button(collectionEditor?.actionTitle ?? "Save") { commitCollectionEdit() }
            Button("Cancel", role: .cancel) { collectionEditor = nil }
        }
        .confirmationDialog(
            "Delete \(collectionPendingDeletion?.name ?? "Collection")?",
            isPresented: Binding(
                get: { collectionPendingDeletion != nil },
                set: { if !$0 { collectionPendingDeletion = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Move Items to Shelf") { deletePendingCollection(.moveItemsToShelf) }
            Button("Delete Items", role: .destructive) { deletePendingCollection(.deleteItems) }
            Button("Cancel", role: .cancel) { collectionPendingDeletion = nil }
        } message: {
            Text("You can keep this collection’s items on Shelf or remove their managed copies.")
        }
    }

    private var collectionBar: some View {
        HStack(spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(tray.collections.sorted(by: { $0.sortOrder < $1.sortOrder })) { collection in
                        collectionButton(collection)
                    }
                }
            }
            Button {
                collectionName = ""
                collectionEditor = .create
            } label: {
                PixelIcon(systemName: "plus", size: 12, tint: .white.opacity(0.78))
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .help("New collection")
            .accessibilityLabel("New collection")
        }
        .frame(height: 26)
    }

    private func collectionButton(_ collection: TrayCollection) -> some View {
        let active = tray.activeCollectionID == collection.id
        return Button {
            selection.removeAll()
            tray.selectCollection(collection.id)
        } label: {
            HStack(spacing: 4) {
                Text(collection.name)
                    .font(.system(size: 11, weight: active ? .semibold : .regular))
                if tray.soonestExpiry(in: collection.id) != nil {
                    Circle().fill(.orange).frame(width: 5, height: 5)
                }
            }
            .foregroundStyle(.white.opacity(active ? 0.95 : 0.58))
            .padding(.horizontal, 9)
            .frame(height: 24)
            .background(.white.opacity(active ? 0.14 : 0.04), in: Capsule())
        }
        .buttonStyle(.plain)
        .onDrop(
            of: [UTType(importedAs: TrayDropCapabilities.internalItemIDsType)],
            isTargeted: nil
        ) { providers in
            moveInternalDrop(providers, to: collection.id)
        }
        .contextMenu {
            if collection.id != TrayCollection.shelfID {
                Button("Rename…") {
                    collectionName = collection.name
                    collectionEditor = .rename(collection.id)
                }
                Button("Move Left") { tray.reorderCollection(collection.id, by: -1) }
                Button("Move Right") { tray.reorderCollection(collection.id, by: 1) }
                Menu("New Item Expiry") {
                    Button("Use Global Setting") {
                        tray.setCollectionExpiry(collection.id, days: nil)
                    }
                    ForEach([1, 3, 7, 14, 30], id: \.self) { days in
                        Button("\(days) day\(days == 1 ? "" : "s")") {
                            tray.setCollectionExpiry(collection.id, days: days)
                        }
                    }
                }
                Divider()
                Button("Delete Collection…", role: .destructive) {
                    collectionPendingDeletion = collection
                }
            }
        }
    }

    private var emptyHint: some View {
        VStack(spacing: 8) {
            PixelIcon(systemName: "tray.and.arrow.down", size: 28,
                      tint: .white.opacity(0.55))
            Text("Drop or paste into \(tray.activeCollection.name)")
                .font(.callout)
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var itemRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHGrid(rows: [GridItem(.fixed(tileSize.height))], spacing: 10) {
                ForEach(tray.activeItems) { item in
                    tile(for: item)
                        .onDrag {
                            tray.itemProvider(
                                for: item,
                                movingIDs: selection.contains(item.id) ? selection : [item.id]
                            )
                        }
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
                    if let expiry = tray.expiryPresentation(for: item) {
                        Text(expiry.label)
                            .font(.system(size: 8, weight: expiry.isUrgent ? .semibold : .regular))
                            .foregroundStyle(expiry.isUrgent ? .orange : .secondary)
                            .lineLimit(1)
                        Capsule()
                            .fill(expiry.isUrgent ? .orange.opacity(0.8) : .white.opacity(0.32))
                            .frame(width: 54 * expiry.fractionRemaining, height: 2)
                            .frame(width: 54, alignment: .leading)
                    } else if item.isPinned {
                        Text("kept")
                            .font(.system(size: 8))
                            .foregroundStyle(.secondary)
                    }
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
            Menu {
                ForEach(tray.collections.filter { $0.id != tray.activeCollectionID }) { collection in
                    Button(collection.name) { tray.move(selectedItems, to: collection.id) }
                }
            } label: {
                PixelIcon(
                    systemName: "folder", size: 14,
                    tint: .white.opacity(selectedItems.isEmpty ? 0.28 : 0.82)
                )
                .frame(width: 28, height: 26)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .disabled(selectedItems.isEmpty || tray.collections.count < 2)
            .help("Move to collection")
            .accessibilityLabel("Move to collection")
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
        Menu("Move to Collection") {
            ForEach(tray.collections.filter { $0.id != tray.activeCollectionID }) { collection in
                Button(collection.name) { tray.move(chosen, to: collection.id) }
            }
        }
        Button("Extend 1 Day") { tray.extend(chosen, byDays: 1) }
        Button("Extend 7 Days") { tray.extend(chosen, byDays: 7) }
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
        let visible = tray.activeItems
        guard !visible.isEmpty else { return }
        let current = selection.first.flatMap { id in
            visible.firstIndex(where: { $0.id == id })
        } ?? (offset > 0 ? -1 : visible.count)
        let next = min(max(current + offset, 0), visible.count - 1)
        selection = [visible[next].id]
    }

    private func previewSelection() {
        let chosen = selectedItems.isEmpty ? Array(tray.activeItems.prefix(1)) : selectedItems
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

    private func commitCollectionEdit() {
        guard let editor = collectionEditor else { return }
        switch editor {
        case .create:
            _ = tray.createCollection(named: collectionName)
        case .rename(let id):
            _ = tray.renameCollection(id, to: collectionName)
        }
        collectionEditor = nil
    }

    private func deletePendingCollection(_ policy: TrayCollectionDeletionPolicy) {
        guard let collection = collectionPendingDeletion else { return }
        tray.deleteCollection(collection.id, policy: policy)
        collectionPendingDeletion = nil
        selection.removeAll()
    }

    private func moveInternalDrop(_ providers: [NSItemProvider], to collectionID: UUID) -> Bool {
        guard let provider = providers.first(where: {
            $0.hasItemConformingToTypeIdentifier(TrayDropCapabilities.internalItemIDsType)
        }) else { return false }
        provider.loadDataRepresentation(
            forTypeIdentifier: TrayDropCapabilities.internalItemIDsType
        ) { data, _ in
            guard let data,
                  let ids = try? JSONDecoder().decode([UUID].self, from: data) else { return }
            Task { @MainActor in
                let moved = tray.items(withIDs: Set(ids))
                tray.move(moved, to: collectionID)
                selection.subtract(ids)
            }
        }
        return true
    }

    private func thumbnail(for item: TrayItem) -> NSImage {
        tray.thumbnail(for: item) ?? NSWorkspace.shared.icon(for: item.contentType)
    }

    private var countText: String {
        if selection.isEmpty {
            let visible = tray.activeItems.count
            return tray.items.count == visible
                ? (visible == 1 ? "1 item" : "\(visible) items")
                : "\(visible) here · \(tray.items.count) total"
        }
        return "\(selection.count) selected"
    }

    private static func sizeText(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    private enum CollectionEditor: Equatable {
        case create
        case rename(UUID)

        var title: String {
            switch self {
            case .create: return "New Collection"
            case .rename: return "Rename Collection"
            }
        }

        var actionTitle: String {
            switch self {
            case .create: return "Create"
            case .rename: return "Rename"
            }
        }
    }
}
