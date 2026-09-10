import AppKit
import TrackerCore

@MainActor
final class MenuBarController: NSObject, NSMenuDelegate {
    private struct Health: Equatable {
        var reachable: Bool
        var trusted: Bool
    }

    private static let accessibilitySettings =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"

    private let coordinator: AgentCoordinator
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private var iconWatch: Task<Void, Never>?

    init(coordinator: AgentCoordinator) {
        self.coordinator = coordinator
        super.init()

        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        iconWatch = watch { [coordinator] in
            Health(reachable: coordinator.outbox.serverReachable, trusted: coordinator.accessibilityTrusted)
        } onChange: { [weak self] health in
            self?.render(health)
        }
        render(Health(reachable: coordinator.outbox.serverReachable, trusted: coordinator.accessibilityTrusted))
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(label(coordinator.outbox.serverReachable ? "Server: connected" : "Server: unreachable"))

        if coordinator.accessibilityTrusted {
            menu.addItem(label("Accessibility: granted"))
        } else {
            menu.addItem(label("Accessibility: not granted, no window titles"))
            let open = NSMenuItem(
                title: "Open Accessibility Settings…",
                action: #selector(openAccessibilitySettings),
                keyEquivalent: ""
            )
            open.target = self
            menu.addItem(open)
        }

        menu.addItem(label(coordinator.trackedDescription))
        menu.addItem(label(queueDescription()))
        if let error = coordinator.outbox.lastError {
            menu.addItem(label("Last error: \(error)"))
        }

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private func queueDescription() -> String {
        let queued = "Queued: \(coordinator.outbox.pending)"
        guard coordinator.outbox.dropped > 0 else { return queued }
        return "\(queued), dropped \(coordinator.outbox.dropped)"
    }

    private func render(_ health: Health) {
        let symbol = health.reachable && health.trusted ? "eye" : "eye.trianglebadge.exclamationmark"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "tracker agent")
        image?.isTemplate = true
        statusItem.button?.image = image
    }

    private func label(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @objc private func openAccessibilitySettings() {
        guard let url = URL(string: Self.accessibilitySettings) else { return }
        NSWorkspace.shared.open(url)
    }
}
