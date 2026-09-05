import Foundation

package struct ScreenshotCandidate: Identifiable, Equatable, Sendable {
    package let id: String
    package let url: URL
    package let createdAt: Date

    package static func identity(resourceIdentifier: String?, url: URL, createdAt: Date) -> String {
        "\(resourceIdentifier ?? url.standardizedFileURL.path)|\(createdAt.timeIntervalSince1970)"
    }
}

package struct ScreenshotFileDescriptor: Equatable, Sendable {
    package let url: URL
    package let resourceIdentifier: String?
    package let createdAt: Date?
    package let fileSize: Int?
    package let isImage: Bool
    package let hasScreenshotEvidence: Bool
    package let isReadable: Bool

    package init(
        url: URL,
        resourceIdentifier: String? = nil,
        createdAt: Date? = nil,
        fileSize: Int? = nil,
        isImage: Bool,
        hasScreenshotEvidence: Bool,
        isReadable: Bool
    ) {
        self.url = url
        self.resourceIdentifier = resourceIdentifier
        self.createdAt = createdAt
        self.fileSize = fileSize
        self.isImage = isImage
        self.hasScreenshotEvidence = hasScreenshotEvidence
        self.isReadable = isReadable
    }
}

package enum ScreenshotCandidatePolicy {
    package static func candidate(
        from descriptor: ScreenshotFileDescriptor,
        monitoringStartedAt: Date,
        now: Date,
        maximumAge: TimeInterval = 30
    ) -> ScreenshotCandidate? {
        guard descriptor.isImage,
              descriptor.hasScreenshotEvidence,
              descriptor.isReadable,
              (descriptor.fileSize ?? 0) > 0,
              let createdAt = descriptor.createdAt,
              createdAt >= monitoringStartedAt.addingTimeInterval(-1),
              now.timeIntervalSince(createdAt) >= 0,
              now.timeIntervalSince(createdAt) <= maximumAge else { return nil }
        return ScreenshotCandidate(
            id: ScreenshotCandidate.identity(
                resourceIdentifier: descriptor.resourceIdentifier,
                url: descriptor.url,
                createdAt: createdAt
            ),
            url: descriptor.url,
            createdAt: createdAt
        )
    }

    package static func coalescedLabel(count: Int) -> String {
        count == 1 ? "Screenshot ready" : "\(count) screenshots ready"
    }
}
