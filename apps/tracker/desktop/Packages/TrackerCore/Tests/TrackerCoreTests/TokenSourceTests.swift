import Foundation
import Testing
@testable import TrackerCore

/// 2026-05-28T21:46:40Z, so the fixtures below sit clearly either side of it.
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

    /// A provider that does not rotate omits the field, and discarding the old
    /// one would mean signing in again at the next expiry.
    @Test func aRefreshTokenTheProviderOmitsIsKept() throws {
        let previous = StoredToken(accessToken: "access-1", refreshToken: "refresh-1")
        let response = try SessionCoding.decoder().decode(
            TokenResponse.self,
            from: Data(#"{"access_token":"access-2","expires_in":600}"#.utf8)
        )
        let merged = TokenExchange.merge(response, into: previous, at: epoch)
        #expect(merged.refreshToken == "refresh-1")
        #expect(merged.expiry == epoch.addingTimeInterval(600))
    }

    /// A refresh that fails on the network says nothing about the access token,
    /// so the agent keeps trying with what it has rather than going silent.
    @Test func aRefreshTheServerRejectsLeavesTheOldTokenInPlace() async throws {
        let path = try tokenFile(sessionJSON(expiry: "2026-01-01T00:00:00Z"))
        let source = TokenSource(path: path, now: { epoch }, transport: reply("nope", status: 503))
        #expect(await source.bearer() == "access-1")
        #expect(await source.bearer(forcingRefresh: true) == nil)
    }

    @Test func anUnsetTokenPathFallsBackToTheCLIsLocation() {
        #expect(TrackerConfiguration.tokenPath(nil) == TrackerConfiguration.defaultTokenPath)
        #expect(TrackerConfiguration.tokenPath("") == nil)
        #expect(TrackerConfiguration.tokenPath("/tmp/token.json") == "/tmp/token.json")
    }
}
