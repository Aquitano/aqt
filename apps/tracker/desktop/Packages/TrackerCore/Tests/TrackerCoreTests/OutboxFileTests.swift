import Foundation
import Testing
@testable import TrackerCore

@Test func outboxRestoresEventsAndPersistsAcknowledgedPrefix() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appending(path: "outbox.json")
    let file = OutboxFile(url: url)
    #expect(try file.load().get().isEmpty)
    let events: [WireEvent] = [
        .spanStart(SpanStart(id: "span", startedAt: Date(timeIntervalSince1970: 100.125),
                             appName: "Editor", bundleID: "app.editor", windowTitle: "Document")),
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

@Test func outboxReportsUnreadableDataWithoutChangingIt() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appending(path: "outbox.json")
    let corrupt = Data("unfinished data".utf8)
    try corrupt.write(to: url)
    guard case .failure = OutboxFile(url: url).load() else {
        Issue.record("Corrupt outbox loaded without an error")
        return
    }
    #expect(try Data(contentsOf: url) == corrupt)
}
