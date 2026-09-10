import Foundation

/// UUIDv7: 48 bits of Unix milliseconds, then version/variant bits over random.
/// The whole system keys on time-ordered ids, so the agent generates the same
/// shape the extension and the Go server do.
package enum UUIDv7 {
    package static func generate(at date: Date = .now) -> UUID {
        var bytes = (0 ..< 16).map { _ in UInt8.random(in: .min ... .max) }
        let milliseconds = UInt64(max(0, date.timeIntervalSince1970 * 1000))
        for offset in 0 ..< 6 {
            bytes[offset] = UInt8(truncatingIfNeeded: milliseconds >> (8 * (5 - UInt64(offset))))
        }
        bytes[6] = (bytes[6] & 0x0F) | 0x70
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }

    package static func string(at date: Date = .now) -> String {
        generate(at: date).uuidString.lowercased()
    }
}
