import SwiftUI
import UniformTypeIdentifiers

/// The one SwiftUI tree hosted in the panel. Draws the black blob, hosts the
/// compact/expanded morph, the HUD overlay, and the drop target. All hit-testing
/// is scoped to the actual content so the rest of the panel stays click-through.
struct NotchRootView: View {
    @EnvironmentObject private var state: NotchState
    @EnvironmentObject private var hud: HUDManager
    @EnvironmentObject private var media: MediaManager
    @EnvironmentObject private var activities: ActivityManager
    @EnvironmentObject private var tray: TrayManager

    @Environment(\.notchGeometry) private var notchSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @Namespace private var morph
    @State private var dropTargeted = false

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
        .onChange(of: dropTargeted) { _, targeted in
            if targeted {
                state.expand()
                state.select(tab: .tray)
            }
        }
        .onDrop(of: [.fileURL, .data], isTargeted: $dropTargeted) { providers in
            tray.handleDrop(providers)
        }
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
                    ExpandedView(namespace: morph)
                case .compact:
                    CompactView(namespace: morph)
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

    private var currentSize: CGSize {
        switch state.presentation {
        case .hidden:
            return notchSize
        case .compact:
            let hasContent = activities.compactActivity != nil || !media.track.isEmpty
            return CGSize(
                width: notchSize.width + (hasContent ? 130 : 0),
                height: notchSize.height + (hasContent ? 4 : 0)
            )
        case .expanded:
            let base = state.expandedTab == .media || (state.expandedTab == .home && !media.track.isEmpty)
                ? NotchMetrics.expandedMediaSize
                : NotchMetrics.expandedSize
            return CGSize(width: base.width, height: base.height + notchSize.height)
        }
    }

    private func handleHover(_ hovering: Bool) {
        if hovering {
            if state.presentation == .compact { state.expand() }
        } else {
            if state.presentation == .expanded {
                let hasContent = activities.compactActivity != nil || !media.track.isEmpty
                state.collapse(hasCompactContent: hasContent)
            }
        }
    }
}
