/// What a key event asks the app to do. The router produces intents; the app
/// target executes them on the main actor.
public enum Intent: Equatable, Sendable {
    /// Right Command went down.
    case holdBegan
    case holdEnded(HoldEnd)
    case switchToLetter(Character)
    /// Tab after a letter: the next app on the same letter.
    case cycleLetter(Character)
    /// Right Command + Right Option + letter: pin the frontmost app.
    case assignLetter(Character)
    case searchQuery(String)
    case moveSelection(Int)
    /// Escape: the overlay closes and the release commits nothing.
    case cancelSearch
    case itemAction(SearchItemAction)
    case jumpToSpace(Int)
    case adjacentSpace(SpaceDirection)
    case stagesArmed
    case stageBeginSave
    case stageRestore(Character)
    case stageClose
}

public enum HoldEnd: Equatable, Sendable {
    /// Released during a search: open the selected result.
    case commit
    /// Released anywhere else.
    case dismiss
    /// The tap stopped seeing events, so the release was never observed.
    case invalidated
}

/// Left Command + W/Q/H during a search act on the selected app.
public enum SearchItemAction: Equatable, Sendable {
    case close
    case quit
    case hide

    init?(_ letter: Character) {
        switch letter {
        case "w": self = .close
        case "q": self = .quit
        case "h": self = .hide
        default: return nil
        }
    }
}

public enum SpaceDirection: Equatable, Sendable {
    case left
    case right
}
