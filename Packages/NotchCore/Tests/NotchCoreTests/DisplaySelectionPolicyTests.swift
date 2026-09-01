import CoreGraphics
@testable import NotchCore
import Testing

struct DisplaySelectionPolicyTests {
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

    @Test func builtInPlacementIgnoresInputOrdering() {
        let external = display("external", main: true)
        let builtIn = display("built-in", x: -1_512, builtIn: true)

        let result = DisplaySelectionPolicy.resolve(
            displays: [external, builtIn], placement: .builtIn
        )

        #expect(result.targets.map(\.key) == ["built-in"])
        #expect(result.reason == .requested)
    }

    @Test func builtInPlacementFallsBackToMainWhenLidIsClosed() {
        let secondary = display("secondary", x: -1_920)
        let main = display("main", main: true)

        let result = DisplaySelectionPolicy.resolve(
            displays: [secondary, main], placement: .builtIn
        )

        #expect(result.targets.map(\.key) == ["main"])
        #expect(result.reason == .builtInUnavailable)
    }

    @Test func mainPlacementFallsBackToBuiltInWhenMainFlagIsMissing() {
        let external = display("external", x: 1_512)
        let builtIn = display("built-in", builtIn: true)

        let result = DisplaySelectionPolicy.resolve(
            displays: [external, builtIn], placement: .main
        )

        #expect(result.targets.map(\.key) == ["built-in"])
        #expect(result.reason == .mainUnavailable)
    }

    @Test func allPlacementIsDeterministicAndPutsMainFirst() {
        let right = display("right", x: 1_920)
        let builtInMain = display("built-in", builtIn: true, main: true)
        let left = display("left", x: -1_920)

        let result = DisplaySelectionPolicy.resolve(
            displays: [right, builtInMain, left], placement: .all
        )

        #expect(result.targets.map(\.key) == ["built-in", "left", "right"])
    }

    @Test func noDisplaysReturnsExplicitEmptySelection() {
        let result = DisplaySelectionPolicy.resolve(displays: [], placement: .main)
        #expect(result.targets.isEmpty)
        #expect(result.reason == .noDisplays)
    }

    @Test func followActiveDisplayOverridesSinglePlacement() {
        let builtIn = display("built-in", builtIn: true, main: true)
        let external = display("external", x: 1_512)
        let result = DisplaySelectionPolicy.resolve(
            displays: [builtIn, external], placement: .builtIn,
            followActiveDisplay: true, activeDisplayKey: "external"
        )
        #expect(result.targets.map(\.key) == ["external"])
        #expect(result.reason == .activeDisplay)
    }

    @Test func followActiveFallsBackWhenPointerTargetDisappears() {
        let builtIn = display("built-in", builtIn: true, main: true)
        let result = DisplaySelectionPolicy.resolve(
            displays: [builtIn], placement: .builtIn,
            followActiveDisplay: true, activeDisplayKey: "disconnected"
        )
        #expect(result.targets.map(\.key) == ["built-in"])
        #expect(result.reason == .activeDisplayUnavailable)
    }

    @Test func allPlacementIgnoresFollowActiveDisplay() {
        let main = display("main", main: true)
        let other = display("other", x: 1_920)
        let result = DisplaySelectionPolicy.resolve(
            displays: [main, other], placement: .all,
            followActiveDisplay: true, activeDisplayKey: "other"
        )
        #expect(result.targets.map(\.key) == ["main", "other"])
    }

    @Test func displayProfileClampsEveryAdjustment() {
        let profile = DisplayProfile(
            displayKey: "display", compactWidthAdjustment: 999,
            compactHeightAdjustment: -999, horizontalOffset: 999,
            verticalOffset: -999, expandedWidthAdjustment: 999
        ).normalized
        #expect(profile.compactWidthAdjustment == 160)
        #expect(profile.compactHeightAdjustment == -6)
        #expect(profile.horizontalOffset == 240)
        #expect(profile.verticalOffset == 0)
        #expect(profile.expandedWidthAdjustment == 180)
    }

    @Test func automaticVirtualChromeOnlyTargetsNotchlessDisplays() {
        #expect(!VirtualNotchMode.automatic.usesVirtualChrome(
            for: display("built-in", builtIn: true)
        ))
        #expect(VirtualNotchMode.automatic.usesVirtualChrome(
            for: display("external")
        ))
    }

    @Test func explicitVirtualModesIgnoreDisplayHardware() {
        let physical = display("built-in", builtIn: true)
        let notchless = display("external")
        #expect(VirtualNotchMode.always.usesVirtualChrome(for: physical))
        #expect(VirtualNotchMode.always.usesVirtualChrome(for: notchless))
        #expect(!VirtualNotchMode.never.usesVirtualChrome(for: physical))
        #expect(!VirtualNotchMode.never.usesVirtualChrome(for: notchless))
    }

    @Test func stableKeySurvivesReconnectWhenSerialExists() {
        let before = DisplayDescriptor.stableKey(
            unitNumber: 7, vendor: 10, model: 20, serial: 30,
            name: "Studio Display", isBuiltIn: false
        )
        let after = DisplayDescriptor.stableKey(
            unitNumber: 99, vendor: 10, model: 20, serial: 30,
            name: "Studio Display", isBuiltIn: false
        )
        #expect(before == after)
    }

    @Test func seriallessIdenticalDisplaysRemainDistinctWhileOnline() {
        let first = DisplayDescriptor.stableKey(
            unitNumber: 7, vendor: 10, model: 20, serial: 0,
            name: "Generic Panel", isBuiltIn: false
        )
        let second = DisplayDescriptor.stableKey(
            unitNumber: 8, vendor: 10, model: 20, serial: 0,
            name: "Generic Panel", isBuiltIn: false
        )
        #expect(first != second)
    }

    @Test func hostInteractionOwnerSurvivesActiveDisplayChanges() {
        let key = DisplayHostPolicy.interactionKey(
            availableKeys: ["left", "right"], current: "left", active: "right"
        )
        #expect(key == "left")
    }

    @Test func hostInteractionFallsBackWhenOwnerDisconnects() {
        let key = DisplayHostPolicy.interactionKey(
            availableKeys: ["right"], current: "left", active: "right"
        )
        #expect(key == "right")
    }

    @Test func sharedRenderingPrimaryFollowsActiveDisplay() {
        let key = DisplayHostPolicy.primaryKey(
            availableKeys: ["left", "right"], active: "right", interaction: "left"
        )
        #expect(key == "right")
    }

    @Test func migrationKeepsPresentationWhenInteractionDisplayRemains() {
        let instruction = DisplayHostMigrationPolicy.instruction(
            targetStillAvailable: true, wasExpanded: true,
            wasHovering: true, hasTransientInteraction: true
        )
        #expect(instruction == .keepPresentation)
    }

    @Test func migrationCollapsesHoverExpansionWhenDisplayDisappears() {
        let instruction = DisplayHostMigrationPolicy.instruction(
            targetStillAvailable: false, wasExpanded: true,
            wasHovering: true, hasTransientInteraction: false
        )
        #expect(instruction == .collapse)
    }

    @Test func migrationRestoresProgrammaticExpansionOnReplacement() {
        let instruction = DisplayHostMigrationPolicy.instruction(
            targetStillAvailable: false, wasExpanded: true,
            wasHovering: false, hasTransientInteraction: false
        )
        #expect(instruction == .restoreProgrammaticExpansion)
    }

    @Test func migrationEndsTransientInteractionBeforeRemovingHost() {
        let instruction = DisplayHostMigrationPolicy.instruction(
            targetStillAvailable: false, wasExpanded: true,
            wasHovering: false, hasTransientInteraction: true
        )
        #expect(instruction == .endTransientInteractionAndCollapse)
    }
}
