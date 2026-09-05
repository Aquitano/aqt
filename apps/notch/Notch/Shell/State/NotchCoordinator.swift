import Foundation
import NotchCore
import Observation

/// The app-level view of the notch across displays. Every display has its own
/// `NotchState` machine (hover, grace timers, tab); this object owns those
/// machines, keeps at most one of them expanded, and is where app-level
/// commands land: the status item, the hotkey, an agent that needs attention.
/// Hosts read their own machine; nothing mirrors state between them.
@MainActor
@Observable
final class NotchCoordinator {
    private(set) var states: [String: NotchState] = [:]

    /// The tab a display's panel resets to, answered by Settings.
    @ObservationIgnored var defaultTab: (String) -> NotchState.ExpandedTab = { _ in .home }
    /// The display a programmatic expand opens on when none is expanded; the
    /// window controller answers with the pointer's display.
    @ObservationIgnored var expansionTarget: () -> String? = { nil }
    @ObservationIgnored private let clock: any Clock<Duration>

    init(clock: any Clock<Duration> = ContinuousClock()) {
        self.clock = clock
    }

    var expandedKey: String? {
        states.first { $0.value.isExpanded }?.key
    }

    var expanded: NotchState? {
        expandedKey.flatMap { states[$0] }
    }

    var isVisible: Bool {
        states.values.contains { $0.isVisible }
    }

    func state(for displayKey: String) -> NotchState? {
        states[displayKey]
    }

    /// The machine for a display, created on first sight. A display that
    /// appears while the notch is showing starts compact like the others.
    @discardableResult
    func register(displayKey: String) -> NotchState {
        if let existing = states[displayKey] {
            return existing
        }
        let state = NotchState(clock: clock)
        state.defaultTab = { [weak self] in self?.defaultTab(displayKey) ?? .home }
        state.expandedTab = expanded?.expandedTab ?? defaultTab(displayKey)
        state.onExpand = { [weak self] state in self?.compactOthers(than: state) }
        if isVisible {
            state.showCompact()
        }
        states[displayKey] = state
        return state
    }

    func unregister(displayKey: String) {
        states[displayKey] = nil
    }

    // MARK: - Commands

    func expand() {
        target()?.expand()
    }

    func hide() {
        states.values.forEach { $0.hide() }
    }

    func showCompact() {
        states.values.forEach { $0.showCompact() }
    }

    func toggle() {
        isVisible ? hide() : expand()
    }

    func collapseImmediately() {
        expanded?.collapseImmediately()
    }

    func select(tab: NotchState.ExpandedTab) {
        target()?.select(tab: tab)
    }

    private func target() -> NotchState? {
        expanded
            ?? expansionTarget().flatMap { states[$0] }
            ?? states.keys.sorted().first.flatMap { states[$0] }
    }

    /// Only one display expands at a time; the rest fall back to their compact
    /// hover target (or come up compact if they were hidden).
    private func compactOthers(than state: NotchState) {
        for other in states.values where other !== state {
            switch other.presentation {
            case .hidden: other.showCompact()
            case .expanded: other.collapseImmediately()
            case .compact: break
            }
        }
    }
}
