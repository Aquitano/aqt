@testable import NotchCore
import Testing

struct EventTapRecoveryTests {
    @Test func repeatedStallsStayDisabled() {
        var recovery = EventTapRecovery()
        let first = recovery.shouldReenable(at: 0)
        let second = recovery.shouldReenable(at: 10)
        let third = recovery.shouldReenable(at: 20)
        let later = recovery.shouldReenable(at: 100)
        #expect(first)
        #expect(second)
        #expect(!third)
        #expect(!later)
    }

    @Test func isolatedStallsCanRecover() {
        var recovery = EventTapRecovery()
        let first = recovery.shouldReenable(at: 0)
        let second = recovery.shouldReenable(at: 31)
        let third = recovery.shouldReenable(at: 62)
        #expect(first)
        #expect(second)
        #expect(third)
    }
}
