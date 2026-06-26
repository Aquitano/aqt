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
        .onChange(of: reduceMotion, initial: true) { _, newValue in
            state.reduceMotion = newValue
        }
        // A single, always-present drop surface so the hosting view stays registered
        // for dragged types and the panel is a valid destination the moment the
        // window controller turns it interactive. Nested per-field onDrop regions
        // don't resolve reliably, and SwiftUI's drop location proved unreliable too,
        // so the two chooser fields are pure visuals and the field is resolved from
        // the live cursor position in screen space (see `dropZoneAtCursor`).
        .onDrop(of: [.fileURL, .data], delegate: NotchDropDelegate(
            state: state,
            resolveZone: { env.windowController?.dropZoneAtCursor() ?? .keep },
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

/// Always-present drop surface for the panel. The field (keep vs share) is decided
/// by `resolveZone`, which reads the live cursor position in screen space — SwiftUI's
/// `DropInfo.location` is unreliable inside this overlay.
private struct NotchDropDelegate: DropDelegate {
    let state: NotchState
    let resolveZone: () -> DropZone
    let onKeep: ([NSItemProvider]) -> Bool
    let onShare: ([NSItemProvider]) -> Bool

    func validateDrop(info: DropInfo) -> Bool {
        info.hasItemsConforming(to: [.fileURL, .data])
    }

    func dropEntered(info: DropInfo) {
        // Backup: the window controller normally opens the chooser first.
        state.beginDropTargeting()
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .copy)
    }

    func performDrop(info: DropInfo) -> Bool {
        let target = resolveZone()
        let providers = info.itemProviders(for: [.fileURL, .data])
        state.activeDropZone = nil
        state.isDropActive = false
        let accepted = target == .share ? onShare(providers) : onKeep(providers)
        if accepted { Haptics.tap(.alignment) }
        Log.tray.notice("drop routed to \(target == .share ? "share" : "keep")")
        return accepted
    }
}
