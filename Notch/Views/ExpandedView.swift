import SwiftUI
import AppKit

/// The full expanded panel body. Lives inside the black notch blob, so every
/// chrome surface here is glass-on-black (never glass on the pill itself). A
/// single `GlassEffectContainer` lets the tab strip and the cards below it
/// blend as one liquid-glass system.
struct ExpandedView: View {
    let namespace: Namespace.ID

    @EnvironmentObject private var state: NotchState
    @EnvironmentObject private var settings: Settings
    @EnvironmentObject private var screenshots: ScreenshotMonitor

    @Environment(\.notchGeometry) private var notchSize
    @Environment(\.notchExpandedWidth) private var expandedWidth

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            VStack(spacing: 12) {
                if !state.isDropActive, !settings.floatingTabBar {
                    NotchTabStrip()
                }
                content
            }
            // The blob insets its own left/right edges by shoulderInset (not the
            // corner radius), so the horizontal padding must add that same amount
            // back to read as a consistent 12pt visible margin like the bottom;
            // using the corner radius left the sides pinched.
            .padding(.horizontal, 12 + NotchMetrics.shoulderInset(
                width: expandedWidth, notchWidth: notchSize.width))
            .padding(.bottom, 12)
            // Keep the tap targets well clear of the physical notch / menu-bar band,
            // which otherwise crowds the top tab row and eats clicks near the notch.
            .padding(.top, notchSize.height + 14)
        }
        .foregroundStyle(.white)
        .tint(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    // MARK: - Body

    @ViewBuilder
    private var content: some View {
        if state.isDropActive {
            DropChooserView()
        } else {
            switch state.expandedTab {
            case .home:
                home
            case .agents:
                AgentsView()
            case .media:
                MediaPlayerView(namespace: namespace)
            case .timer:
                TimerPanelView()
            case .tray:
                TrayView()
            }
        }
    }

    private var home: some View {
        VStack(spacing: 10) {
            if !screenshots.candidates.isEmpty {
                ScreenshotCandidateCard()
            }
            WidgetGridView()
        }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
