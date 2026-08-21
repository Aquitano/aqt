/// A resolved user intention, produced by the router and executed by
/// AppSwitcher on the main actor.
enum Intent: Equatable {
    case switchToLetter(Character)
    case cycleLetter(Character)
    case assignLetter(Character)
    case searchQuery(String)
    case moveSelection(Int)
    case commitSearch
    case cancelSearch
    case itemAction(SearchItemAction)
}

enum SearchItemAction: Equatable {
    case close // ⌘W
    case quit // ⌘Q
    case hide // ⌘H
}

/// State machine for one rcmd hold: letter switching, Tab cycling, and
/// fuzzy-search buffering. Pure value type — the event tap callback feeds it
/// keyDowns and dispatches the returned intents (BATTLEPLAN §6). It is only
/// ever fed keys while rcmd is held; KeyRouter enforces that.
///
/// Rules (mirroring the original rcmd):
/// - First press of a letter switches (hide-toggle if already focused) AND
///   starts buffering a query.
/// - Re-pressing that same letter repeats the switch/hide; Tab cycles
///   same-letter apps. Neither pollutes the query.
/// - Pressing a different letter extends the query; the overlay appears at 2+
///   chars and release commits the selection.
/// - Left-⌘ + W/Q/H act on the overlay selection (bare letters always extend
///   the query, so "whatsapp" stays typeable). Backspace edits, Escape cancels,
///   arrows/Tab move. After Escape the hold is inert — but its keys are still
///   consumed so nothing leaks to apps as real ⌘-shortcuts.
struct HoldSession {
    private(set) var query = ""
    private(set) var searchActive = false
    /// Escape was pressed: ignore keys, but keep consuming them, until release.
    private(set) var cancelled = false

    private var lastKey: Character?
    /// Set once the query grew past the single-letter stage — only then does
    /// releasing rcmd commit the overlay selection.
    private var overlayEngaged = false

    /// rcmd released: commit a pending search selection, reset everything.
    mutating func rightCommandUp() -> [Intent] {
        let intents: [Intent] = overlayEngaged && !cancelled ? [.commitSearch] : []
        self = HoldSession()
        return intents
    }

    mutating func keyDown(_ keyCode: Int64, modifiers: ModifierState) -> [Intent] {
        guard !cancelled else { return [] }

        guard let letter = Keycode.letters[keyCode] else {
            return controlKeyDown(keyCode)
        }

        if modifiers.rightOptionHeld {
            return [.assignLetter(letter)]
        }

        if overlayEngaged && modifiers.leftCommandHeld {
            switch letter {
            case "w": return [.itemAction(.close)]
            case "q": return [.itemAction(.quit)]
            case "h": return [.itemAction(.hide)]
            default: break
            }
        }

        // Repeating the buffered letter re-triggers switch/hide instead of
        // extending the query.
        if lastKey == letter && query.count == 1 {
            return [.switchToLetter(letter)]
        }

        lastKey = letter
        query.append(letter)
        if query.count == 1 {
            searchActive = true
            return [.switchToLetter(letter), .searchQuery(query)]
        }
        overlayEngaged = true
        return [.searchQuery(query)]
    }

    private mutating func controlKeyDown(_ keyCode: Int64) -> [Intent] {
        switch keyCode {
        case Keycode.escape:
            guard searchActive else { return [] }
            cancelled = true
            return [.cancelSearch]
        case Keycode.tab:
            if overlayEngaged { return [.moveSelection(1)] }
            if let lastKey, query.count == 1 { return [.cycleLetter(lastKey)] }
            return []
        case Keycode.backspace:
            guard searchActive, query.popLast() != nil else { return [] }
            if query.isEmpty {
                searchActive = false
                overlayEngaged = false
                lastKey = nil
            }
            return [.searchQuery(query)]
        case Keycode.upArrow:
            return searchActive ? [.moveSelection(-1)] : []
        case Keycode.downArrow:
            return searchActive ? [.moveSelection(1)] : []
        default:
            return []
        }
    }
}
