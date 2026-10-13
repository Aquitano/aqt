import Foundation

/// Fires on the main queue whenever the file at `url` changes. Editors and
/// atomic writers replace the inode, so a delete or rename re-opens the path
/// instead of going quiet.
@MainActor
final class FileWatcher {
    private let url: URL
    private let onChange: () -> Void
    private var source: DispatchSourceFileSystemObject?
    private var retry: Task<Void, Never>?
    private var retryDelay = 0.5
    /// The file was replaced; whatever changed until the path re-opens was
    /// never observed.
    private var reopening = false

    init(url: URL, onChange: @escaping () -> Void) {
        self.url = url
        self.onChange = onChange
        open()
    }

    deinit {
        retry?.cancel()
        source?.cancel()
    }

    private func open() {
        guard source == nil else { return }
        let descriptor = Darwin.open(url.path, O_EVTONLY)
        guard descriptor >= 0 else {
            retryOpen()
            return
        }
        retryDelay = 0.5
        if reopening {
            reopening = false
            onChange()
        }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .extend, .delete, .rename],
            queue: .main
        )
        source.setEventHandler { [weak self] in
            guard let self else { return }
            let replaced = !source.data.isDisjoint(with: [.delete, .rename])
            if replaced {
                source.cancel()
                self.source = nil
                self.reopening = true
                self.retryOpen()
            }
            self.onChange()
        }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        self.source = source
    }

    private func retryOpen() {
        retry?.cancel()
        let delay = retryDelay
        retry = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            self?.open()
        }
        retryDelay = min(retryDelay * 2, 30)
    }
}
