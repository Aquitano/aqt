import SwiftUI
import UniformTypeIdentifiers

/// The one SwiftUI tree hosted in the panel. Draws the black blob, hosts the
/// compact/expanded morph, the HUD overlay, and the drop target. All hit-testing
/// is scoped to the actual content so the rest of the panel stays click-through.
struct NotchRootView: View {
    var showsHUD = true
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var state: NotchState
    @EnvironmentObject private var hud: HUDManager
    @EnvironmentObject private var media: MediaManager
    @EnvironmentObject private var activities: ActivityManager
    @EnvironmentObject private var tray: TrayManager
    @EnvironmentObject private var settings: Settings

    @Environment(\.notchGeometry) private var notchSize
    @Environment(\.notchExpandedWidth) private var expandedWidth
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Namespace private var morph

    var body: some View {
        ZStack(alignment: .top) {
            Color.clear.allowsHitTesting(false)

            if showsHUD && hud.isVisible {
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
        // Hover the compact pill and it swells slightly first (an intent preview),
        // then opens after a brief delay — a softer, more deliberate reveal.
        let hoverGrow = state.presentation == .compact && state.isHovering && !state.isDropActive

        return ZStack {
            NotchShape(topRadius: NotchMetrics.compactCornerRadius, bottomRadius: bottomRadius, notchWidth: notchSize.width)
                .fill(.black)
                .shadow(color: .black.opacity(expanded ? 0.45 : 0), radius: 18, y: 8)

            ZStack(alignment: .top) {
                // Expanded body kept mounted (fading via opacity) through the whole
                // close instead of removed by a `.transition`: a view SwiftUI is
                // removing renders in its own layer at its pre-collapse size, so the
                // blob's `clipShape` can't retract it and the widgets hang below the
                // shrinking blob. As a plain child it clips into the notch in
                // lockstep. `isCollapsing` holds it for the close, then drops it so
                // the idle pill never keeps the widget grid (and its managers) alive.
                if state.isExpanded || state.isCollapsing {
                    ExpandedView(namespace: morph)
                        .frame(width: expandedSize.width, height: expandedSize.height, alignment: .top)
                        .opacity(state.isExpanded ? 1 : 0)
                        .accessibilityAction(named: "Collapse notch") {
                            state.collapse()
                        }
                }

                if state.presentation == .compact {
                    CompactView(namespace: morph)
                        .frame(width: size.width, height: size.height, alignment: .top)
                        .transition(.opacity)
                        // The pill expands on hover only, which VoiceOver can't do;
                        // expose it as a button whose activation opens the panel.
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Notch")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityAction { state.expand() }
                        .accessibilityAction(named: "Expand notch") { state.expand() }
                }
            }
            .frame(width: size.width, height: size.height, alignment: .top)
            .clipShape(NotchShape(topRadius: NotchMetrics.compactCornerRadius, bottomRadius: bottomRadius, notchWidth: notchSize.width))
        }
        .frame(width: size.width, height: size.height)
        .scaleEffect(hoverGrow ? 1.06 : 1.0, anchor: .top)
        .animation(NotchAnimation.hoverGrow(reduceMotion: state.reduceMotion), value: hoverGrow)
        .contentShape(NotchShape(topRadius: NotchMetrics.compactCornerRadius, bottomRadius: bottomRadius, notchWidth: notchSize.width))
        .onHover { hovering in handleHover(hovering) }
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private var compactContent: NotchLayout.CompactContent {
        NotchLayout.compactContent(
            hasMedia: settings.showCompactNowPlaying && !media.track.isEmpty,
            isAgent: activities.compactActivity?.isAgent ?? false,
            activityLabel: activities.compactActivity.map { ActivityPresenter.compactLabel(for: $0.kind) }
        )
    }

    private var currentSize: CGSize {
        NotchLayout.contentSize(
            presentation: state.presentation,
            notch: notchSize,
            expandedWidth: expandedWidth,
            tab: state.expandedTab,
            hasInfoRow: settings.hasInfoRowWidgets,
            trayEmpty: tray.items.isEmpty,
            compact: compactContent,
            dropActive: state.isDropActive
        )
    }

    private var expandedSize: CGSize {
        NotchLayout.contentSize(
            presentation: .expanded,
            notch: notchSize,
            expandedWidth: expandedWidth,
            tab: state.expandedTab,
            hasInfoRow: settings.hasInfoRowWidgets,
            trayEmpty: tray.items.isEmpty,
            compact: .media,
            dropActive: state.isDropActive
        )
    }

    private func handleHover(_ hovering: Bool) {
        // Route through `hoverChanged` so `isHovering` (which drives the pill's
        // hover-swell) updates in lockstep with the expand/collapse timers. On exit
        // it settles back to the compact pill, keeping the panel on-screen and
        // mouse-tracking alive so the next hover can expand again.
        state.hoverChanged(hovering)
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

    func dropExited(info: DropInfo) {
        // Matching backup for dropEntered: if the controller missed the enter it
        // also misses the exit, so without this a drag-away or Esc leaves
        // isDropActive true and collapse() bails forever, pinning the panel open.
        state.endDropTargeting()
        state.collapse()
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
