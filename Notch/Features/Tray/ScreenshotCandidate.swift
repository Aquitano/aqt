import Foundation

struct ScreenshotCandidate: Identifiable, Equatable, Sendable {
    let id: String
    let url: URL
    let createdAt: Date

    static func identity(resourceIdentifier: String?, url: URL, createdAt: Date) -> String {
        "\(resourceIdentifier ?? url.standardizedFileURL.path)|\(createdAt.timeIntervalSince1970)"
    }
}

struct ScreenshotFileDescriptor: Equatable, Sendable {
    let url: URL
    let resourceIdentifier: String?
    let createdAt: Date?
    let fileSize: Int?
    let isImage: Bool
    let hasScreenshotEvidence: Bool
    let isReadable: Bool
}

enum ScreenshotCandidatePolicy {
    static func candidate(
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

    static func coalescedLabel(count: Int) -> String {
        count == 1 ? "Screenshot ready" : "\(count) screenshots ready"
    }
}
