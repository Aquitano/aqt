/// A resolved user intention, produced by the router and executed by
/// AppSwitcher on the main actor.
enum Intent: Equatable {
    case switchToLetter(Character)
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

/// State machine for one rcmd hold: letter switching, same-letter cycling, and
/// fuzzy-search buffering. Pure value type — the event tap callback feeds it
/// keyDowns and dispatches the returned intents (BATTLEPLAN §6).
///
/// Rules:
/// - First press of a letter switches AND starts buffering a query.
/// - Re-pressing the same letter cycles (never pollutes the query).
/// - Pressing a different letter extends the query; the overlay appears at 2+ chars.
/// - In search mode W/Q/H act on the selection, backspace edits, Escape cancels,
///   arrows/Tab move. After Escape the hold is inert until rcmd releases.
struct HoldSession {
    private(set) var query = ""
    private(set) var searchActive = false

    private var lastKey: Character?
    /// Set once the query grew past the single-cycle stage — only then does
    /// releasing rcmd commit the overlay selection.
    private var overlayEngaged = false
    private var cancelled = false

    /// rcmd released: commit a pending search selection, reset everything.
    mutating func rightCommandUp() -> [Intent] {
        let intents: [Intent] = overlayEngaged ? [.commitSearch] : []
        self = HoldSession()
        return intents
    }

    mutating func keyDown(_ keyCode: Int64) -> [Intent] {
        guard !cancelled else { return [] }

        guard let letter = Keycode.letters[keyCode] else {
            return searchActive ? searchKeyDown(keyCode) : []
        }

        // Repeating the buffered letter cycles apps instead of extending the
        // query ("sss" cycles three s-apps).
        if lastKey == letter && query.count == 1 {
            return [.switchToLetter(letter)]
        }

        if searchActive {
            return searchLetterKeyDown(letter)
        }

        lastKey = letter
        query.append(letter)
        searchActive = true
        return [.switchToLetter(letter), .searchQuery(query)]
    }

    private mutating func searchLetterKeyDown(_ letter: Character) -> [Intent] {
        switch letter {
        case "w": return [.itemAction(.close)]
        case "q": return [.itemAction(.quit)]
        case "h": return [.itemAction(.hide)]
        default:
            query.append(letter)
            lastKey = letter
            overlayEngaged = true
            return [.searchQuery(query)]
        }
    }

    private mutating func searchKeyDown(_ keyCode: Int64) -> [Intent] {
        switch keyCode {
        case Keycode.escape:
            cancelled = true
            return [.cancelSearch]
        case Keycode.backspace:
            guard query.popLast() != nil else { return [] }
            if query.isEmpty {
                searchActive = false
                overlayEngaged = false
                lastKey = nil
            }
            return [.searchQuery(query)]
        case Keycode.upArrow:
            return [.moveSelection(-1)]
        case Keycode.downArrow, Keycode.tab:
            return [.moveSelection(1)]
        default:
            return []
        }
    }
}
