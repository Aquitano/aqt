import Foundation
@testable import NotchCore
import Testing

struct ScreenshotCandidateTests {
    @Test func acceptsRecentStableScreenshotImage() {
        let started = Date(timeIntervalSince1970: 100)
        let descriptor = fixture(createdAt: started.addingTimeInterval(1))
        let candidate = ScreenshotCandidatePolicy.candidate(
            from: descriptor, monitoringStartedAt: started,
            now: started.addingTimeInterval(2)
        )
        #expect(candidate?.url == descriptor.url)
    }

    @Test func suppressesInitialSnapshotAndOldFiles() {
        let started = Date(timeIntervalSince1970: 100)
        #expect(ScreenshotCandidatePolicy.candidate(
            from: fixture(createdAt: started.addingTimeInterval(-10)),
            monitoringStartedAt: started, now: started
        ) == nil)
    }

    @Test func rejectsNonImagesMissingEvidenceAndUnstableBytes() {
        let started = Date(timeIntervalSince1970: 100)
        #expect(ScreenshotCandidatePolicy.candidate(
            from: fixture(createdAt: started, isImage: false),
            monitoringStartedAt: started, now: started
        ) == nil)
        #expect(ScreenshotCandidatePolicy.candidate(
            from: fixture(createdAt: started, hasEvidence: false),
            monitoringStartedAt: started, now: started
        ) == nil)
        #expect(ScreenshotCandidatePolicy.candidate(
            from: fixture(createdAt: started, size: 0),
            monitoringStartedAt: started, now: started
        ) == nil)
    }

    @Test func identityDeduplicatesResourceAndCreationDate() {
        let url = URL(fileURLWithPath: "/tmp/Screenshot.png")
        let date = Date(timeIntervalSince1970: 123)
        #expect(
            ScreenshotCandidate.identity(resourceIdentifier: "42", url: url, createdAt: date)
                == ScreenshotCandidate.identity(resourceIdentifier: "42", url: url, createdAt: date)
        )
        #expect(
            ScreenshotCandidate.identity(resourceIdentifier: "42", url: url, createdAt: date)
                != ScreenshotCandidate.identity(
                    resourceIdentifier: "42",
                    url: url,
                    createdAt: date.addingTimeInterval(1)
                )
        )
    }

    @Test func burstLabelCoalescesCount() {
        #expect(ScreenshotCandidatePolicy.coalescedLabel(count: 1) == "Screenshot ready")
        #expect(ScreenshotCandidatePolicy.coalescedLabel(count: 3) == "3 screenshots ready")
    }

    private func fixture(
        createdAt: Date, isImage: Bool = true,
        hasEvidence: Bool = true, size: Int = 10
    ) -> ScreenshotFileDescriptor {
        ScreenshotFileDescriptor(
            url: URL(fileURLWithPath: "/tmp/Screenshot.png"),
            resourceIdentifier: "resource", createdAt: createdAt,
            fileSize: size, isImage: isImage,
            hasScreenshotEvidence: hasEvidence, isReadable: true
        )
    }
}
