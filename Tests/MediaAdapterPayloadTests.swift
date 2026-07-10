import XCTest

final class MediaAdapterPayloadTests: XCTestCase {

    func testDecodesPinnedBridgeFrameAndConvertsMicroseconds() throws {
        let json = #"""
        {
          "type": "data",
          "diff": false,
          "payload": {
            "title": "A Song",
            "artist": "An Artist",
            "album": "An Album",
            "isPlaying": true,
            "durationMicros": 240000000,
            "elapsedTimeMicros": 12500000,
            "timestampEpochMicros": 100000000,
            "playbackRate": 1,
            "applicationName": "Safari",
            "bundleIdentifier": "com.apple.Safari",
            "artworkDataBase64": "aGVsbG8="
          }
        }
        """#

        let envelope = try JSONDecoder().decode(MediaAdapterEnvelope.self, from: Data(json.utf8))
        let payload = try XCTUnwrap(envelope.payload)
        let track = payload.track(at: Date(timeIntervalSince1970: 102))

        XCTAssertEqual(envelope.type, "data")
        XCTAssertEqual(track.title, "A Song")
        XCTAssertEqual(track.duration, 240)
        XCTAssertEqual(track.elapsed, 14.5, accuracy: 0.001)
        XCTAssertTrue(track.isPlaying)
        XCTAssertEqual(track.bundleIdentifier, "com.apple.Safari")
        XCTAssertEqual(track.appName, "Safari")
        XCTAssertEqual(payload.artworkData, Data("hello".utf8))
    }

    func testPausedFrameDoesNotExtrapolateElapsedTime() throws {
        let json = #"""
        {"type":"data","payload":{
          "title":"Paused","isPlaying":false,"elapsedTimeMicros":7000000,
          "timestampEpochMicros":1000000,"playbackRate":1
        }}
        """#
        let envelope = try JSONDecoder().decode(MediaAdapterEnvelope.self, from: Data(json.utf8))
        let track = try XCTUnwrap(envelope.payload).track(at: Date(timeIntervalSince1970: 500))
        XCTAssertEqual(track.elapsed, 7)
        XCTAssertFalse(track.isPlaying)
    }

    func testPartialPayloadDegradesWithoutDroppingFrame() throws {
        let json = #"{"type":"data","payload":{"title":"Live Stream"}}"#
        let envelope = try JSONDecoder().decode(MediaAdapterEnvelope.self, from: Data(json.utf8))
        let track = try XCTUnwrap(envelope.payload).track()
        XCTAssertEqual(track.title, "Live Stream")
        XCTAssertEqual(track.duration, 0)
        XCTAssertEqual(track.elapsed, 0)
        XCTAssertFalse(track.isPlaying)
    }
}
