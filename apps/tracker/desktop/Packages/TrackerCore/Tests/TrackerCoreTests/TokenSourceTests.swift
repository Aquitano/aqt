import Foundation
import Testing
@testable import TrackerCore

/// 2026-05-28T20:26:40Z, so the fixtures below sit clearly either side of it.
private let epoch = Date(timeIntervalSince1970: 1_780_000_000)

/// The shape `tracker login` writes, fractional seconds and all.
private func sessionJSON(expiry: String, refreshToken: String = "refresh-1") -> Data {
    Data("""
    {
      "issuer": "https://auth.example.com/application/o/tracker/",
      "client_id": "tracker-cli",
      "device_auth_url": "https://auth.example.com/device/",
      "token_url": "https://auth.example.com/token/",
      "token": {
        "access_token": "access-1",
        "token_type": "Bearer",
        "refresh_token": "\(refreshToken)",
        "expiry": "\(expiry)"
      }
    }
    """.utf8)
}

private func tokenFile(_ contents: Data) throws -> String {
    let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let path = directory.appending(path: "token.json")
    try contents.write(to: path)
    return path.path(percentEncoded: false)
}

private final class CallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func record() {
        lock.lock()
        defer { lock.unlock() }
        value += 1
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

private func reply(_ json: String, status: Int = 200) -> TokenSource.Transport {
    { request in
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (Data(json.utf8), response)
    }
}

struct TokenSourceTests {
    @Test func aTokenWithTimeLeftIsSentWithoutARefresh() async throws {
        let path = try tokenFile(sessionJSON(expiry: "2027-01-01T00:00:00.123456789Z"))
        let source = TokenSource(
            path: path,
            now: { epoch },
            transport: { _ in Issue.record("refreshed a token that was still good"); throw CancellationError() }
        )
        #expect(await source.bearer() == "access-1")
    }

    @Test func anExpiredTokenIsRefreshedAndTheNewOneStored() async throws {
        let path = try tokenFile(sessionJSON(expiry: "2026-01-01T00:00:00Z"))
        let source = TokenSource(
            path: path,
            now: { epoch },
            transport: reply(#"{"access_token":"access-2","refresh_token":"refresh-2","expires_in":3600}"#)
        )
        #expect(await source.bearer() == "access-2")

        // Stored, or the next launch would start from the spent token again.
        let stored = try SessionCoding.decoder().decode(
            StoredSession.self,
            from: Data(contentsOf: URL(fileURLWithPath: path))
        )
        #expect(stored.token?.accessToken == "access-2")
        #expect(stored.token?.refreshToken == "refresh-2")
        #expect(stored.issuer == "https://auth.example.com/application/o/tracker/")
    }

    /// A provider that does not rotate omits the field or sends it empty, and
    /// storing that would sign out the CLI as well at the next expiry.
    @Test(arguments: [
        #"{"access_token":"access-2","expires_in":600}"#,
        #"{"access_token":"access-2","refresh_token":"","expires_in":600}"#,
    ])
    func aRefreshTokenTheProviderDoesNotRotateIsKept(body: String) throws {
        let previous = StoredToken(accessToken: "access-1", refreshToken: "refresh-1")
        let response = try SessionCoding.decoder().decode(TokenResponse.self, from: Data(body.utf8))
        let merged = TokenExchange.merge(response, into: previous, at: epoch)
        #expect(merged.refreshToken == "refresh-1")
        #expect(merged.expiry == epoch.addingTimeInterval(600))
    }

    /// Quoted by some providers, bare by most; oauth2 takes either, and a body
    /// that fails to decode wholesale would strand a token it had just rotated.
    @Test func aQuotedExpiresInIsAccepted() throws {
        let response = try SessionCoding.decoder().decode(
            TokenResponse.self,
            from: Data(#"{"access_token":"access-2","expires_in":"600"}"#.utf8)
        )
        #expect(TokenExchange.merge(response, into: nil, at: epoch).expiry == epoch.addingTimeInterval(600))
    }

    /// A refresh can fail because the network is down, which says nothing about
    /// a token that has not run out yet.
    @Test func aTokenInsideTheRefreshSkewSurvivesAFailedRefresh() async throws {
        let path = try tokenFile(sessionJSON(expiry: "2026-05-28T21:47:10Z"))
        let source = TokenSource(path: path, now: { epoch }, transport: reply("nope", status: 503))
        #expect(await source.bearer() == "access-1")
    }

    /// Past its expiry it is spent, and sending it again only earns another 401.
    @Test func aSpentTokenIsNotSentAfterAFailedRefresh() async throws {
        let path = try tokenFile(sessionJSON(expiry: "2026-01-01T00:00:00Z"))
        let source = TokenSource(path: path, now: { epoch }, transport: reply("nope", status: 503))
        #expect(await source.bearer() == nil)
        #expect(await source.bearer(forcingRefresh: true) == nil)
    }

    /// Actors are reentrant and this one suspends for the whole round trip, so
    /// without the shared task both callers would spend the same refresh token.
    @Test func concurrentCallersShareOneRefresh() async throws {
        let path = try tokenFile(sessionJSON(expiry: "2026-01-01T00:00:00Z"))
        let calls = CallCounter()
        let source = TokenSource(path: path, now: { epoch }, transport: { request in
            calls.record()
            try? await Task.sleep(for: .milliseconds(50))
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let body = #"{"access_token":"access-2","refresh_token":"refresh-2","expires_in":3600}"#
            return (Data(body.utf8), response)
        })

        async let first = source.bearer()
        async let second = source.bearer()

        #expect(await [first, second] == ["access-2", "access-2"])
        #expect(calls.count == 1)
    }

    /// `applicationWillTerminate` cannot await, and a quit before the first
    /// flush would otherwise send that last batch with no token at all.
    @Test func theTerminatePathFindsATokenBeforeTheFirstFlush() throws {
        let path = try tokenFile(sessionJSON(expiry: "2027-01-01T00:00:00Z"))
        let source = TokenSource(path: path, now: { epoch }, transport: reply(""))
        #expect(source.mostRecentBearer() == "access-1")
    }

    @Test func anUnsetTokenPathFallsBackToTheCLIsLocation() {
        #expect(TrackerConfiguration.tokenPath(nil) == TrackerConfiguration.defaultTokenPath)
        #expect(TrackerConfiguration.tokenPath("") == nil)
        #expect(TrackerConfiguration.tokenPath("/tmp/token.json") == "/tmp/token.json")
    }
}
