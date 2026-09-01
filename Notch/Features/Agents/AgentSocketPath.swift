import Foundation

/// The agent socket path, shared by the app's server and the standalone hook
/// tool so both agree on one location.
enum AgentSocket {
    static var url: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".notch", isDirectory: true)
            .appendingPathComponent("agents.sock")
    }
}
