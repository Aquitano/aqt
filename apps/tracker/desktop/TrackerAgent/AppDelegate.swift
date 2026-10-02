import AppKit
import TrackerCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let coordinator = AgentCoordinator()
    private var menuBar: MenuBarController?
    private var terminationSignal: DispatchSourceSignal?

    func applicationDidFinishLaunching(_: Notification) {
        menuBar = MenuBarController(coordinator: coordinator)
        coordinator.start()
        terminateOnSIGTERM()
        Log.agent.notice("tracker agent started")
    }

    func applicationWillTerminate(_: Notification) {
        coordinator.stop()
        Log.agent.notice("tracker agent stopped")
    }

    /// launchd stops the agent with SIGTERM, whose default action exits
    /// without applicationWillTerminate, so the open span would never end.
    private func terminateOnSIGTERM() {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler {
            MainActor.assumeIsolated { NSApp.terminate(nil) }
        }
        source.resume()
        terminationSignal = source
    }
}
