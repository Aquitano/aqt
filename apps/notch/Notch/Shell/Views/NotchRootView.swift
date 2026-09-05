import AppKit
import NotchCore
import SwiftUI
import UniformTypeIdentifiers

/// The one SwiftUI tree hosted in the panel. Draws the black blob, hosts the
/// compact/expanded morph, the HUD overlay, and the drop target. All hit-testing
/// is scoped to the actual content so the rest of the panel stays click-through.
struct NotchRootView: View {
    var showsHUD = true
    @Environment(AppEnvironment.self) private var env
    @Environment(NotchState.self) private var state
    @Environment(HUDManager.self) private var hud
    @Environment(MediaManager.self) private var media
    @Environment(ActivityManager.self) private var activities
    @Environment(TrayManager.self) private var tray
    @Environment(Settings.self) private var settings

    @Environment(\.notchGeometry) private var notchSize
    @Environment(\.notchExpandedWidth) private var expandedWidth
    @Environment(\.notchUsesVirtualChrome) private var usesVirtualChrome
    @Environment(\.notchDisplayKey) private var displayKey
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

            // Detached tab capsule below the blob. Mounted through the whole
            // close (fading with `isCollapsing`, like the expanded body). Hover
            // is decided by the window controller from the content's hit rect,
            // which covers the dock and the gap above it.
            if settings.notch.tabBarStyle == .floating, state.isExpanded || state.isCollapsing, !state.isDropActive {
                NotchTabStrip(floating: true)
                    .padding(.top, expandedSize.height + NotchLayout.floatingDockGap)
                    .opacity(state.isExpanded ? 1 : 0)
                    .zIndex(3)
            }
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
        .onDrop(of: TrayDropCapabilities.acceptedTypes, delegate: NotchDropDelegate(
            state: state,
            resolveZone: { env.windowController?.dropZoneAtCursor() ?? .keep },
            moveEnabled: { settings.tray.moveEnabled },
            originalFileURLs: { env.windowController?.originalFileURLsForDrop() ?? [] },
            onKeep: { tray.handleDrop($0, moveOriginalURLs: $1) },
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
            NotchShape(
                topRadius: NotchMetrics.compactCornerRadius,
                bottomRadius: bottomRadius,
                usesVirtualChrome: usesVirtualChrome,
                notchWidth: notchSize.width
            )
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
            .clipShape(NotchShape(
                topRadius: NotchMetrics.compactCornerRadius,
                bottomRadius: bottomRadius,
                usesVirtualChrome: usesVirtualChrome,
                notchWidth: notchSize.width
            ))
        }
        .frame(width: size.width, height: size.height)
        .scaleEffect(hoverGrow ? 1.06 : 1.0, anchor: .top)
        .animation(NotchAnimation.hoverGrow(reduceMotion: state.reduceMotion), value: hoverGrow)
        .contentShape(NotchShape(
            topRadius: NotchMetrics.compactCornerRadius,
            bottomRadius: bottomRadius,
            usesVirtualChrome: usesVirtualChrome,
            notchWidth: notchSize.width
        ))
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private var compactContent: NotchLayout.CompactContent {
        NotchLayout.compactContent(
            hasMedia: settings.media.compactNowPlaying && !media.track.isEmpty,
            agentCount: activities.compactActivity?.agentCount,
            activityLabel: activities.compactActivity.map { ActivityPresenter.compactLabel(for: $0.kind) },
            trayItemCount: tray.items.count
        )
    }

    private var currentSize: CGSize {
        NotchLayout.contentSize(
            presentation: state.presentation,
            notch: notchSize,
            expandedWidth: expandedWidth,
            tab: state.expandedTab,
            hasInfoRow: settings.hasInfoRowWidgets(for: displayKey),
            trayEmpty: tray.items.isEmpty,
            compact: compactContent,
            dropActive: state.isDropActive,
            tabBarStyle: settings.notch.tabBarStyle
        )
    }

    private var expandedSize: CGSize {
        NotchLayout.contentSize(
            presentation: .expanded,
            notch: notchSize,
            expandedWidth: expandedWidth,
            tab: state.expandedTab,
            hasInfoRow: settings.hasInfoRowWidgets(for: displayKey),
            trayEmpty: tray.items.isEmpty,
            compact: .media,
            dropActive: state.isDropActive,
            tabBarStyle: settings.notch.tabBarStyle
        )
    }

}

/// Always-present drop surface for the panel. The field (keep vs share) is decided
/// by `resolveZone`, which reads the live cursor position in screen space — SwiftUI's
/// `DropInfo.location` is unreliable inside this overlay.
private struct NotchDropDelegate: DropDelegate {
    let state: NotchState
    let resolveZone: () -> DropZone
    let moveEnabled: () -> Bool
    let originalFileURLs: () -> [URL]
    let onKeep: ([NSItemProvider], [URL]) -> Bool
    let onShare: ([NSItemProvider]) -> Bool

    func validateDrop(info: DropInfo) -> Bool {
        info.hasItemsConforming(to: TrayDropCapabilities.acceptedTypes)
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
        let canMove = moveEnabled()
            && NSEvent.modifierFlags.contains(.option)
            && !originalFileURLs().isEmpty
        return DropProposal(operation: canMove ? .move : .copy)
    }

    func performDrop(info: DropInfo) -> Bool {
        let target = resolveZone()
        let providers = info.itemProviders(for: TrayDropCapabilities.acceptedTypes)
        state.activeDropZone = nil
        state.isDropActive = false
        let moveURLs = moveEnabled() && NSEvent.modifierFlags.contains(.option)
            ? originalFileURLs() : []
        let accepted = target == .share ? onShare(providers) : onKeep(providers, moveURLs)
        if accepted { Haptics.tap(.alignment) }
        Log.tray.notice("drop routed to \(target == .share ? "share" : "keep")")
        return accepted
    }
}
