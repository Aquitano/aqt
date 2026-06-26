import SwiftUI
import UniformTypeIdentifiers

/// The one SwiftUI tree hosted in the panel. Draws the black blob, hosts the
/// compact/expanded morph, the HUD overlay, and the drop target. All hit-testing
/// is scoped to the actual content so the rest of the panel stays click-through.
struct NotchRootView: View {
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var state: NotchState
    @EnvironmentObject private var hud: HUDManager
    @EnvironmentObject private var media: MediaManager
    @EnvironmentObject private var activities: ActivityManager
    @EnvironmentObject private var tray: TrayManager
    @EnvironmentObject private var settings: Settings

    @Environment(\.notchGeometry) private var notchSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Namespace private var morph

    /// Frames of the two drop fields in `notchDropSpace`, published by the chooser.
    @State private var zoneFrames: [DropZone: CGRect] = [:]

    var body: some View {
        ZStack(alignment: .top) {
            Color.clear.allowsHitTesting(false)

            if hud.isVisible {
                HUDOverlayView(namespace: morph)
                    .padding(.top, notchSize.height + 12)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                    .zIndex(1)
            }

            notchContent
                .zIndex(2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .coordinateSpace(name: notchDropSpace)
        .onPreferenceChange(DropZoneFrameKey.self) { zoneFrames = $0 }
        .onChange(of: reduceMotion, initial: true) { _, newValue in
            state.reduceMotion = newValue
        }
        // A single drop surface routed by location. Nested onDrop regions don't
        // resolve reliably (the outer one swallows the inner), so the two chooser
        // fields are pure visuals and this delegate hit-tests the drop against their
        // published frames. Kept always-present so the hosting view stays registered
        // for dragged types and the panel is a valid destination the moment the
        // window controller turns it interactive.
        .onDrop(of: [.fileURL, .data], delegate: NotchDropDelegate(
            zoneFrames: zoneFrames,
            state: state,
            onKeep: { tray.handleDrop($0) },
            onShare: { env.shareDrop($0) }
        ))
    }

    // MARK: - Notch content

    private var notchContent: some View {
        let expanded = state.presentation == .expanded
        let size = currentSize
        let bottomRadius = expanded ? NotchMetrics.expandedCornerRadius : NotchMetrics.compactCornerRadius

        return ZStack {
            NotchShape(topRadius: NotchMetrics.compactCornerRadius, bottomRadius: bottomRadius)
                .fill(.black)
                .shadow(color: .black.opacity(expanded ? 0.45 : 0), radius: 18, y: 8)

            Group {
                switch state.presentation {
                case .expanded:
                    // Pinned to its full expanded size so a collapse lets the
                    // shrinking blob clip it away (and fade it) in lockstep,
                    // instead of squishing the content to nothing instantly.
                    ExpandedView(namespace: morph)
                        .frame(width: expandedSize.width, height: expandedSize.height, alignment: .top)
                        .transition(.opacity)
                case .compact:
                    CompactView(namespace: morph)
                        .frame(width: size.width, height: size.height, alignment: .top)
                        .transition(.opacity)
                case .hidden:
                    EmptyView()
                }
            }
            .frame(width: size.width, height: size.height, alignment: .top)
            .clipShape(NotchShape(topRadius: NotchMetrics.compactCornerRadius, bottomRadius: bottomRadius))
        }
        .frame(width: size.width, height: size.height)
        .contentShape(NotchShape(topRadius: NotchMetrics.compactCornerRadius, bottomRadius: bottomRadius))
        .onHover { hovering in handleHover(hovering) }
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private var compactContent: NotchLayout.CompactContent {
        NotchLayout.compactContent(
            hasMedia: !media.track.isEmpty,
            activityLabel: activities.compactActivity?.compactLabel
        )
    }

    private var currentSize: CGSize {
        NotchLayout.contentSize(
            presentation: state.presentation,
            notch: notchSize,
            tab: state.expandedTab,
            hasInfoRow: settings.showWeatherWidget || settings.showCalendarWidget,
            trayEmpty: tray.items.isEmpty,
            compact: compactContent,
            dropActive: state.isDropActive
        )
    }

    private var expandedSize: CGSize {
        NotchLayout.contentSize(
            presentation: .expanded,
            notch: notchSize,
            tab: state.expandedTab,
            hasInfoRow: settings.showWeatherWidget || settings.showCalendarWidget,
            trayEmpty: tray.items.isEmpty,
            compact: .media,
            dropActive: state.isDropActive
        )
    }

    private func handleHover(_ hovering: Bool) {
        if hovering {
            state.expand()
        } else {
            // Always settle back to the compact pill: it keeps the panel on-screen
            // and mouse-tracking alive so the next hover can expand again. Only the
            // status-bar toggle fully hides the notch.
            state.collapse(hasCompactContent: true)
        }
    }
}

/// Routes an inbound file drag to one of the two chooser fields by hit-testing the
/// drop location against their published frames, defaulting to "keep" outside the
/// share field. A single delegate avoids the unreliable resolution of nested
/// `onDrop` regions.
private struct NotchDropDelegate: DropDelegate {
    let zoneFrames: [DropZone: CGRect]
    let state: NotchState
    let onKeep: ([NSItemProvider]) -> Bool
    let onShare: ([NSItemProvider]) -> Bool

    private func zone(at location: CGPoint) -> DropZone {
        if let share = zoneFrames[.share], share.contains(location) { return .share }
        return .keep
    }

    func validateDrop(info: DropInfo) -> Bool {
        info.hasItemsConforming(to: [.fileURL, .data])
    }

    func dropEntered(info: DropInfo) {
        state.beginDropTargeting()
        state.activeDropZone = zone(at: info.location)
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        state.activeDropZone = zone(at: info.location)
        return DropProposal(operation: .copy)
    }

    func dropExited(info: DropInfo) {
        state.activeDropZone = nil
    }

    func performDrop(info: DropInfo) -> Bool {
        // Route to the field the pointer was last over (what the user saw
        // highlighted) rather than a fresh hit-test: by drop time the controller may
        // have torn the chooser down on mouse-up, leaving the published frames stale.
        let target = state.activeDropZone ?? zone(at: info.location)
        let providers = info.itemProviders(for: [.fileURL, .data])
        state.activeDropZone = nil
        state.isDropActive = false
        let accepted = target == .share ? onShare(providers) : onKeep(providers)
        if accepted { Haptics.tap(.alignment) }
        return accepted
    }
}
