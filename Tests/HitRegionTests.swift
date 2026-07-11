import XCTest

/// `HitRegion.rect` is a pure function of a `LayoutSnapshot`, so the sizing and
/// the centered-and-pinned-to-top positioning are table-tested here without a
/// live window, panel, or `AppEnvironment`.
final class HitRegionTests: XCTestCase {

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

    private func assertRect(
        _ rect: CGRect, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(rect.origin.x, x, accuracy: 0.001, "x", file: file, line: line)
        XCTAssertEqual(rect.origin.y, y, accuracy: 0.001, "y", file: file, line: line)
        XCTAssertEqual(rect.width, w, accuracy: 0.001, "width", file: file, line: line)
        XCTAssertEqual(rect.height, h, accuracy: 0.001, "height", file: file, line: line)
    }

    // MARK: - Deterministic (font-independent) sizes

    func testHiddenIsNotchSizedAndPinnedTop() {
        // size == notch (200x32); centered: x = 500 - 100, pinned: y = 600 - 32.
        assertRect(HitRegion.rect(snapshot(.hidden)), x: 400, y: 568, w: 200, h: 32)
    }

    func testCompactNoneMatchesNotchWithNoHeightBump() {
        // .none adds no width and no +4 height bump.
        assertRect(HitRegion.rect(snapshot(.compact, compact: .none)), x: 400, y: 568, w: 200, h: 32)
    }

    func testCompactMediaWidthAndHeightBump() {
        // media slot 47 -> extra = ceil(47*2) + 18*2 = 130; width 330, height 32+4.
        assertRect(HitRegion.rect(snapshot(.compact, compact: .media)), x: 335, y: 564, w: 330, h: 36)
    }

    func testExpandedHomeNoInfoRow() {
        // body 175 + notch 32 = 207; width 540 -> x = 500 - 270.
        assertRect(HitRegion.rect(snapshot(.expanded, tab: .home)), x: 230, y: 393, w: 540, h: 207)
    }

    func testExpandedHomeWithInfoRowIsTaller() {
        // body 296 + 32 = 328.
        assertRect(HitRegion.rect(snapshot(.expanded, tab: .home, hasInfoRow: true)), x: 230, y: 272, w: 540, h: 328)
    }

    func testExpandedAgentsTab() {
        // body 320 + 32 = 352.
        assertRect(HitRegion.rect(snapshot(.expanded, tab: .agents)), x: 230, y: 248, w: 540, h: 352)
    }

    func testExpandedTrayEmptyVsFilled() {
        assertRect(HitRegion.rect(snapshot(.expanded, tab: .tray, trayEmpty: true)), x: 230, y: 388, w: 540, h: 212)
        assertRect(HitRegion.rect(snapshot(.expanded, tab: .tray, trayEmpty: false)), x: 230, y: 322, w: 540, h: 278)
    }

    func testDropActiveOverridesTabHeight() {
        // dropActive forces the chooser height (188 + 32 = 220) regardless of tab.
        let tray = HitRegion.rect(snapshot(.expanded, tab: .tray, trayEmpty: false, dropActive: true))
        let agents = HitRegion.rect(snapshot(.expanded, tab: .agents, dropActive: true))
        assertRect(tray, x: 230, y: 380, w: 540, h: 220)
        XCTAssertEqual(tray, agents)
    }

    // MARK: - Structural (font-dependent) properties

    func testAgentPillIsWiderThanNotchAndTallerThanNone() {
        let agent = HitRegion.rect(snapshot(.compact, compact: .agent))
        XCTAssertGreaterThan(agent.width, notch.width)
        XCTAssertEqual(agent.height, notch.height + 4, accuracy: 0.001)
    }

    func testRectStaysCenteredOnPanelMidX() {
        // Whatever the size, the content is horizontally centered in the panel.
        for snap in [snapshot(.hidden), snapshot(.compact, compact: .media), snapshot(.expanded, tab: .agents)] {
            let rect = HitRegion.rect(snap)
            XCTAssertEqual(rect.midX, panel.midX, accuracy: 0.001)
        }
    }

    func testExpandedWidthUsesDisplayProfile() {
        let rect = HitRegion.rect(snapshot(.expanded, expandedWidth: 620))
        XCTAssertEqual(rect.width, 620, accuracy: 0.001)
        XCTAssertEqual(rect.midX, panel.midX, accuracy: 0.001)
    }
}
