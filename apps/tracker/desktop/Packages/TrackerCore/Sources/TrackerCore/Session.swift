import Foundation

/// `tracker login` writes this file and the agent reads it, so the field names
/// are the Go CLI's and both sides share one session on disk.
package struct StoredSession: Codable, Sendable, Equatable {
    package var issuer: String
    package var clientID: String
    package var deviceAuthURL: String
    package var tokenURL: String
    package var token: StoredToken?

    package init(
        issuer: String,
        clientID: String,
        deviceAuthURL: String = "",
        tokenURL: String,
        token: StoredToken?
    ) {
        self.issuer = issuer
        self.clientID = clientID
        self.deviceAuthURL = deviceAuthURL
        self.tokenURL = tokenURL
        self.token = token
    }

    enum CodingKeys: String, CodingKey {
        case issuer
        case clientID = "client_id"
        case deviceAuthURL = "device_auth_url"
        case tokenURL = "token_url"
        case token
    }
}

package struct StoredToken: Codable, Sendable, Equatable {
    package var accessToken: String
    package var tokenType: String?
    package var refreshToken: String?
    package var expiry: Date?

    package init(accessToken: String, tokenType: String? = "Bearer", refreshToken: String? = nil, expiry: Date? = nil) {
        self.accessToken = accessToken
        self.tokenType = tokenType
        self.refreshToken = refreshToken
        self.expiry = expiry
    }

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case tokenType = "token_type"
        case refreshToken = "refresh_token"
        case expiry
    }

    /// Refresh before the server would reject it: a token that expires while
    /// the batch is in flight costs a round trip and a retry.
    package static let expirySkew: TimeInterval = 60

    package func isFresh(at now: Date) -> Bool {
        guard let expiry, expiry != Date(timeIntervalSince1970: 0) else { return true }
        return expiry.timeIntervalSince(now) > Self.expirySkew
    }
}

/// What the token endpoint answers a refresh with.
package struct TokenResponse: Decodable, Sendable {
    package let accessToken: String
    package let tokenType: String?
    package let refreshToken: String?
    package let expiresIn: Double?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case tokenType = "token_type"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
    }
}

/// The refresh half of the token endpoint. Kept apart from the networking so
/// the request shape and the merge rule are testable without a server.
package enum TokenExchange {
    package static func refreshRequest(session: StoredSession) -> URLRequest? {
        guard let refreshToken = session.token?.refreshToken, !refreshToken.isEmpty,
              let url = URL(string: session.tokenURL)
        else { return nil }

        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "grant_type", value: "refresh_token"),
            URLQueryItem(name: "refresh_token", value: refreshToken),
            URLQueryItem(name: "client_id", value: session.clientID),
        ]
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = form.percentEncodedQuery?.data(using: .utf8)
        return request
    }

    /// A provider that rotates refresh tokens returns a new one; one that does
    /// not omits the field, and dropping the old one would mean signing in
    /// again on the next expiry.
    package static func merge(_ response: TokenResponse, into previous: StoredToken?, at now: Date) -> StoredToken {
        StoredToken(
            accessToken: response.accessToken,
            tokenType: response.tokenType ?? previous?.tokenType ?? "Bearer",
            refreshToken: response.refreshToken ?? previous?.refreshToken,
            expiry: response.expiresIn.map { now.addingTimeInterval($0) }
        )
    }
}

/// Go writes RFC 3339, with fractional seconds when the clock had them.
package enum SessionCoding {
    package static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { input in
            let raw = try input.singleValueContainer().decode(String.self)
            guard let date = parse(raw) else {
                throw try DecodingError.dataCorruptedError(
                    in: input.singleValueContainer(),
                    debugDescription: "not RFC 3339: \(raw)"
                )
            }
            return date
        }
        return decoder
    }

    package static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, target in
            var container = target.singleValueContainer()
            try container.encode(format(date))
        }
        return encoder
    }

    static func parse(_ raw: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: raw) {
            return date
        }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }

    static func format(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}
