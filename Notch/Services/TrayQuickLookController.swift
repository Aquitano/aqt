import QuickLookUI
import SwiftUI

@MainActor
final class TrayQuickLookController: NSObject, ObservableObject,
    @preconcurrency QLPreviewPanelDataSource,
    QLPreviewPanelDelegate {

    @Published private(set) var isVisible = false

    private var itemIDs: Set<UUID> = []
    private var previewURLs: [URL] = []
    private var onClose: (() -> Void)?

    func present(
        items: [TrayItem],
        storageRoot: URL,
        onClose: @escaping () -> Void
    ) {
        guard !items.isEmpty, let panel = QLPreviewPanel.shared() else { return }
        if isVisible { finish() }
        itemIDs = Set(items.map(\.id))
        previewURLs = items.map { $0.url(relativeTo: storageRoot) }
        self.onClose = onClose
        panel.dataSource = self
        panel.delegate = self
        panel.currentPreviewItemIndex = 0
        panel.reloadData()
        panel.makeKeyAndOrderFront(nil)
        isVisible = true
    }

    func present(urls: [URL], onClose: @escaping () -> Void) {
        guard !urls.isEmpty, let panel = QLPreviewPanel.shared() else { return }
        if isVisible { finish() }
        itemIDs = []
        previewURLs = urls
        self.onClose = onClose
        panel.dataSource = self
        panel.delegate = self
        panel.currentPreviewItemIndex = 0
        panel.reloadData()
        panel.makeKeyAndOrderFront(nil)
        isVisible = true
    }

    func close() {
        guard isVisible else { return }
        QLPreviewPanel.shared()?.orderOut(nil)
        finish()
    }

    func closeIfContains(_ ids: Set<UUID>) {
        if !itemIDs.isDisjoint(with: ids) { close() }
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int {
        previewURLs.count
    }

    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
        guard previewURLs.indices.contains(index) else { return nil }
        return previewURLs[index] as NSURL
    }

    func previewPanelWillClose(_ panel: QLPreviewPanel!) {
        finish()
    }

    private func finish() {
        guard isVisible || onClose != nil else { return }
        isVisible = false
        itemIDs = []
        previewURLs = []
        let completion = onClose
        onClose = nil
        completion?()
    }
}
