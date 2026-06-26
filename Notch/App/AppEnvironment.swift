import AppKit
import SwiftUI

/// Composition root. Creates every manager, wires their dependencies, and owns
/// the strong references for the app's lifetime. Injected into the SwiftUI tree
/// as a set of environment objects so views observe each manager granularly.
@MainActor
final class AppEnvironment: ObservableObject {

    let settings: Settings
    let state: NotchState

    let imageCache: ImageCache
    let persistence: Persistence

    let activities: ActivityManager
    let media: MediaManager
    let hud: HUDManager
    let tray: TrayManager

    let battery: BatteryManager
    let calendar: CalendarManager
    let weather: WeatherManager
    let bluetooth: BluetoothBatteryManager
    let focus: FocusManager

    /// Set by the AppDelegate once the window exists; used to anchor the AirDrop
    /// share sheet to a key-capable window. Weak to avoid a retain cycle.
    weak var windowController: NotchWindowController?

    @Published private(set) var renderingActive = true

    /// Retains the AirDrop sharing delegate for the lifetime of one interaction.
    private var shareCoordinator: ShareCoordinator?

    init() {
        let settings = Settings.shared
        let state = NotchState()
        let imageCache = ImageCache()
        let persistence = Persistence()
        let activities = ActivityManager(state: state)

        self.settings = settings
        self.state = state
        self.imageCache = imageCache
        self.persistence = persistence
        self.activities = activities

        self.media = MediaManager(activities: activities, imageCache: imageCache, settings: settings)
        self.hud = HUDManager(settings: settings)
        self.tray = TrayManager(persistence: persistence, imageCache: imageCache, settings: settings)
        self.battery = BatteryManager(activities: activities)
        self.calendar = CalendarManager()
        self.weather = WeatherManager(settings: settings)
        self.bluetooth = BluetoothBatteryManager(activities: activities)
        self.focus = FocusManager(activities: activities)
    }

    /// Start all event-driven subscriptions. Called after the window is up.
    func start() {
        media.start()
        hud.start()
        tray.start()
        battery.start()
        calendar.start()
        weather.start()
        bluetooth.start()
        focus.start()
    }

    func setRenderingActive(_ active: Bool) {
        guard renderingActive != active else { return }
        renderingActive = active
        media.setRenderingActive(active)
    }

    /// Open the AirDrop sheet pre-loaded with the given tray items, anchored to
    /// the (temporarily key) overlay panel.
    func airDrop(_ items: [DropItem]) {
        share(urls: items.map { $0.url(relativeTo: tray.storageRoot) }, via: .airdrop)
    }

    /// Share freshly dropped files via the user's configured method. The drop
    /// URLs die when the handler returns, so the bytes are copied into a temp
    /// staging dir first, then the service is presented anchored to the panel.
    @discardableResult
    func shareDrop(_ providers: [NSItemProvider]) -> Bool {
        guard !providers.isEmpty else { return false }
        let method = settings.shareMethod
        tray.stageForShare(providers) { [weak self] urls in
            self?.share(urls: urls, via: method)
        }
        return true
    }

    /// Present a sharing service for `urls`, anchored to the (temporarily key)
    /// overlay panel so the device/share picker has a window to attach to.
    func share(urls: [URL], via method: ShareMethod) {
        guard !urls.isEmpty else { return }
        guard let service = sharingService(for: method, items: urls) else {
            Log.tray.error("Share unavailable via \(method.rawValue)")
            return
        }

        let coordinator = ShareCoordinator { [weak self] in
            self?.windowController?.endShareSheet()
            // Release after the delegate callback unwinds.
            DispatchQueue.main.async { self?.shareCoordinator = nil }
        }
        shareCoordinator = coordinator
        service.delegate = coordinator

        windowController?.beginShareSheet {
            service.perform(withItems: urls)
        }
    }

    private func sharingService(for method: ShareMethod, items: [URL]) -> NSSharingService? {
        switch method {
        case .airdrop:
            let service = NSSharingService(named: .sendViaAirDrop)
            return (service?.canPerform(withItems: items) ?? false) ? service : nil
        case .blip:
            // No named constant for third-party services; match the one the system
            // offers for these items by title.
            return NSSharingService.sharingServices(forItems: items).first {
                $0.title.localizedCaseInsensitiveContains(method.serviceMatch)
            }
        }
    }
}

/// Keeps the overlay panel key for the whole async AirDrop interaction, restoring
/// the passive-overlay state only when the share finishes, fails, or is cancelled.
private final class ShareCoordinator: NSObject, NSSharingServiceDelegate {
    private let onFinish: () -> Void
    init(onFinish: @escaping () -> Void) { self.onFinish = onFinish }

    func sharingService(_ sharingService: NSSharingService, didShareItems items: [Any]) {
        onFinish()
    }

    func sharingService(_ sharingService: NSSharingService, didFailToShareItems items: [Any], error: Error) {
        onFinish()
    }
}

extension View {
    /// Inject every manager so views can `@EnvironmentObject` exactly what they need.
    @MainActor
    func injectNotchEnvironment(_ env: AppEnvironment) -> some View {
        self
            .environmentObject(env)
            .environmentObject(env.settings)
            .environmentObject(env.state)
            .environmentObject(env.activities)
            .environmentObject(env.media)
            .environmentObject(env.hud)
            .environmentObject(env.tray)
            .environmentObject(env.battery)
            .environmentObject(env.calendar)
            .environmentObject(env.weather)
            .environmentObject(env.bluetooth)
            .environmentObject(env.focus)
    }
}
