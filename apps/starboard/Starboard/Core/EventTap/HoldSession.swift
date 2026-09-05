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
    /// rcmd+Tab with no letter buffered: open the window ring, select next.
    case beginWindowCycle
    /// Double-tap-and-hold rcmd: fuzzy search over open windows only.
    case beginWindowSearch
    /// rcmd+`: next window of the frontmost app.
    case cycleAppWindows
    /// ralt+letter (window jump enabled): step through the letter app's windows.
    case jumpAppWindows(Character)
    /// rcmd+digit: jump to that Space.
    case jumpToSpace(Int)
    /// rcmd+[ or ]: jump to the adjacent Space.
    case adjacentSpace(SpaceDirection)
    /// ralt+digit (direct strategy): move the focused window to that Space.
    case moveWindowToSpace(Int)
    /// Stages leader key tapped: show the command toast.
    case stagesArmed
    /// Leader then `=`: snapshot the visible apps into a new Stage.
    case stageBeginSave
    /// Leader then letter: restore/activate that Stage.
    case stageRestore(Character)
    /// Leader then `-`: close the active Stage's windows.
    case stageClose
}

enum SearchItemAction: Equatable {
    case close // ⌘W
    case quit // ⌘Q
    case hide // ⌘H
}

/// State machine for one rcmd hold. Pure value type — the event tap callback
/// feeds it keyDowns and dispatches the returned intents (BATTLEPLAN §6). It is
/// only ever fed keys while rcmd is held; KeyRouter enforces that.
///
/// Modes:
/// - idle → first letter switches (hide-toggle if focused) and buffers a query;
///   Tab opens the window ring; backtick cycles the frontmost app's windows;
///   arrows select in the hold overlay's letter map.
/// - letter → same letter repeats the switch, Tab cycles same-letter apps,
///   another letter engages the search overlay.
/// - search → letters extend the query (left-⌘ W/Q/H act on the selection so
///   "whatsapp" stays typeable), Tab/arrows move, backspace edits, Escape
///   cancels, release commits.
/// - windowCycle → Tab steps the ring, typing pivots to window search, release
///   commits.
/// - cancelled → inert, but KeyRouter keeps consuming keys until release so
///   nothing leaks to apps as real ⌘-shortcuts.
struct HoldSession {
    private enum Mode: Equatable {
        case idle
        case letter(Character)
        case search
        case windowCycle
        case cancelled
    }

    enum SearchScope: Equatable { case apps, windows }

    private var mode: Mode = .idle
    private(set) var query = ""
    private(set) var scope: SearchScope = .apps

    var cancelled: Bool {
        mode == .cancelled
    }

    var searchActive: Bool {
        if case .letter = mode {
            return true
        }
        return mode == .search
    }

    /// No keys were pressed during this hold — a "bare" tap, half of a
    /// double-tap gesture.
    var isBareHold: Bool {
        mode == .idle
    }

    /// Double-tap detected by KeyRouter: enter windows-only search.
    mutating func beginWindowSearch() -> [Intent] {
        mode = .search
        scope = .windows
        query = ""
        return [.beginWindowSearch]
    }

    /// rcmd released: commit a pending overlay selection (or dismiss the
    /// single-letter preview overlay), reset everything.
    mutating func rightCommandUp() -> [Intent] {
        primaryModifierUp()
    }

    mutating func primaryModifierUp() -> [Intent] {
        let intents: [Intent] = switch mode {
        case .search, .windowCycle:
            [.commitSearch]
        case .letter:
            [.cancelSearch] // the switch already happened on keyDown
        case .idle, .cancelled:
            []
        }
        self = HoldSession()
        return intents
    }

    mutating func keyDown(
        _ keyCode: Int64,
        modifiers: ModifierState,
        primaryModifier: PrimaryModifier = .rightCommand,
        letter: Character? = nil,
        digit: Int? = nil,
        keyWasResolved: Bool = false
    ) -> [Intent] {
        guard mode != .cancelled else { return [] }

        let resolvedLetter = keyWasResolved ? letter : (letter ?? Keycode.letters[keyCode])
        guard let letter = resolvedLetter else {
            return controlKeyDown(keyCode, digit: digit, keyWasResolved: keyWasResolved)
        }

        if primaryModifier.secondaryIsHeld(in: modifiers) {
            return [.assignLetter(letter)]
        }

        switch mode {
        case .idle:
            mode = .letter(letter)
            query = String(letter)
            return [.switchToLetter(letter), .searchQuery(query)]
        case let .letter(buffered) where buffered == letter:
            return [.switchToLetter(letter)]
        case .letter:
            mode = .search
            query.append(letter)
            return [.searchQuery(query)]
        case .search:
            if modifiers.leftCommandHeld {
                switch letter {
                case "w": return [.itemAction(.close)]
                case "q": return [.itemAction(.quit)]
                case "h": return [.itemAction(.hide)]
                default: break
                }
            }
            query.append(letter)
            return [.searchQuery(query)]
        case .windowCycle:
            // Typing pivots the ring into fuzzy window search.
            mode = .search
            query = String(letter)
            return [.searchQuery(query)]
        case .cancelled:
            return []
        }
    }

    private mutating func controlKeyDown(
        _ keyCode: Int64,
        digit: Int?,
        keyWasResolved: Bool
    ) -> [Intent] {
        // Space navigation wins over search for digits/brackets except while
        // the overlay is engaged (where they'd be surprising jumps).
        let resolvedDigit = keyWasResolved ? digit : (digit ?? Keycode.digits[keyCode])
        if let digit = resolvedDigit {
            switch mode {
            case .idle, .letter, .windowCycle: return [.jumpToSpace(digit)]
            case .search, .cancelled: return []
            }
        }
        let allowsSpaceNav = mode == .idle || searchActive && query.count <= 1
        switch keyCode {
        case Keycode.leftBracket where allowsSpaceNav:
            return [.adjacentSpace(.left)]
        case Keycode.rightBracket where allowsSpaceNav:
            return [.adjacentSpace(.right)]
        default:
            break
        }
        switch keyCode {
        case Keycode.escape:
            guard mode != .idle else { return [] }
            mode = .cancelled
            return [.cancelSearch]
        case Keycode.tab:
            switch mode {
            case .idle:
                mode = .windowCycle
                scope = .windows
                return [.beginWindowCycle]
            case let .letter(buffered):
                return [.cycleLetter(buffered)]
            case .search, .windowCycle:
                return [.moveSelection(1)]
            case .cancelled:
                return []
            }
        case Keycode.backtick:
            switch mode {
            case .idle, .letter:
                return [.cycleAppWindows]
            default:
                return []
            }
        case Keycode.backspace:
            guard searchActive, query.popLast() != nil else { return [] }
            if let remaining = query.first, query.count == 1 {
                mode = .letter(remaining)
            } else if query.isEmpty {
                mode = .idle
                scope = .apps
            }
            return [.searchQuery(query)]
        case Keycode.upArrow, Keycode.downArrow:
            let delta = keyCode == Keycode.upArrow ? -1 : 1
            switch mode {
            case .idle, .letter:
                // Arrows promote the hold overlay's preview — the letter map
                // or a single-letter query — into a real search, so release
                // commits the highlighted result.
                mode = .search
                return [.moveSelection(delta)]
            case .search, .windowCycle:
                return [.moveSelection(delta)]
            case .cancelled:
                return []
            }
        default:
            return []
        }
    }
}
