import CoreGraphics
import XCTest
@testable import Starboard

final class ModifierTrackerTests: XCTestCase {
    private enum Bit {
        static let rightControl: UInt64 = 0x0000_2000
        static let rightShift: UInt64 = 0x0000_0004
        static let leftCommand: UInt64 = 0x0000_0008
        static let rightCommand: UInt64 = 0x0000_0010
        static let leftOption: UInt64 = 0x0000_0020
        static let rightOption: UInt64 = 0x0000_0040
        static let fn: UInt64 = 0x0080_0000
        /// Generic ⌘ mask: set for either side, so it must not be read.
        static let command: UInt64 = 0x0010_0000
    }

    private func flags(_ raw: UInt64) -> CGEventFlags { CGEventFlags(rawValue: raw) }

    func testEachDeviceBitMapsToOneSide() {
        let cases: [(UInt64, ModifierState)] = [
            (0, ModifierState()),
            (Bit.rightCommand | Bit.command, ModifierState(rightCommandHeld: true)),
            (Bit.leftCommand | Bit.command, ModifierState(leftCommandHeld: true)),
            (Bit.rightOption, ModifierState(rightOptionHeld: true)),
            (Bit.rightShift, ModifierState(rightShiftHeld: true)),
            (Bit.leftOption, ModifierState(leftOptionHeld: true)),
            (Bit.rightControl, ModifierState(rightControlHeld: true)),
            (Bit.fn, ModifierState(fnHeld: true)),
            (
                Bit.rightCommand | Bit.leftCommand | Bit.command,
                ModifierState(rightCommandHeld: true, leftCommandHeld: true)
            ),
        ]
        for (raw, expected) in cases {
            let tracker = ModifierTracker()
            XCTAssertEqual(tracker.update(flags: flags(raw)), expected, "flags 0x\(String(raw, radix: 16))")
        }
    }

    func testRightCommandReleaseIsSeenWhileLeftCommandStaysHeld() {
        let tracker = ModifierTracker()
        tracker.update(flags: flags(Bit.rightCommand | Bit.leftCommand | Bit.command))
        // The generic ⌘ mask is still set by left ⌘ — only the device bit says
        // the right one came up.
        let state = tracker.update(flags: flags(Bit.leftCommand | Bit.command))
        XCTAssertFalse(state.rightCommandHeld)
        XCTAssertTrue(state.leftCommandHeld)
    }

    func testAnEventWithoutTheBitClearsAHeldModifier() {
        let tracker = ModifierTracker()
        tracker.update(flags: flags(Bit.rightCommand | Bit.command))
        // The rcmd release was never delivered (tap disabled, secure input,
        // screen lock); the next event's flags heal the state.
        tracker.update(flags: flags(0))
        XCTAssertEqual(tracker.state, ModifierState())
    }

    func testResetDropsEverything() {
        let tracker = ModifierTracker()
        tracker.update(flags: flags(Bit.rightCommand | Bit.rightOption))
        tracker.reset()
        XCTAssertEqual(tracker.state, ModifierState())
    }

    func testAlternativePrimaryModifiers() {
        let tracker = ModifierTracker()
        let rctrlState = tracker.update(flags: flags(Bit.rightControl))
        XCTAssertTrue(rctrlState.rightControlHeld)
        XCTAssertTrue(rctrlState.isHeld(.rightControl))
        XCTAssertFalse(rctrlState.isHeld(.rightCommand))

        let raltState = tracker.update(flags: flags(Bit.rightOption))
        XCTAssertTrue(raltState.rightOptionHeld)
        XCTAssertTrue(raltState.isHeld(.rightOption))

        let laltState = tracker.update(flags: flags(Bit.leftOption))
        XCTAssertTrue(laltState.leftOptionHeld)
        XCTAssertTrue(laltState.isHeld(.leftOption))

        let fnState = tracker.update(flags: flags(Bit.fn))
        XCTAssertTrue(fnState.fnHeld)
        XCTAssertTrue(fnState.isHeld(.fn))
    }
}
