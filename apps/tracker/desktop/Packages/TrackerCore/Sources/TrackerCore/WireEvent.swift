import Foundation

package enum EndReason: String, Sendable, Equatable {
    case appSwitch = "app_switch"
    case windowChange = "window_change"
    case idle
    case unknown
}

package struct SpanStart: Sendable, Equatable {
    package var id: String
    package var startedAt: Date
    package var appName: String
    package var bundleID: String
    package var windowTitle: String?
}

package struct SpanHeartbeat: Sendable, Equatable {
    package var id: String
    package var at: Date
}

package struct SpanEnd: Sendable, Equatable {
    package var id: String
    package var endedAt: Date
    package var reason: EndReason
}

package enum WireEvent: Sendable, Equatable {
    case spanStart(SpanStart)
    case spanHeartbeat(SpanHeartbeat)
    case spanEnd(SpanEnd)
}

extension WireEvent: Encodable {
    private enum Key: String, CodingKey {
        case type
        case id
        case startedAt = "started_at"
        case appName = "app_name"
        case bundleID = "bundle_id"
        case windowTitle = "window_title"
        case at
        case endedAt = "ended_at"
        case reason
    }

    package func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        switch self {
        case let .spanStart(event):
            try container.encode("span_start", forKey: .type)
            try container.encode(event.id, forKey: .id)
            try container.encode(event.startedAt, forKey: .startedAt)
            try container.encode(event.appName, forKey: .appName)
            try container.encode(event.bundleID, forKey: .bundleID)
            try container.encodeIfPresent(event.windowTitle, forKey: .windowTitle)
        case let .spanHeartbeat(event):
            try container.encode("span_heartbeat", forKey: .type)
            try container.encode(event.id, forKey: .id)
            try container.encode(event.at, forKey: .at)
        case let .spanEnd(event):
            try container.encode("span_end", forKey: .type)
            try container.encode(event.id, forKey: .id)
            try container.encode(event.endedAt, forKey: .endedAt)
            try container.encode(event.reason.rawValue, forKey: .reason)
        }
    }
}

package struct EventBatch: Sendable, Encodable {
    package var deviceID: UUID
    package var events: [WireEvent]

    package init(deviceID: UUID, events: [WireEvent]) {
        self.deviceID = deviceID
        self.events = events
    }

    private enum Key: String, CodingKey {
        case deviceID = "device_id"
        case events
    }

    package func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(deviceID.uuidString.lowercased(), forKey: .deviceID)
        try container.encode(events, forKey: .events)
    }
}

package enum EventEncoding {
    /// The server parses RFC 3339; fractional seconds and UTC keep a batch
    /// ordered even when two events land in the same second.
    package static let timestamp = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    package static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(timestamp.format(date))
        }
        return encoder
    }
}
