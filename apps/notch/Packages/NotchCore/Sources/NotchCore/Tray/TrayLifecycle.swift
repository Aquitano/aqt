import Foundation

package enum TrayCollectionDeletionPolicy: Equatable, Sendable {
    case moveItemsToShelf
    case deleteItems
}

package struct TrayCollectionDeletionResult: Equatable, Sendable {
    package var collections: [TrayCollection]
    package var items: [TrayItem]
    package var itemIDsToDelete: Set<UUID>
}

package enum TrayCollectionPolicy {
    package static func deleting(
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

package struct TrayExpiryPresentation: Equatable, Sendable {
    package var label: String
    package var fractionRemaining: Double
    package var isUrgent: Bool

    package static func make(for item: TrayItem, now: Date, lifetimeDays: Int) -> Self? {
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

package enum TrayExpiryPolicy {
    package static func deadline(addedAt: Date, days: Int) -> Date? {
        days > 0 ? addedAt.addingTimeInterval(Double(days) * 86_400) : nil
    }

    package static func nearestDeadline(in items: [TrayItem], after now: Date) -> Date? {
        items.lazy.filter { !$0.isPinned }.compactMap(\.expiresAt)
            .filter { $0 > now }.min()
    }

    package static func applying(days: Int, to items: [TrayItem]) -> [TrayItem] {
        items.map { item in
            guard !item.isPinned else { return item }
            var copy = item
            copy.expiresAt = deadline(addedAt: item.addedAt, days: days)
            copy.cleanupError = nil
            return copy
        }
    }
}

package struct TrayMoveSourceDescriptor: Equatable, Sendable {
    package var isFileURL: Bool
    package var isWritable: Bool
    package var volumeIsReadOnly: Bool
    package var isUbiquitous: Bool
    package var isDownloaded: Bool

    package init(isFileURL: Bool, isWritable: Bool, volumeIsReadOnly: Bool, isUbiquitous: Bool, isDownloaded: Bool) {
        self.isFileURL = isFileURL
        self.isWritable = isWritable
        self.volumeIsReadOnly = volumeIsReadOnly
        self.isUbiquitous = isUbiquitous
        self.isDownloaded = isDownloaded
    }
}

package enum TrayMoveEligibility: Equatable, Sendable {
    case eligible
    case copyOnly

    package static func evaluate(_ source: TrayMoveSourceDescriptor) -> Self {
        guard source.isFileURL, source.isWritable, !source.volumeIsReadOnly,
              !source.isUbiquitous || source.isDownloaded else { return .copyOnly }
        return .eligible
    }
}

package enum TrayMoveOutcome: Equatable, Sendable {
    case moved
    case copiedOriginalRetained
    case failed

    package static func resolve(destinationVerified: Bool, sourceRemoved: Bool) -> Self {
        guard destinationVerified else { return .failed }
        return sourceRemoved ? .moved : .copiedOriginalRetained
    }
}
