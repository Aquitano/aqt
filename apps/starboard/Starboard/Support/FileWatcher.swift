import Foundation

/// Fires on the main queue whenever the file at `url` changes. Editors and
/// atomic writers replace the inode, so a delete or rename re-opens the path
/// instead of going quiet.
final class FileWatcher {
    private let url: URL
    private let onChange: () -> Void
    private var source: DispatchSourceFileSystemObject?
    /// A path that isn't there yet — or was deleted and never recreated —
    /// would otherwise wake the main queue five times a second forever.
    private var retryDelay = FileWatcher.minimumRetryDelay

    private static let minimumRetryDelay: TimeInterval = 0.2
    private static let maximumRetryDelay: TimeInterval = 5

    init(url: URL, onChange: @escaping () -> Void) {
        self.url = url
        self.onChange = onChange
        open()
    }

    deinit {
        source?.cancel()
    }

    private func open() {
        guard source == nil else { return }
        let descriptor = Darwin.open(url.path, O_EVTONLY)
        guard descriptor >= 0 else {
            retryOpen()
            return
        }
        retryDelay = Self.minimumRetryDelay
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
        let delay = retryDelay
        retryDelay = min(retryDelay * 2, Self.maximumRetryDelay)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.open() }
    }
}
