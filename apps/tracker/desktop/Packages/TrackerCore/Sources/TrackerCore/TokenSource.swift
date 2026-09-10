import Foundation
import Synchronization

/// Keeps the agent signed in on its own. `tracker login` is what creates the
/// session; from then on this refreshes the access token and writes the result
/// back, so an agent that runs for weeks never needs a human at a terminal.
///
/// An actor because the refresh token can rotate: two concurrent refreshes
/// would race, and the loser would persist a refresh token the provider has
/// already retired.
package actor TokenSource {
    package typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let path: String
    private let now: @Sendable () -> Date
    private let transport: Transport

    /// `applicationWillTerminate` cannot await an actor, so the last token
    /// handed out is kept where a synchronous caller can reach it.
    private let lastIssued = Mutex<String?>(nil)

    package init(
        path: String,
        now: @escaping @Sendable () -> Date = Date.init,
        transport: @escaping Transport = { try await URLSession.shared.data(for: $0) }
    ) {
        self.path = path
        self.now = now
        self.transport = transport
    }

    /// The access token to send, refreshed first if it is spent. nil means the
    /// agent has nothing to present and the request goes out bare, which is
    /// correct against a server with no issuer configured.
    package func bearer(forcingRefresh: Bool = false) async -> String? {
        guard let session = load(), let token = session.token else { return nil }
        if !forcingRefresh, token.isFresh(at: now()) {
            return issue(token.accessToken)
        }
        guard let refreshed = await refresh(session) else {
            // The old token may still be good: a refresh can fail because the
            // network is down, which says nothing about the access token.
            return forcingRefresh ? nil : issue(token.accessToken)
        }
        return issue(refreshed.accessToken)
    }

    /// The token last handed out, for a caller that cannot await. It may be
    /// a moment stale, which costs one rejected batch at shutdown at worst.
    package nonisolated func mostRecentBearer() -> String? {
        lastIssued.withLock { $0 }
    }

    private func issue(_ token: String) -> String {
        lastIssued.withLock { $0 = token }
        return token
    }

    private func refresh(_ session: StoredSession) async -> StoredToken? {
        guard let request = TokenExchange.refreshRequest(session: session) else {
            Log.auth.error("no refresh token stored, run 'tracker login'")
            return nil
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport(request)
        } catch {
            Log.auth.notice("refresh failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            Log.auth.error("refresh rejected with HTTP \(status, privacy: .public), run 'tracker login'")
            return nil
        }
        guard let decoded = try? SessionCoding.decoder().decode(TokenResponse.self, from: data) else {
            Log.auth.error("refresh returned a body that is not a token")
            return nil
        }
        let token = TokenExchange.merge(decoded, into: session.token, at: now())
        var updated = session
        updated.token = token
        persist(updated)
        Log.auth.notice("access token refreshed")
        return token
    }

    /// Read every time rather than cache: the file is small, and a cached
    /// session would outlive a `tracker login` that replaced it.
    private func load() -> StoredSession? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        guard let session = try? SessionCoding.decoder().decode(StoredSession.self, from: data) else {
            Log.auth.error("\(self.path, privacy: .public) is not a tracker session")
            return nil
        }
        return session
    }

    /// Write and rename, matching the CLI: a crash mid-write would otherwise
    /// leave a truncated session that only `tracker logout` clears.
    private func persist(_ session: StoredSession) {
        guard let data = try? SessionCoding.encoder().encode(session) else { return }
        let target = URL(fileURLWithPath: path)
        let temporary = target.deletingLastPathComponent().appending(path: ".token-\(UUID().uuidString).json")
        // Created 0600 rather than chmod'd after the fact, so the refresh token
        // is never briefly world-readable.
        guard FileManager.default.createFile(
            atPath: temporary.path,
            contents: data,
            attributes: [.posixPermissions: 0o600]
        ) else {
            Log.auth.error("could not stage the refreshed token")
            return
        }
        do {
            _ = try FileManager.default.replaceItemAt(target, withItemAt: temporary)
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            Log.auth.error("could not store the refreshed token: \(error.localizedDescription, privacy: .public)")
        }
    }
}
