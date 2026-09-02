import Foundation
import Network

/// One JSON request per connection, one JSON line back. The Raycast extension
/// is the only client; every command the extension can issue is a case here.
enum HelperRequest: Decodable {
    case status
    case setEnabled(Bool)
    case visibleApps
    case restoreStage(Character)
    /// The live hold overlay, polled by the Raycast mirror.
    case overlay
    case focus(itemID: String)
    case search(query: String, scope: SearchModel.Scope)

    private enum CodingKeys: String, CodingKey {
        case cmd, enabled, letter, id, query, scope
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let command = try container.decode(String.self, forKey: .cmd)
        switch command {
        case "status":
            self = .status
        case "setEnabled":
            self = .setEnabled(try container.decode(Bool.self, forKey: .enabled))
        case "visibleApps":
            self = .visibleApps
        case "restoreStage":
            let letter = try container.decode(String.self, forKey: .letter)
            guard letter.count == 1, let character = letter.lowercased().first else {
                throw DecodingError.dataCorruptedError(
                    forKey: .letter, in: container, debugDescription: "letter must be one character"
                )
            }
            self = .restoreStage(character)
        case "overlay":
            self = .overlay
        case "focus":
            self = .focus(itemID: try container.decode(String.self, forKey: .id))
        case "search":
            let windows = try container.decodeIfPresent(String.self, forKey: .scope) == "windows"
            self = .search(
                query: try container.decodeIfPresent(String.self, forKey: .query) ?? "",
                scope: windows ? .windows : .apps
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .cmd, in: container, debugDescription: "unknown command \(command)"
            )
        }
    }
}

struct HelperStatus: Encodable {
    var enabled: Bool
    var spaceNumber: Int?
    var accessibility: Bool
    var screenRecording: Bool
    var version: String
    var pid: Int32
}

struct HelperApp: Encodable {
    var bundleID: String
    var name: String
}

struct OverlaySnapshot: Encodable {
    struct Item: Encodable {
        var id: String
        var title: String
        var subtitle: String?
        var letter: String?
        var appPath: String?
        var isWindow: Bool
    }

    var active: Bool
    var cancelled: Bool
    var query: String
    var scope: String
    var selectedID: String?
    var items: [Item]

    @MainActor
    init(_ model: SearchModel) {
        active = model.isVisible
        cancelled = model.cancelled
        query = model.query
        scope = model.scope == .windows ? "windows" : "apps"
        selectedID = model.selectedItem?.id
        items = Self.rows(model.items)
    }

    @MainActor
    static func rows(_ items: [SearchModel.Item]) -> [Item] {
        items.map { item in
            Item(
                id: item.id,
                title: item.title,
                subtitle: item.subtitle,
                letter: item.letter.map(String.init),
                appPath: item.iconBundleID.flatMap(AppIcons.path(for:)),
                isWindow: { if case .window = item.kind { return true } else { return false } }()
            )
        }
    }
}

enum HelperResponse: Encodable {
    case status(HelperStatus)
    case apps([HelperApp])
    case overlay(OverlaySnapshot)
    case items([OverlaySnapshot.Item])
    case done
    case error(String)

    private enum CodingKeys: String, CodingKey {
        case ok, error, apps, items
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .status(let status):
            try status.encode(to: encoder)
            try container.encode(true, forKey: .ok)
        case .overlay(let snapshot):
            try snapshot.encode(to: encoder)
            try container.encode(true, forKey: .ok)
        case .apps(let apps):
            try container.encode(true, forKey: .ok)
            try container.encode(apps, forKey: .apps)
        case .items(let items):
            try container.encode(true, forKey: .ok)
            try container.encode(items, forKey: .items)
        case .done:
            try container.encode(true, forKey: .ok)
        case .error(let message):
            try container.encode(false, forKey: .ok)
            try container.encode(message, forKey: .error)
        }
    }
}

@MainActor
final class HelperServer {
    typealias Handler = @MainActor (HelperRequest) -> HelperResponse

    private let listener: NWListener
    private let handler: Handler

    init(socketPath: String, handler: @escaping Handler) throws {
        self.handler = handler
        unlink(socketPath)
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.unix(path: socketPath)
        listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.serve(connection) }
        }
        listener.stateUpdateHandler = { state in
            if case .failed(let error) = state {
                NSLog("Starboard: helper socket failed: \(error)")
            }
        }
        listener.start(queue: .main)
    }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: .main)
        receiveLine(on: connection, buffered: Data())
    }

    private func receiveLine(on connection: NWConnection, buffered: Data) {
        connection.receive(
            minimumIncompleteLength: 1, maximumLength: 64 * 1024
        ) { [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self, error == nil else {
                    connection.cancel()
                    return
                }
                var buffer = buffered
                if let data { buffer.append(data) }
                if let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                    self.respond(to: buffer[..<newline], on: connection)
                } else if complete {
                    connection.cancel()
                } else {
                    self.receiveLine(on: connection, buffered: buffer)
                }
            }
        }
    }

    private func respond(to line: Data, on connection: NWConnection) {
        let response: HelperResponse
        do {
            response = handler(try JSONDecoder().decode(HelperRequest.self, from: line))
        } catch let DecodingError.dataCorrupted(context) {
            response = .error(context.debugDescription)
        } catch {
            response = .error("bad request: \(error)")
        }
        var payload = (try? JSONEncoder().encode(response)) ?? Data(#"{"ok":false,"error":"encode"}"#.utf8)
        payload.append(UInt8(ascii: "\n"))
        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
