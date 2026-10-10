public struct RouterConfig: Equatable, Sendable {
    public var keyboard: KeyboardMap
    public var stagesLeader: StagesLeader
    /// Letters bound to a Stage. Any other letter after the leader is typed
    /// normally: an armed leader must never eat an ordinary keystroke.
    public var stageLetters: Set<Character>
    /// Seconds into a hold before the overlay shows.
    public var overlayDelay: Double

    public init(_ config: Config, keyboard: KeyboardMap) {
        self.init(
            keyboard: keyboard,
            stagesLeader: config.stagesLeader,
            stageLetters: config.stageLetters,
            overlayDelay: Double(config.overlayDelayMs) / 1000
        )
    }

    init(
        keyboard: KeyboardMap = .ansi,
        stagesLeader: StagesLeader = .capsLock,
        stageLetters: Set<Character> = [],
        overlayDelay: Double = 0.3
    ) {
        self.keyboard = keyboard
        self.stagesLeader = stagesLeader
        self.stageLetters = stageLetters
        self.overlayDelay = overlayDelay
    }
}

/// The answer to one key event: whether it is swallowed, and what it asks for.
public struct Route: Equatable, Sendable {
    public var consume: Bool
    public var intents: [Intent]

    static let pass = Route(consume: false, intents: [])
}

/// Every key event on the system passes through here, so it holds the rules
/// that keep Starboard from breaking the keyboard:
/// - Nothing is routed while Right Command is up, except a key right after
///   the Stages leader that names a Stage command.
/// - A consumed keyDown also swallows its keyUp, even after Right Command is
///   released, so apps never see half a keystroke.
/// - Once a hold has typed a letter, every key is consumed until release, so
///   a stray Backspace, Space or Q never reaches the frontmost app as a
///   Command shortcut.
public struct InputRouter: Sendable {
    public var config: RouterConfig
    private var modifiers = Modifiers(flags: 0)
    private var hold: Hold?
    private var consumedKeys: Set<Int64> = []
    private var leaderArmedUntil = -Double.infinity
    private var lastKeyDownTime = -Double.infinity
    private var rightShiftDownTime = -Double.infinity

    public init(config: RouterConfig) {
        self.config = config
    }

    public mutating func handle(_ event: KeyEvent) -> Route {
        // Consuming Caps Lock keeps the lock from toggling.
        if event.kind == .flagsChanged, event.keyCode == Keycode.capsLock {
            guard config.stagesLeader == .capsLock else { return .pass }
            return Route(consume: true, intents: armLeader(at: event.time))
        }

        let previous = modifiers
        modifiers = Modifiers(flags: event.flags)
        var intents = holdTransition(from: previous, at: event.time)

        switch event.kind {
        case .flagsChanged:
            if config.stagesLeader == .rightShift {
                intents += rightShiftTransition(from: previous, at: event.time)
            }
            return Route(consume: false, intents: intents)
        case .keyDown:
            // A held letter would otherwise switch again on every repeat.
            guard !event.isAutorepeat else {
                return Route(consume: consumedKeys.contains(event.keyCode), intents: intents)
            }
            let route = keyDown(event.keyCode, at: event.time)
            return Route(consume: route.consume, intents: intents + route.intents)
        case .keyUp:
            return Route(consume: consumedKeys.remove(event.keyCode) != nil, intents: intents)
        }
    }

    /// Forgets everything observed so far. Call it when the tap stops seeing
    /// events: the releases that would have ended a hold happened unseen.
    public mutating func reset() -> [Intent] {
        let wasHolding = hold != nil
        self = InputRouter(config: config)
        return wasHolding ? [.holdEnded(.invalidated)] : []
    }

    private mutating func holdTransition(from previous: Modifiers, at time: Double) -> [Intent] {
        switch (previous.rightCommand, modifiers.rightCommand) {
        case (false, true):
            // A keyUp the tap never saw would leave an entry that eats an
            // unrelated keyUp later.
            consumedKeys.removeAll(keepingCapacity: true)
            hold = Hold(startedAt: time)
            return [.holdBegan]
        case (true, false):
            let end = hold?.end ?? .dismiss
            hold = nil
            return [.holdEnded(end)]
        default:
            return []
        }
    }

    private mutating func keyDown(_ keyCode: Int64, at time: Double) -> Route {
        lastKeyDownTime = time

        if time < leaderArmedUntil {
            leaderArmedUntil = -.infinity
            // Right Command + key routes as a hold instead.
            if !modifiers.rightCommand {
                guard let command = leaderCommand(for: keyCode) else { return .pass }
                consumedKeys.insert(keyCode)
                return Route(consume: true, intents: [command])
            }
        }

        guard var hold else { return .pass }
        let intents = hold.keyDown(
            keyCode,
            letter: config.keyboard.letter(for: keyCode),
            digit: config.keyboard.digit(for: keyCode),
            modifiers: modifiers,
            overlayShown: time - hold.startedAt >= config.overlayDelay
        )
        self.hold = hold
        let consume = !intents.isEmpty || hold.hasTyped
        if consume {
            consumedKeys.insert(keyCode)
        }
        return Route(consume: consume, intents: intents)
    }

    private mutating func armLeader(at time: Double) -> [Intent] {
        leaderArmedUntil = time + 3
        return [.stagesArmed]
    }

    /// Right Shift arms the leader only on a quick bare tap, so shifted typing
    /// never does.
    private mutating func rightShiftTransition(from previous: Modifiers, at time: Double) -> [Intent] {
        switch (previous.rightShift, modifiers.rightShift) {
        case (false, true):
            rightShiftDownTime = time
            return []
        case (true, false):
            guard time - rightShiftDownTime < 0.4, lastKeyDownTime < rightShiftDownTime else { return [] }
            return armLeader(at: time)
        default:
            return []
        }
    }

    private func leaderCommand(for keyCode: Int64) -> Intent? {
        if let letter = config.keyboard.letter(for: keyCode) {
            return config.stageLetters.contains(letter) ? .stageRestore(letter) : nil
        }
        return switch keyCode {
        case Keycode.equal: .stageBeginSave
        case Keycode.minus: .stageClose
        default: nil
        }
    }
}

/// One Right Command hold.
/// - idle: the first letter switches apps and starts a query.
/// - letter: the same letter repeats the switch, Tab cycles apps on that
///   letter, another letter turns the query into a search.
/// - search: letters extend the query, Tab and arrows move the selection,
///   release opens it.
/// - cancelled: inert until release.
private struct Hold {
    private enum Mode: Equatable {
        case idle
        case letter(Character)
        case search
        case cancelled
    }

    let startedAt: Double
    private var mode = Mode.idle
    private var query = ""
    private(set) var hasTyped = false

    init(startedAt: Double) {
        self.startedAt = startedAt
    }

    var end: HoldEnd {
        mode == .search ? .commit : .dismiss
    }

    mutating func keyDown(
        _ keyCode: Int64,
        letter: Character?,
        digit: Int?,
        modifiers: Modifiers,
        overlayShown: Bool
    ) -> [Intent] {
        guard mode != .cancelled else { return [] }
        if let letter {
            return letterDown(letter, modifiers: modifiers)
        }
        if let digit {
            return mode == .search ? [] : [.jumpToSpace(digit)]
        }

        switch keyCode {
        case Keycode.leftBracket where allowsSpaceNavigation:
            return [.adjacentSpace(.left)]
        case Keycode.rightBracket where allowsSpaceNavigation:
            return [.adjacentSpace(.right)]
        case Keycode.escape:
            guard mode != .idle else { return [] }
            mode = .cancelled
            return [.cancelSearch]
        case Keycode.tab:
            switch mode {
            case let .letter(buffered): return [.cycleLetter(buffered)]
            case .search: return [.moveSelection(1)]
            case .idle, .cancelled: return []
            }
        case Keycode.backspace:
            guard mode != .idle, query.popLast() != nil else { return [] }
            if query.count == 1, let first = query.first {
                mode = .letter(first)
            } else if query.isEmpty {
                mode = .idle
            }
            return [.searchQuery(query)]
        case Keycode.upArrow, Keycode.downArrow:
            let delta = keyCode == Keycode.upArrow ? -1 : 1
            switch mode {
            case .idle, .letter:
                // Before the overlay is up, Command-arrow belongs to the app.
                guard overlayShown else { return [] }
                mode = .search
                hasTyped = true
                return [.moveSelection(delta)]
            case .search:
                return [.moveSelection(delta)]
            case .cancelled:
                return []
            }
        default:
            return []
        }
    }

    private mutating func letterDown(_ letter: Character, modifiers: Modifiers) -> [Intent] {
        hasTyped = true
        if modifiers.rightOption {
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
            // Bare W/Q/H stay letters so "whatsapp" is typeable.
            if modifiers.leftCommand, let action = SearchItemAction(letter) {
                return [.itemAction(action)]
            }
            query.append(letter)
            return [.searchQuery(query)]
        case .cancelled:
            return []
        }
    }

    /// Digits and brackets are Space jumps until the query is a real search.
    private var allowsSpaceNavigation: Bool {
        switch mode {
        case .idle, .letter: true
        case .search: query.count <= 1
        case .cancelled: false
        }
    }
}
