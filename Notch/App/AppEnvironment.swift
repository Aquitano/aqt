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

    /// Shared CoreAudio service: drives the volume/mute HUD and the output-route
    /// activity. Owned here (not by the HUD) so route changes are detected even
    /// when the HUD is disabled.
    let audio: AudioHardware

    let activities: ActivityManager
    let media: MediaManager
    let audioVisualizer: AudioVisualizerManager
    let hud: HUDManager
    let tray: TrayManager
    let screenshots: ScreenshotMonitor
    let timer: TimerManager
    let agents: AgentManager

    let battery: BatteryManager
    let calendar: CalendarManager
    let weather: WeatherManager
    let bluetooth: BluetoothBatteryManager
    let focus: FocusManager
    let shortcuts: ShortcutsManager
    let note: NoteManager

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
        let audio = AudioHardware()

        self.settings = settings
        self.state = state
        self.imageCache = imageCache
        self.persistence = persistence
        self.audio = audio
        self.activities = activities

        self.media = MediaManager(activities: activities, imageCache: imageCache, settings: settings)
        self.audioVisualizer = AudioVisualizerManager()
        self.hud = HUDManager(settings: settings, audio: audio)
        let tray = TrayManager(persistence: persistence, imageCache: imageCache, settings: settings, activities: activities)
        self.tray = tray
        self.screenshots = ScreenshotMonitor(settings: settings, activities: activities, tray: tray)
        self.timer = TimerManager(activities: activities)
        self.agents = AgentManager(activities: activities, settings: settings)
        self.battery = BatteryManager(activities: activities)
        self.calendar = CalendarManager(activities: activities)
        self.weather = WeatherManager(settings: settings)
        self.bluetooth = BluetoothBatteryManager(activities: activities)
        self.focus = FocusManager(activities: activities)
        self.shortcuts = ShortcutsManager(activities: activities)
        self.note = NoteManager(persistence: persistence)
    }

    /// Start all event-driven subscriptions. Called after the window is up.
    func start() {
        audio.onRouteChange = { [activities] name, symbol in
            MainActor.assumeIsolated {
                activities.publish(Activity(kind: .audioRoute(name: name, symbol: symbol),
                                            priority: .normal, createdAt: Date(), ttl: 3))
            }
        }
        audio.start()

        media.start()
        hud.start()
        tray.start()
        screenshots.start()
        agents.start()
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
        if !active { audioVisualizer.setActive(false) }
    }

    /// Open the AirDrop sheet pre-loaded with the given tray items, anchored to
    /// the (temporarily key) overlay panel.
    func airDrop(_ items: [DropItem]) {
        share(items: items.map { $0.url(relativeTo: tray.storageRoot) }, via: .airdrop)
    }

    /// Share freshly dropped files via the user's configured method. The drop
    /// URLs die when the handler returns, so the bytes are copied into a temp
    /// staging dir first, then the service is presented anchored to the panel.
    @discardableResult
    func shareDrop(_ providers: [NSItemProvider]) -> Bool {
        guard !providers.isEmpty else { return false }
        let method = settings.shareMethod
        tray.stageForShare(providers) { [weak self] items in
            self?.share(items: items, via: method)
        }
        return true
    }

    /// Present a sharing service for `urls`, anchored to the (temporarily key)
    /// overlay panel so the device/share picker has a window to attach to.
    func share(items: [Any], via method: ShareMethod) {
        guard !items.isEmpty else { return }
        // A share already in flight owns the only ShareCoordinator, which is the
        // panel's path back to the passive-overlay state. Overwriting it here would
        // deallocate it mid-share (NSSharingService.delegate is weak), so its
        // endShareSheet() would never fire and the overlay would stay latched
        // key-capable. Ignore the reentrant request.
        guard shareCoordinator == nil else {
            Log.tray.notice("Share already presenting; ignoring reentrant request")
            return
        }
        let coordinator = ShareCoordinator { [weak self] in
            self?.windowController?.endShareSheet()
            self?.tray.clearShareStaging()
            // Release after the delegate callback unwinds.
            DispatchQueue.main.async { self?.shareCoordinator = nil }
        }
        shareCoordinator = coordinator

        windowController?.beginShareSheet {
            switch method {
            case .airdrop:
                guard let service = NSSharingService(named: .sendViaAirDrop),
                      service.canPerform(withItems: items) else {
                    Log.tray.error("AirDrop is unavailable for these items")
                    coordinator.finish()
                    return
                }
                service.delegate = coordinator
                service.perform(withItems: items)
            case .blip:
                guard let view = self.windowController?.panelContentView else {
                    Log.tray.error("Share picker has no anchor view")
                    coordinator.finish()
                    return
                }
                coordinator.presentPicker(items: items, matching: method.serviceMatch, in: view)
            }
        }
    }
}

/// Keeps the overlay panel key for the whole async AirDrop interaction, restoring
/// the passive-overlay state only when the share finishes, fails, or is cancelled.
@MainActor
private final class ShareCoordinator: NSObject, NSSharingServiceDelegate, @preconcurrency NSSharingServicePickerDelegate {
    private let onFinish: () -> Void
    private var picker: NSSharingServicePicker?
    private var serviceMatch: String?
    private var didFinish = false
    init(onFinish: @escaping () -> Void) { self.onFinish = onFinish }

    func presentPicker(items: [Any], matching serviceMatch: String, in view: NSView) {
        self.serviceMatch = serviceMatch
        let picker = NSSharingServicePicker(items: items)
        picker.delegate = self
        self.picker = picker
        picker.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
    }

    func sharingServicePicker(
        _ sharingServicePicker: NSSharingServicePicker,
        sharingServicesForItems items: [Any],
        proposedSharingServices proposedServices: [NSSharingService]
    ) -> [NSSharingService] {
        guard let serviceMatch else { return proposedServices }
        return proposedServices.filter { $0.title.localizedCaseInsensitiveContains(serviceMatch) }
    }

    func sharingServicePicker(
        _ sharingServicePicker: NSSharingServicePicker,
        delegateFor sharingService: NSSharingService
    ) -> (any NSSharingServiceDelegate)? {
        self
    }

    func sharingServicePicker(
        _ sharingServicePicker: NSSharingServicePicker,
        didChoose sharingService: NSSharingService?
    ) {
        if sharingService == nil { finish() }
    }

    func sharingService(_ sharingService: NSSharingService, didShareItems items: [Any]) {
        finish()
    }

    func sharingService(_ sharingService: NSSharingService, didFailToShareItems items: [Any], error: Error) {
        finish()
    }

    func finish() {
        guard !didFinish else { return }
        didFinish = true
        picker = nil
        onFinish()
    }
}

extension View {
    /// Inject every manager so views can `@EnvironmentObject` exactly what they need.
    @MainActor
    func injectNotchEnvironment(_ env: AppEnvironment, state: NotchState? = nil) -> some View {
        self
            .environmentObject(env)
            .environmentObject(env.settings)
            .environmentObject(state ?? env.state)
            .environmentObject(env.activities)
            .environmentObject(env.media)
            .environmentObject(env.audioVisualizer)
            .environmentObject(env.hud)
            .environmentObject(env.tray)
            .environmentObject(env.screenshots)
            .environmentObject(env.timer)
            .environmentObject(env.agents)
            .environmentObject(env.battery)
            .environmentObject(env.calendar)
            .environmentObject(env.weather)
            .environmentObject(env.bluetooth)
            .environmentObject(env.focus)
            .environmentObject(env.shortcuts)
            .environmentObject(env.note)
    }
}
