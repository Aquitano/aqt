import Foundation
import Testing
@testable import TrackerCore

private let now = Date(timeIntervalSince1970: 1_780_000_000)

private func movedAside(_ restored: OutboxFile.Restored) -> URL? {
    if case let .unreadable(_, movedTo: url) = restored {
        return url
    }
    return nil
}

@Test func outboxRestoresEventsAndPersistsAcknowledgedPrefix() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appending(path: "outbox.json")
    let file = OutboxFile(url: url)
    #expect(try file.load().get().isEmpty)
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
    try file.save(events).get()
    #expect(try OutboxFile(url: url).load().get() == events)
    try file.save(Array(events.dropFirst(2))).get()
    #expect(try OutboxFile(url: url).load().get() == Array(events.suffix(1)))
    try file.save([]).get()
    #expect(try OutboxFile(url: url).load().get().isEmpty)
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
}

@Test func outboxMovesUnreadableDataAsideAndStartsAfresh() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appending(path: "outbox.json")
    let corrupt = Data("unfinished data".utf8)
    try corrupt.write(to: url)
    let file = OutboxFile(url: url)
    let aside = try #require(try movedAside(file.restore(at: now).get()))
    #expect(aside.lastPathComponent == "outbox.unreadable-20260528T202640Z.json")
    #expect(try Data(contentsOf: aside) == corrupt)
    let events: [WireEvent] = [.spanHeartbeat(SpanHeartbeat(id: "span", at: now))]
    try file.save(events).get()
    #expect(try file.load().get() == events)
}

@Test func outboxNeverMovesUnreadableDataOntoAnEarlierCopy() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appending(path: "outbox.json")
    let first = Data("first".utf8)
    try first.write(to: url)
    let file = OutboxFile(url: url)
    let aside = try #require(try movedAside(file.restore(at: now).get()))
    let second = Data("second".utf8)
    try second.write(to: url)
    guard case .failure = file.restore(at: now) else {
        Issue.record("Unreadable outbox moved onto an earlier copy")
        return
    }
    #expect(try Data(contentsOf: aside) == first)
    #expect(try Data(contentsOf: url) == second)
}
