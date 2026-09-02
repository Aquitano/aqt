import Foundation

/// Starboard launched by the Raycast extension: settings come from a JSON file
/// the extension edits, the menu bar item is Raycast's, and a unix socket
/// takes live commands. Absent flags mean the standalone app.
struct HelperMode {
    let configURL: URL
    let socketPath: String
    /// Raycast command that mirrors the hold overlay; nil keeps it native.
    let searchDeeplink: URL?

    static let current = parse(CommandLine.arguments)

    static var isActive: Bool { current != nil }

    static func parse(_ arguments: [String]) -> HelperMode? {
        var config: String?
        var socket: String?
        var search: String?
        var iterator = arguments.dropFirst().makeIterator()
        while let argument = iterator.next() {
            switch argument {
            case "--config": config = iterator.next()
            case "--socket": socket = iterator.next()
            case "--search-deeplink": search = iterator.next()
            default: continue
            }
        }
        guard let config, let socket else { return nil }
        return HelperMode(
            configURL: URL(fileURLWithPath: config),
            socketPath: socket,
            searchDeeplink: search.flatMap(URL.init(string:))
        )
    }
}
