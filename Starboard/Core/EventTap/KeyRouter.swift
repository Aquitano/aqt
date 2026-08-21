/// A resolved user intention, produced by KeyRouter and executed elsewhere.
/// Grows per phase: search, window cycling, Spaces, and Stages all become cases.
enum Intent: Equatable {
    case switchToLetter(Character)
    case assignLetter(Character)
}

/// Pure routing: (key event, modifier state) → Intent. nil means Starboard does
/// not handle the key — it must pass through untouched. Keeping this pure is
/// what makes the global-hotkey layer unit-testable (BATTLEPLAN §6).
struct KeyRouter {
    func route(keyDownCode keyCode: Int64, modifiers: ModifierState) -> Intent? {
        guard modifiers.rightCommandHeld, let letter = Keycode.letters[keyCode] else {
            return nil
        }
        return modifiers.rightOptionHeld ? .assignLetter(letter) : .switchToLetter(letter)
        // TODO(Phase 3+): Tab cycling, digits, brackets, backtick, Escape,
        // fuzzy-search buffering.
    }
}
