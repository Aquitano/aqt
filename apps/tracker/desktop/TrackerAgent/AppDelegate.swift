import AppKit
import TrackerCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let coordinator = AgentCoordinator()
    private var menuBar: MenuBarController?

    func applicationDidFinishLaunching(_: Notification) {
        menuBar = MenuBarController(coordinator: coordinator)
        coordinator.start()
        Log.agent.notice("tracker agent started")
    }

    func applicationWillTerminate(_: Notification) {
        coordinator.stop()
        Log.agent.notice("tracker agent stopped")
    }
}
