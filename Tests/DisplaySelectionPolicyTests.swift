import CoreGraphics
import XCTest

final class DisplaySelectionPolicyTests: XCTestCase {
    private func display(
        _ key: String,
        x: CGFloat = 0,
        builtIn: Bool = false,
        main: Bool = false
    ) -> DisplayDescriptor {
        DisplayDescriptor(
            key: key,
            displayID: UInt32(abs(key.hashValue % 10_000)),
            name: key,
            frame: CGRect(x: x, y: 0, width: 1_920, height: 1_080),
            safeAreaTop: builtIn ? 32 : 0,
            auxiliaryLeftWidth: nil,
            auxiliaryRightWidth: nil,
            isBuiltIn: builtIn,
            isMain: main
        )
    }

    func testBuiltInPlacementIgnoresInputOrdering() {
        let external = display("external", main: true)
        let builtIn = display("built-in", x: -1_512, builtIn: true)

        let result = DisplaySelectionPolicy.resolve(
            displays: [external, builtIn], placement: .builtIn
        )

        XCTAssertEqual(result.targets.map(\.key), ["built-in"])
        XCTAssertEqual(result.reason, .requested)
    }

    func testBuiltInPlacementFallsBackToMainWhenLidIsClosed() {
        let secondary = display("secondary", x: -1_920)
        let main = display("main", main: true)

        let result = DisplaySelectionPolicy.resolve(
            displays: [secondary, main], placement: .builtIn
        )

        XCTAssertEqual(result.targets.map(\.key), ["main"])
        XCTAssertEqual(result.reason, .builtInUnavailable)
    }

    func testMainPlacementFallsBackToBuiltInWhenMainFlagIsMissing() {
        let external = display("external", x: 1_512)
        let builtIn = display("built-in", builtIn: true)

        let result = DisplaySelectionPolicy.resolve(
            displays: [external, builtIn], placement: .main
        )

        XCTAssertEqual(result.targets.map(\.key), ["built-in"])
        XCTAssertEqual(result.reason, .mainUnavailable)
    }

    func testAllPlacementIsDeterministicAndPutsMainFirst() {
        let right = display("right", x: 1_920)
        let builtInMain = display("built-in", builtIn: true, main: true)
        let left = display("left", x: -1_920)

        let result = DisplaySelectionPolicy.resolve(
            displays: [right, builtInMain, left], placement: .all
        )

        XCTAssertEqual(result.targets.map(\.key), ["built-in", "left", "right"])
    }

    func testNoDisplaysReturnsExplicitEmptySelection() {
        let result = DisplaySelectionPolicy.resolve(displays: [], placement: .main)
        XCTAssertTrue(result.targets.isEmpty)
        XCTAssertEqual(result.reason, .noDisplays)
    }

    func testFollowActiveDisplayOverridesSinglePlacement() {
        let builtIn = display("built-in", builtIn: true, main: true)
        let external = display("external", x: 1_512)
        let result = DisplaySelectionPolicy.resolve(
            displays: [builtIn, external], placement: .builtIn,
            followActiveDisplay: true, activeDisplayKey: "external"
        )
        XCTAssertEqual(result.targets.map(\.key), ["external"])
        XCTAssertEqual(result.reason, .activeDisplay)
    }

    func testFollowActiveFallsBackWhenPointerTargetDisappears() {
        let builtIn = display("built-in", builtIn: true, main: true)
        let result = DisplaySelectionPolicy.resolve(
            displays: [builtIn], placement: .builtIn,
            followActiveDisplay: true, activeDisplayKey: "disconnected"
        )
        XCTAssertEqual(result.targets.map(\.key), ["built-in"])
        XCTAssertEqual(result.reason, .activeDisplayUnavailable)
    }

    func testAllPlacementIgnoresFollowActiveDisplay() {
        let main = display("main", main: true)
        let other = display("other", x: 1_920)
        let result = DisplaySelectionPolicy.resolve(
            displays: [main, other], placement: .all,
            followActiveDisplay: true, activeDisplayKey: "other"
        )
        XCTAssertEqual(result.targets.map(\.key), ["main", "other"])
    }

    func testDisplayProfileClampsEveryAdjustment() {
        let profile = DisplayProfile(
            displayKey: "display", compactWidthAdjustment: 999,
            compactHeightAdjustment: -999, horizontalOffset: 999,
            verticalOffset: -999, expandedWidthAdjustment: 999
        ).normalized
        XCTAssertEqual(profile.compactWidthAdjustment, 160)
        XCTAssertEqual(profile.compactHeightAdjustment, -6)
        XCTAssertEqual(profile.horizontalOffset, 240)
        XCTAssertEqual(profile.verticalOffset, 0)
        XCTAssertEqual(profile.expandedWidthAdjustment, 180)
    }

    func testStableKeySurvivesReconnectWhenSerialExists() {
        let before = DisplayDescriptor.stableKey(
            unitNumber: 7, vendor: 10, model: 20, serial: 30,
            name: "Studio Display", isBuiltIn: false
        )
        let after = DisplayDescriptor.stableKey(
            unitNumber: 99, vendor: 10, model: 20, serial: 30,
            name: "Studio Display", isBuiltIn: false
        )
        XCTAssertEqual(before, after)
    }

    func testSeriallessIdenticalDisplaysRemainDistinctWhileOnline() {
        let first = DisplayDescriptor.stableKey(
            unitNumber: 7, vendor: 10, model: 20, serial: 0,
            name: "Generic Panel", isBuiltIn: false
        )
        let second = DisplayDescriptor.stableKey(
            unitNumber: 8, vendor: 10, model: 20, serial: 0,
            name: "Generic Panel", isBuiltIn: false
        )
        XCTAssertNotEqual(first, second)
    }

    func testHostInteractionOwnerSurvivesActiveDisplayChanges() {
        let key = DisplayHostPolicy.interactionKey(
            availableKeys: ["left", "right"], current: "left", active: "right"
        )
        XCTAssertEqual(key, "left")
    }

    func testHostInteractionFallsBackWhenOwnerDisconnects() {
        let key = DisplayHostPolicy.interactionKey(
            availableKeys: ["right"], current: "left", active: "right"
        )
        XCTAssertEqual(key, "right")
    }

    func testSharedRenderingPrimaryFollowsActiveDisplay() {
        let key = DisplayHostPolicy.primaryKey(
            availableKeys: ["left", "right"], active: "right", interaction: "left"
        )
        XCTAssertEqual(key, "right")
    }

    func testMigrationKeepsPresentationWhenInteractionDisplayRemains() {
        let instruction = DisplayHostMigrationPolicy.instruction(
            targetStillAvailable: true, wasExpanded: true,
            wasHovering: true, hasTransientInteraction: true
        )
        XCTAssertEqual(instruction, .keepPresentation)
    }

    func testMigrationCollapsesHoverExpansionWhenDisplayDisappears() {
        let instruction = DisplayHostMigrationPolicy.instruction(
            targetStillAvailable: false, wasExpanded: true,
            wasHovering: true, hasTransientInteraction: false
        )
        XCTAssertEqual(instruction, .collapse)
    }

    func testMigrationRestoresProgrammaticExpansionOnReplacement() {
        let instruction = DisplayHostMigrationPolicy.instruction(
            targetStillAvailable: false, wasExpanded: true,
            wasHovering: false, hasTransientInteraction: false
        )
        XCTAssertEqual(instruction, .restoreProgrammaticExpansion)
    }

    func testMigrationEndsTransientInteractionBeforeRemovingHost() {
        let instruction = DisplayHostMigrationPolicy.instruction(
            targetStillAvailable: false, wasExpanded: true,
            wasHovering: false, hasTransientInteraction: true
        )
        XCTAssertEqual(instruction, .endTransientInteractionAndCollapse)
    }
}
