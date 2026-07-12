import Foundation

enum TrayCollectionDeletionPolicy: Equatable, Sendable {
    case moveItemsToShelf
    case deleteItems
}

struct TrayCollectionDeletionResult: Equatable, Sendable {
    var collections: [TrayCollection]
    var items: [TrayItem]
    var itemIDsToDelete: Set<UUID>
}

enum TrayCollectionPolicy {
    static func deleting(
        collectionID: UUID,
        policy: TrayCollectionDeletionPolicy,
        collections: [TrayCollection],
        items: [TrayItem]
    ) -> TrayCollectionDeletionResult? {
        guard collectionID != TrayCollection.shelfID,
              collections.contains(where: { $0.id == collectionID }) else { return nil }
        let affected = Set(items.filter { $0.collectionID == collectionID }.map(\.id))
        let remainingCollections = collections.filter { $0.id != collectionID }
            .enumerated().map { offset, collection in
                var copy = collection
                copy.sortOrder = offset
                return copy
            }
        switch policy {
        case .moveItemsToShelf:
            return TrayCollectionDeletionResult(
                collections: remainingCollections,
                items: items.map { item in
                    guard affected.contains(item.id) else { return item }
                    var copy = item
                    copy.collectionID = TrayCollection.shelfID
                    return copy
                },
                itemIDsToDelete: []
            )
        case .deleteItems:
            return TrayCollectionDeletionResult(
                collections: remainingCollections,
                items: items.filter { !affected.contains($0.id) },
                itemIDsToDelete: affected
            )
        }
    }
}

struct TrayExpiryPresentation: Equatable, Sendable {
    var label: String
    var fractionRemaining: Double
    var isUrgent: Bool

    static func make(for item: TrayItem, now: Date, lifetimeDays: Int) -> Self? {
        guard !item.isPinned, let expiry = item.expiresAt else { return nil }
        let remaining = expiry.timeIntervalSince(now)
        let day: TimeInterval = 86_400
        let label: String
        if remaining <= 0 {
            label = item.cleanupError == true ? "cleanup retry" : "expired"
        } else if remaining < day {
            label = "expires today"
        } else {
            label = "\(Int(ceil(remaining / day)))d left"
        }
        let lifetime = max(Double(max(lifetimeDays, 1)) * day, 1)
        return Self(
            label: label,
            fractionRemaining: min(max(remaining / lifetime, 0), 1),
            isUrgent: remaining < day
        )
    }
}

enum TrayExpiryPolicy {
    static func deadline(addedAt: Date, days: Int) -> Date? {
        days > 0 ? addedAt.addingTimeInterval(Double(days) * 86_400) : nil
    }

    static func nearestDeadline(in items: [TrayItem], after now: Date) -> Date? {
        items.lazy.filter { !$0.isPinned }.compactMap(\.expiresAt)
            .filter { $0 > now }.min()
    }

    static func applying(days: Int, to items: [TrayItem]) -> [TrayItem] {
        items.map { item in
            guard !item.isPinned else { return item }
            var copy = item
            copy.expiresAt = deadline(addedAt: item.addedAt, days: days)
            copy.cleanupError = nil
            return copy
        }
    }
}

struct TrayMoveSourceDescriptor: Equatable, Sendable {
    var isFileURL: Bool
    var isWritable: Bool
    var volumeIsReadOnly: Bool
    var isUbiquitous: Bool
    var isDownloaded: Bool
}

enum TrayMoveEligibility: Equatable, Sendable {
    case eligible
    case copyOnly

    static func evaluate(_ source: TrayMoveSourceDescriptor) -> Self {
        guard source.isFileURL, source.isWritable, !source.volumeIsReadOnly,
              !source.isUbiquitous || source.isDownloaded else { return .copyOnly }
        return .eligible
    }
}

enum TrayMoveOutcome: Equatable, Sendable {
    case moved
    case copiedOriginalRetained
    case failed

    static func resolve(destinationVerified: Bool, sourceRemoved: Bool) -> Self {
        guard destinationVerified else { return .failed }
        return sourceRemoved ? .moved : .copiedOriginalRetained
    }
}
