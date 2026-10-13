@testable import NotchCore
import Testing

struct EventTapRecoveryTests {
    @Test func repeatedStallsStayDisabled() {
        var recovery = EventTapRecovery()
        #expect(recovery.shouldReenable(at: 0))
        #expect(recovery.shouldReenable(at: 10))
        #expect(!recovery.shouldReenable(at: 20))
        #expect(!recovery.shouldReenable(at: 100))
    }

    @Test func isolatedStallsCanRecover() {
        var recovery = EventTapRecovery()
        #expect(recovery.shouldReenable(at: 0))
        #expect(recovery.shouldReenable(at: 31))
        #expect(recovery.shouldReenable(at: 62))
    }
}
