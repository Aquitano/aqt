import Foundation
import TrackerCore

@MainActor
@Observable
final class Outbox {
    private static let capacity = 10000
    private static let flushThreshold = 100
    private static let maximumBatch = 1000
    private static let flushInterval = Duration.seconds(10)
    private static let healthInterval = Duration.seconds(30)

    private(set) var dropped = 0
    var lastError: String? {
        storageError ?? deliveryError ?? restoreError
    }

    private var storageError: String?
    private var deliveryError: String?
    private var restoreError: String?
    private(set) var serverReachable = false

    var pending: Int {
        queue.count
    }

    private var queue: [WireEvent] = []
    private var failedAttempts = 0
    private var retryAfter: Date?
    private var isFlushing = false
    private var tasks: [Task<Void, Never>] = []

    private let client: IngestClient
    private let deviceID: UUID
    private let file: OutboxFile
    private var canPersist = true

    init(configuration: TrackerConfiguration, deviceID: UUID) {
        let tokens = configuration.tokenPath.map { TokenSource(path: $0) }
        client = IngestClient(configuration: configuration, tokens: tokens)
        self.deviceID = deviceID
        file = OutboxFile(url: OutboxFile.defaultURL(deviceID: deviceID))
        switch file.restore() {
        case let .success(.events(events)):
            queue = events
        case let .success(.unreadable(error, movedTo: aside)):
            let path = (aside.path(percentEncoded: false) as NSString).abbreviatingWithTildeInPath
            restoreError = "Unreadable outbox moved to \(path)"
            Log.outbox.error(
                "unreadable outbox moved to \(path, privacy: .public): \(error.localizedDescription, privacy: .public)"
            )
        case let .failure(error):
            canPersist = false
            storageError = "Could not move unreadable outbox aside: \(error.localizedDescription)"
            Log.outbox.error("could not move unreadable outbox aside: \(error.localizedDescription, privacy: .public)")
        }
    }

    func start() {
        tasks.append(Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Outbox.flushInterval)
                await self?.flush()
            }
        })
        tasks.append(Task { [weak self] in
            while !Task.isCancelled {
                let reachable = await self?.client.health() ?? false
                self?.serverReachable = reachable
                try? await Task.sleep(for: Outbox.healthInterval)
            }
        })
    }

    func stop() {
        for task in tasks {
            task.cancel()
        }
        tasks.removeAll()
    }

    func enqueue(_ events: [WireEvent]) {
        guard !events.isEmpty else { return }
        queue.append(contentsOf: events)
        trimToCapacity()
        persist()
        guard queue.count >= Self.flushThreshold else { return }
        Task { [weak self] in await self?.flush() }
    }

    func flush() async {
        guard !isFlushing, !queue.isEmpty else { return }
        if let retryAfter, retryAfter > .now {
            return
        }
        isFlushing = true
        defer {
            isFlushing = false
            trimToCapacity()
            persist()
        }

        let events = Array(queue.prefix(Self.maximumBatch))
        switch await client.send(EventBatch(deviceID: deviceID, events: events)) {
        case let .delivered(_, serverDropped):
            queue.removeFirst(events.count)
            dropped += serverDropped
            failedAttempts = 0
            retryAfter = nil
            deliveryError = nil
            serverReachable = true
        case let .permanent(message):
            queue.removeFirst(events.count)
            dropped += events.count
            deliveryError = message
            Log.outbox.error("dropped \(events.count, privacy: .public) events: \(message, privacy: .public)")
        case let .transient(message):
            failedAttempts += 1
            retryAfter = Date.now.addingTimeInterval(Backoff.seconds(failedAttempts: failedAttempts))
            deliveryError = message
            serverReachable = false
            Log.outbox.notice("retrying after \(message, privacy: .public)")
        }
    }

    func flushOnTerminate(timeout: TimeInterval) {
        guard !queue.isEmpty else { return }
        let batch = EventBatch(deviceID: deviceID, events: Array(queue.prefix(Self.maximumBatch)))
        guard let request = try? client.batchRequest(batch, token: client.tokens?.mostRecentBearer()) else { return }
        IngestClient.sendBlocking(request, timeout: timeout)
    }

    private func persist() {
        // An unreadable queue that could not be moved aside stays for recovery, not overwritten.
        guard canPersist else { return }
        switch file.save(queue) {
        case .success:
            storageError = nil
        case let .failure(error):
            storageError = "Could not persist outbox: \(error.localizedDescription)"
            Log.outbox.error("could not persist outbox: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Never trim mid-flush: the delivered prefix is removed by count, so
    /// dropping from the front while a batch is in flight would lose the wrong
    /// events.
    private func trimToCapacity() {
        guard !isFlushing, queue.count > Self.capacity else { return }
        let overflow = queue.count - Self.capacity
        queue.removeFirst(overflow)
        dropped += overflow
        Log.outbox.error("queue full, dropped \(overflow, privacy: .public) oldest events")
    }
}
