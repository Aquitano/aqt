import Foundation
import Testing
@testable import TrackerCore

struct WireEncodingTests {
    @Test func spanStartEncodesToTheServerWireShape() throws {
        let started = Date(timeIntervalSince1970: 1_757_000_000.25)
        let batch = try EventBatch(
            deviceID: #require(UUID(uuidString: "018f5a3c-7b21-7c8a-9f10-2b6f0c1d4e55")),
            events: [.spanStart(SpanStart(
                id: "018f5a3c-7b21-7c8a-9f10-2b6f0c1d4e56",
                startedAt: started,
                appName: "Code",
                bundleID: "com.microsoft.VSCode",
                windowTitle: "main.go — aqt"
            ))]
        )

        let data = try EventEncoding.encoder().encode(batch)
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let events = try #require(json["events"] as? [[String: Any]])

        #expect(json["device_id"] as? String == "018f5a3c-7b21-7c8a-9f10-2b6f0c1d4e55")
        #expect(events[0]["type"] as? String == "span_start")
        #expect(events[0]["id"] as? String == "018f5a3c-7b21-7c8a-9f10-2b6f0c1d4e56")
        #expect(events[0]["started_at"] as? String == "2025-09-04T15:33:20.250Z")
        #expect(events[0]["app_name"] as? String == "Code")
        #expect(events[0]["bundle_id"] as? String == "com.microsoft.VSCode")
        #expect(events[0]["window_title"] as? String == "main.go — aqt")
        #expect(Set(events[0].keys) == ["type", "id", "started_at", "app_name", "bundle_id", "window_title"])
    }
}
