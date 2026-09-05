import CoreGraphics
import Testing
import NotchCore

/// `HitRegion.rect` is a pure function of a `LayoutSnapshot`, so the sizing and
/// the centered-and-pinned-to-top positioning are table-tested here without a
/// live window, panel, or `AppEnvironment`.
struct HitRegionTests {

    private let notch = CGSize(width: 200, height: 32)
    // midX = 500, maxY = 600.
    private let panel = CGRect(x: 100, y: 200, width: 800, height: 400)

    private func snapshot(
        _ presentation: NotchState.Presentation,
        tab: NotchState.ExpandedTab = .home,
        hasInfoRow: Bool = false,
        trayEmpty: Bool = true,
        compact: NotchLayout.CompactContent = .none,
        dropActive: Bool = false,
        expandedWidth: CGFloat = NotchMetrics.expandedWidth
    ) -> LayoutSnapshot {
        LayoutSnapshot(
            presentation: presentation, notch: notch, expandedWidth: expandedWidth,
            panelFrame: panel, tab: tab,
            hasInfoRow: hasInfoRow, trayEmpty: trayEmpty, compact: compact, dropActive: dropActive
        )
    }

    private func expectRect(
        _ rect: CGRect, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat,
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        #expect(abs(rect.origin.x - x) < 0.001, "x", sourceLocation: sourceLocation)
        #expect(abs(rect.origin.y - y) < 0.001, "y", sourceLocation: sourceLocation)
        #expect(abs(rect.width - w) < 0.001, "width", sourceLocation: sourceLocation)
        #expect(abs(rect.height - h) < 0.001, "height", sourceLocation: sourceLocation)
    }

    // MARK: - Deterministic (font-independent) sizes

    @Test func hiddenIsNotchSizedAndPinnedTop() {
        // size == notch (200x32); centered: x = 500 - 100, pinned: y = 600 - 32.
        expectRect(HitRegion.rect(snapshot(.hidden)), x: 400, y: 568, w: 200, h: 32)
    }

    @Test func compactNoneMatchesNotchWithNoHeightBump() {
        // .none adds no width and no +4 height bump.
        expectRect(HitRegion.rect(snapshot(.compact, compact: .none)), x: 400, y: 568, w: 200, h: 32)
    }

    @Test func compactMediaWidthAndHeightBump() {
        // media slot 47 -> extra = ceil(47*2) + 18*2 = 130; width 330, height 32+4.
        expectRect(HitRegion.rect(snapshot(.compact, compact: .media)), x: 335, y: 564, w: 330, h: 36)
    }

    @Test func compactTrayCountUsesTotalCountFallback() {
        let content = NotchLayout.compactContent(
            hasMedia: false, agentCount: nil, activityLabel: nil, trayItemCount: 3
        )
        #expect(content == .activity(label: "3 items"))
        #expect(NotchLayout.compactExtraWidth(content) > 0)
    }

    @Test func expandedHomeNoInfoRow() {
        // body 175 + notch 32 = 207; width 540 -> x = 500 - 270.
        expectRect(HitRegion.rect(snapshot(.expanded, tab: .home)), x: 230, y: 393, w: 540, h: 207)
    }

    @Test func expandedHomeWithInfoRowIsTaller() {
        // body 296 + 32 = 328.
        expectRect(HitRegion.rect(snapshot(.expanded, tab: .home, hasInfoRow: true)), x: 230, y: 272, w: 540, h: 328)
    }

    @Test func expandedAgentsTab() {
        // body 320 + 32 = 352.
        expectRect(HitRegion.rect(snapshot(.expanded, tab: .agents)), x: 230, y: 248, w: 540, h: 352)
    }

    @Test func expandedTrayEmptyVsFilled() {
        // Collections and visible expiry add one compact row to the tray body.
        expectRect(HitRegion.rect(snapshot(.expanded, tab: .tray, trayEmpty: true)), x: 230, y: 364, w: 540, h: 236)
        expectRect(HitRegion.rect(snapshot(.expanded, tab: .tray, trayEmpty: false)), x: 230, y: 282, w: 540, h: 318)
    }

    @Test func dropActiveOverridesTabHeight() {
        // dropActive forces the chooser height (188 + 32 = 220) regardless of tab.
        let tray = HitRegion.rect(snapshot(.expanded, tab: .tray, trayEmpty: false, dropActive: true))
        let agents = HitRegion.rect(snapshot(.expanded, tab: .agents, dropActive: true))
        expectRect(tray, x: 230, y: 380, w: 540, h: 220)
        #expect(tray == agents)
    }

    @Test func floatingTabBarShrinksBlobButCoversTheDock() {
        let inside = HitRegion.rect(snapshot(.expanded, tab: .home))
        var floatingSnapshot = snapshot(.expanded, tab: .home)
        floatingSnapshot.tabBarStyle = .floating
        let floating = HitRegion.rect(floatingSnapshot)

        // Blob gives back the in-blob strip; the region extends past the blob to
        // cover the detached dock capsule. Still pinned to the panel top.
        let expected = inside.height - NotchLayout.tabStripAllowance
            + NotchLayout.floatingDockGap + NotchLayout.floatingDockHeight
        #expect(abs(floating.height - expected) < 0.001)
        #expect(abs(floating.maxY - inside.maxY) < 0.001)
    }

    @Test func floatingTabBarAddsNothingDuringDropChooser() {
        // The chooser replaces the tabs, so the dock (and its region) is absent.
        var floatingSnapshot = snapshot(.expanded, tab: .tray, dropActive: true)
        floatingSnapshot.tabBarStyle = .floating
        #expect(HitRegion.rect(floatingSnapshot)
            == HitRegion.rect(snapshot(.expanded, tab: .tray, dropActive: true)))
    }

    @Test func shoulderTabsShrinkTheBlobWithNoDock() {
        let inside = HitRegion.rect(snapshot(.expanded, tab: .home))
        var shoulderSnapshot = snapshot(.expanded, tab: .home)
        shoulderSnapshot.tabBarStyle = .shoulders
        let shoulders = HitRegion.rect(shoulderSnapshot)

        // The icons live in the notch band the blob already spends, so the body
        // gives the strip's row back and nothing hangs below the blob.
        #expect(abs(shoulders.height - (inside.height - NotchLayout.tabStripAllowance)) < 0.001)
        #expect(abs(shoulders.maxY - inside.maxY) < 0.001)
    }

    // MARK: - Structural (font-dependent) properties

    @Test func agentPillIsWiderThanNotchAndTallerThanNone() {
        let agent = HitRegion.rect(snapshot(.compact, compact: .agent(count: 1)))
        #expect(agent.width > notch.width)
        #expect(abs(agent.height - (notch.height + 4)) < 0.001)
    }

    @Test func agentPillWidthStableAcrossSessionCounts() {
        // One spinner regardless of session count: the pill must not resize as
        // sessions come and go (only the count digits could ever widen it).
        let one = NotchLayout.compactExtraWidth(.agent(count: 1))
        let three = NotchLayout.compactExtraWidth(.agent(count: 3))
        let nine = NotchLayout.compactExtraWidth(.agent(count: 9))
        #expect(abs(one - three) < 0.001)
        #expect(abs(three - nine) < 0.001)
    }

    @Test func rectStaysCenteredOnPanelMidX() {
        // Whatever the size, the content is horizontally centered in the panel.
        for snap in [snapshot(.hidden), snapshot(.compact, compact: .media), snapshot(.expanded, tab: .agents)] {
            let rect = HitRegion.rect(snap)
            #expect(abs(rect.midX - panel.midX) < 0.001)
        }
    }

    @Test func expandedWidthUsesDisplayProfile() {
        let rect = HitRegion.rect(snapshot(.expanded, expandedWidth: 620))
        #expect(abs(rect.width - 620) < 0.001)
        #expect(abs(rect.midX - panel.midX) < 0.001)
    }
}
