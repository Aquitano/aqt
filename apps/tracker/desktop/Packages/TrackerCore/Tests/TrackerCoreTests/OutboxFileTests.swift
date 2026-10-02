import Foundation
import Testing
@testable import TrackerCore

private let now = Date(timeIntervalSince1970: 1_780_000_000)

private func heartbeat(_ second: Int) -> WireEvent {
    .spanHeartbeat(SpanHeartbeat(id: "span", at: Date(timeIntervalSince1970: TimeInterval(second))))
}

private func attribute(_ key: FileAttributeKey, of url: URL) throws -> Int? {
    try (FileManager.default.attributesOfItem(atPath: url.path)[key] as? NSNumber)?.intValue
}

@Test func outboxAppendsEnqueuedEventsAndRestoresThemAfterARestart() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = OutboxFile(url: directory.appending(path: "outbox.jsonl"))
    #expect(try file.restore().get().events.isEmpty)
    let events: [WireEvent] = [
        .spanStart(SpanStart(
            id: "span",
            startedAt: Date(timeIntervalSince1970: 100.125),
            appName: "Editor",
            bundleID: "app.editor",
            windowTitle: "Document"
        )),
        .spanHeartbeat(SpanHeartbeat(id: "span", at: Date(timeIntervalSince1970: 130.125))),
        .spanEnd(SpanEnd(id: "span", endedAt: Date(timeIntervalSince1970: 150.125), reason: .idle)),
    ]
    var queue = OutboxQueue(file: file, events: [], capacity: 10)
    try queue.append(Array(events.prefix(1))).get()
    let created = try attribute(.systemFileNumber, of: file.url)
    try queue.append(Array(events.dropFirst())).get()
    #expect(try attribute(.systemFileNumber, of: file.url) == created)
    #expect(try OutboxFile(url: file.url).restore().get().events == events)
    #expect(try attribute(.posixPermissions, of: file.url) == 0o600)
}

@Test func outboxKeepsOnlyWhatIsLeftAfterAnAcknowledgedBatch() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = OutboxFile(url: directory.appending(path: "outbox.jsonl"))
    var queue = OutboxQueue(file: file, events: [], capacity: 10)
    try queue.append([heartbeat(1), heartbeat(2), heartbeat(3)]).get()
    try queue.removeFirst(2).get()
    #expect(try file.restore().get().events == [heartbeat(3)])
    try queue.removeFirst(1).get()
    #expect(try file.restore().get().events.isEmpty)
}

@Test func outboxDropsTheOldestEventsBeyondItsCapacity() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = OutboxFile(url: directory.appending(path: "outbox.jsonl"))
    var queue = OutboxQueue(file: file, events: [], capacity: 10)
    var dropped = 0
    for second in 0 ..< 25 {
        try queue.append([heartbeat(second)]).get()
        dropped += queue.dropOverflow()
    }
    let newest = (15 ..< 25).map(heartbeat)
    #expect(queue.events == newest)
    #expect(dropped == 15)
    let restored = try file.restore().get()
    #expect(restored.events.count <= 12)
    #expect(OutboxQueue(file: file, events: restored.events, capacity: 10).events == newest)
}

@Test func outboxSkipsADamagedLineAndKeepsTheRest() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = OutboxFile(url: directory.appending(path: "outbox.jsonl"))
    let lines = try [heartbeat(1), heartbeat(2)].map { try JSONEncoder().encode($0) + Data("\n".utf8) }
    let cutShort = Data(#"{"type":"span_heartbeat","id":"sp"#.utf8)
    try (lines[0] + Data("not an event\n".utf8) + lines[1] + cutShort).write(to: file.url)
    let restored = try file.restore().get()
    #expect(restored.events == [heartbeat(1), heartbeat(2)])
    #expect(restored.skippedLines == 2)
    var queue = OutboxQueue(file: file, events: restored.events, capacity: 10)
    try queue.append([heartbeat(3)]).get()
    #expect(try file.restore().get().events == [heartbeat(1), heartbeat(2), heartbeat(3)])
}

@Test func outboxMigratesALegacyArrayOnTheFirstWrite() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = OutboxFile(url: directory.appending(path: "outbox.jsonl"))
    try JSONEncoder().encode([heartbeat(1), heartbeat(2)]).write(to: file.legacyURL)
    let restored = try file.restore().get()
    #expect(restored.events == [heartbeat(1), heartbeat(2)])
    var queue = OutboxQueue(file: file, events: restored.events, capacity: 10)
    try queue.append([heartbeat(3)]).get()
    #expect(!FileManager.default.fileExists(atPath: file.legacyURL.path))
    #expect(try file.restore().get().events == [heartbeat(1), heartbeat(2), heartbeat(3)])
}

@Test func outboxMovesUnreadableDataAsideAndStartsAfresh() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = OutboxFile(url: directory.appending(path: "outbox.jsonl"))
    let corrupt = Data("unfinished data".utf8)
    try corrupt.write(to: file.legacyURL)
    let aside = try #require(try file.restore(at: now).get().movedAside.first?.url)
    #expect(aside.lastPathComponent == "outbox.unreadable-20260528T202640Z.json")
    #expect(try Data(contentsOf: aside) == corrupt)
    var queue = OutboxQueue(file: file, events: [], capacity: 10)
    try queue.append([heartbeat(1)]).get()
    #expect(try file.restore().get().events == [heartbeat(1)])
}

@Test func outboxNeverMovesUnreadableDataOntoAnEarlierCopy() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = OutboxFile(url: directory.appending(path: "outbox.jsonl"))
    let first = Data("first".utf8)
    try first.write(to: file.legacyURL)
    let aside = try #require(try file.restore(at: now).get().movedAside.first?.url)
    let second = Data("second".utf8)
    try second.write(to: file.legacyURL)
    guard case .failure = file.restore(at: now) else {
        Issue.record("Unreadable outbox moved onto an earlier copy")
        return
    }
    #expect(try Data(contentsOf: aside) == first)
    #expect(try Data(contentsOf: file.legacyURL) == second)
}
