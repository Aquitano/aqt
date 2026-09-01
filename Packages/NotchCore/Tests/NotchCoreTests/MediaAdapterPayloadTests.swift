import Foundation
import Testing
@testable import NotchCore

struct MediaAdapterPayloadTests {

    @Test func decodesPinnedBridgeFrameAndConvertsMicroseconds() throws {
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
        let payload = try #require(envelope.payload)
        let track = payload.track(at: Date(timeIntervalSince1970: 102))

        #expect(envelope.type == "data")
        #expect(track.title == "A Song")
        #expect(track.duration == 240)
        #expect(abs(track.elapsed - 14.5) < 0.001)
        #expect(track.isPlaying)
        #expect(track.bundleIdentifier == "com.apple.Safari")
        #expect(track.appName == "Safari")
        #expect(payload.artworkData == Data("hello".utf8))
    }

    @Test func pausedFrameDoesNotExtrapolateElapsedTime() throws {
        let json = #"""
        {"type":"data","payload":{
          "title":"Paused","isPlaying":false,"elapsedTimeMicros":7000000,
          "timestampEpochMicros":1000000,"playbackRate":1
        }}
        """#
        let envelope = try JSONDecoder().decode(MediaAdapterEnvelope.self, from: Data(json.utf8))
        let track = try #require(envelope.payload).track(at: Date(timeIntervalSince1970: 500))
        #expect(track.elapsed == 7)
        #expect(!track.isPlaying)
    }

    @Test func partialPayloadDegradesWithoutDroppingFrame() throws {
        let json = #"{"type":"data","payload":{"title":"Live Stream"}}"#
        let envelope = try JSONDecoder().decode(MediaAdapterEnvelope.self, from: Data(json.utf8))
        let track = try #require(envelope.payload).track()
        #expect(track.title == "Live Stream")
        #expect(track.duration == 0)
        #expect(track.elapsed == 0)
        #expect(!track.isPlaying)
    }
}
