import CoreServices
import Foundation

/// Recursive file-level directory watcher built on FSEvents. Push-based: the
/// callback fires (coalesced by a short latency) only when something under the
/// watched path changes, so an idle agent costs nothing.
final class DirectoryWatcher: @unchecked Sendable {

    private let path: String
    private let latency: CFTimeInterval
    private let queue = DispatchQueue(label: "com.aquitano.notch.dirwatcher")
    private var stream: FSEventStreamRef?
    private var onChange: (([String]) -> Void)?

    init(path: String, latency: CFTimeInterval = 0.2) {
        self.path = path
        self.latency = latency
    }

    func start(onChange: @escaping ([String]) -> Void) {
        queue.async { [weak self] in self?.begin(onChange) }
    }

    func stop() {
        queue.async { [weak self] in self?.end() }
    }

    deinit {
        // The stream holds an unretained pointer to self; make sure it's torn down
        // if this watcher is ever released without an explicit stop().
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }

    private func begin(_ onChange: @escaping ([String]) -> Void) {
        guard stream == nil else { return }
        self.onChange = onChange

        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil, release: nil, copyDescription: nil
        )
        let flags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagNoDefer
        )
        let callback: FSEventStreamCallback = { _, info, count, eventPaths, _, _ in
            guard let info else { return }
            let watcher = Unmanaged<DirectoryWatcher>.fromOpaque(info).takeUnretainedValue()
            let paths = (unsafeBitCast(eventPaths, to: NSArray.self) as? [String]) ?? []
            watcher.onChange?(paths)
        }

        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault, callback, &context,
            [path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            latency, flags
        ) else {
            Log.agents.error("DirectoryWatcher: FSEventStreamCreate failed for \(self.path)")
            return
        }

        FSEventStreamSetDispatchQueue(stream, queue)
        FSEventStreamStart(stream)
        self.stream = stream
    }

    private func end() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
        onChange = nil
    }
}
