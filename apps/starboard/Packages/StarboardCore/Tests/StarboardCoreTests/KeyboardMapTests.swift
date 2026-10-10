@testable import StarboardCore
import Testing

struct KeyboardMapTests {
    @Test func latinLettersFollowTheLayout() {
        // AZERTY swaps A and Q.
        let map = KeyboardMap(printed: [0x00: "q", 0x0C: "a"])
        #expect(map.letter(for: 0x00) == "q")
        #expect(map.letter(for: 0x0C) == "a")
    }

    @Test func punctuationIsNoLetter() {
        // Dvorak prints a comma on the ANSI W key and W on the ANSI comma key.
        let map = KeyboardMap(printed: [0x0D: ",", 0x2B: "w"])
        #expect(map.letter(for: 0x0D) == nil)
        #expect(map.letter(for: 0x2B) == "w")
    }

    @Test func otherScriptsKeepTheirPositionalLetter() {
        let map = KeyboardMap(printed: [0x01: "ы"])
        #expect(map.letter(for: 0x01) == "s")
    }

    @Test func theDigitRowKeepsItsDigitsUnderSymbols() {
        // AZERTY prints & and é on 1 and 2.
        let map = KeyboardMap(printed: [0x12: "&", 0x13: "é"])
        #expect(map.digit(for: 0x12) == 1)
        #expect(map.digit(for: 0x13) == 2)
        #expect(map.letter(for: 0x13) == nil)
    }

    @Test func keysTheLayoutDoesNotPrintFallBackToANSI() {
        let map = KeyboardMap(printed: [:])
        #expect(map.letter(for: 0x01) == "s")
        #expect(map.digit(for: 0x14) == 3)
    }
}
