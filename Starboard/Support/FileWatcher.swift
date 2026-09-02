import Foundation

/// Fires on the main queue whenever the file at `url` changes. Editors and
/// atomic writers replace the inode, so a delete or rename re-opens the path
/// instead of going quiet.
final class FileWatcher {
    private let url: URL
    private let onChange: () -> Void
    private var source: DispatchSourceFileSystemObject?

    init(url: URL, onChange: @escaping () -> Void) {
        self.url = url
        self.onChange = onChange
        open()
    }

    deinit {
        source?.cancel()
    }

    private func open() {
        let descriptor = Darwin.open(url.path, O_EVTONLY)
        guard descriptor >= 0 else {
            retryOpen()
            return
        }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .extend, .delete, .rename],
            queue: .main
        )
        source.setEventHandler { [weak self] in
            guard let self else { return }
            let replaced = !source.data.intersection([.delete, .rename]).isEmpty
            if replaced {
                source.cancel()
                self.source = nil
                self.retryOpen()
            }
            self.onChange()
        }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        self.source = source
    }

    private func retryOpen() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.open() }
    }
}
