import Foundation
import XCTest

final class ScreenshotCandidateTests: XCTestCase {
    func testAcceptsRecentStableScreenshotImage() {
        let started = Date(timeIntervalSince1970: 100)
        let descriptor = fixture(createdAt: started.addingTimeInterval(1))
        let candidate = ScreenshotCandidatePolicy.candidate(
            from: descriptor, monitoringStartedAt: started,
            now: started.addingTimeInterval(2)
        )
        XCTAssertEqual(candidate?.url, descriptor.url)
    }

    func testSuppressesInitialSnapshotAndOldFiles() {
        let started = Date(timeIntervalSince1970: 100)
        XCTAssertNil(ScreenshotCandidatePolicy.candidate(
            from: fixture(createdAt: started.addingTimeInterval(-10)),
            monitoringStartedAt: started, now: started
        ))
    }

    func testRejectsNonImagesMissingEvidenceAndUnstableBytes() {
        let started = Date(timeIntervalSince1970: 100)
        XCTAssertNil(ScreenshotCandidatePolicy.candidate(
            from: fixture(createdAt: started, isImage: false),
            monitoringStartedAt: started, now: started
        ))
        XCTAssertNil(ScreenshotCandidatePolicy.candidate(
            from: fixture(createdAt: started, hasEvidence: false),
            monitoringStartedAt: started, now: started
        ))
        XCTAssertNil(ScreenshotCandidatePolicy.candidate(
            from: fixture(createdAt: started, size: 0),
            monitoringStartedAt: started, now: started
        ))
    }

    func testIdentityDeduplicatesResourceAndCreationDate() {
        let url = URL(fileURLWithPath: "/tmp/Screenshot.png")
        let date = Date(timeIntervalSince1970: 123)
        XCTAssertEqual(
            ScreenshotCandidate.identity(resourceIdentifier: "42", url: url, createdAt: date),
            ScreenshotCandidate.identity(resourceIdentifier: "42", url: url, createdAt: date)
        )
        XCTAssertNotEqual(
            ScreenshotCandidate.identity(resourceIdentifier: "42", url: url, createdAt: date),
            ScreenshotCandidate.identity(resourceIdentifier: "42", url: url, createdAt: date.addingTimeInterval(1))
        )
    }

    func testBurstLabelCoalescesCount() {
        XCTAssertEqual(ScreenshotCandidatePolicy.coalescedLabel(count: 1), "Screenshot ready")
        XCTAssertEqual(ScreenshotCandidatePolicy.coalescedLabel(count: 3), "3 screenshots ready")
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
