import Foundation
import TrackerCore

/// One request shape, and failures as values so the outbox can tell "retry
/// later" from "this batch will never be accepted".
struct IngestClient: Sendable {
    enum Outcome: Sendable, Equatable {
        case delivered(accepted: Int, dropped: Int)
        case transient(String)
        case permanent(String)
    }

    let configuration: TrackerConfiguration

    func send(_ batch: EventBatch) async -> Outcome {
        let request: URLRequest
        do {
            request = try batchRequest(batch)
        } catch {
            return .permanent("encode: \(error.localizedDescription)")
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .transient("no HTTP response") }
            switch http.statusCode {
            case 200 ..< 300:
                let receipt = try? JSONDecoder().decode(Receipt.self, from: data)
                return .delivered(accepted: receipt?.accepted ?? batch.events.count, dropped: receipt?.dropped ?? 0)
            case let status where HTTPFailure.isPermanent(status: status):
                return .permanent("HTTP \(status)")
            case let status:
                return .transient("HTTP \(status)")
            }
        } catch {
            return .transient(error.localizedDescription)
        }
    }

    func health() async -> Bool {
        var request = URLRequest(url: configuration.serverURL.appending(path: "healthz"))
        request.timeoutInterval = 5
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse
        else { return false }
        return http.statusCode == 200
    }

    func batchRequest(_ batch: EventBatch) throws -> URLRequest {
        var request = URLRequest(url: configuration.serverURL.appending(path: "v1/events/batch"))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = bearerToken() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try EventEncoding.encoder().encode(batch)
        return request
    }

    /// `applicationWillTerminate` cannot await, and the main actor is blocked
    /// while it runs, so the last batch goes out on URLSession's own queue.
    static func sendBlocking(_ request: URLRequest, timeout: TimeInterval) {
        let semaphore = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, _, _ in semaphore.signal() }.resume()
        _ = semaphore.wait(timeout: .now() + timeout)
    }

    private func bearerToken() -> String? {
        guard let tokenPath = configuration.tokenPath,
              let data = FileManager.default.contents(atPath: tokenPath),
              let stored = try? JSONDecoder().decode(StoredSession.self, from: data)
        else { return nil }
        return stored.token?.accessToken
    }

    private struct Receipt: Decodable {
        let accepted: Int
        let dropped: Int
    }
}

/// The CLI's `token.json`, of which only the access token matters here;
/// refreshing it is `tracker login`'s job.
private struct StoredSession: Decodable {
    let token: StoredToken?
}

private struct StoredToken: Decodable {
    let accessToken: String

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
    }
}
