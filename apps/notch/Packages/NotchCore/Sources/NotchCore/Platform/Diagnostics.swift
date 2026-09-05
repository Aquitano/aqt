import Foundation
import Observation

/// Failures the app recovered from but the user should be able to see: a
/// preferences file that would not write, an agent hook install that failed at
/// launch. Settings lists the most recent ones. Reporting is safe from any
/// thread; the list itself lives on the main actor.
@MainActor
@Observable
package final class Diagnostics {
    package init() {}

    package struct Issue: Identifiable, Equatable {
        package let id = UUID()
        package let date: Date
        package let source: String
        package let message: String
    }

    package private(set) var issues: [Issue] = []
    private static let capacity = 30

    package nonisolated func report(source: String, message: String) {
        Log.app.error("[\(source)] \(message)")
        Task { @MainActor in
            self.issues.insert(Issue(date: Date(), source: source, message: message), at: 0)
            if self.issues.count > Self.capacity {
                self.issues.removeLast(self.issues.count - Self.capacity)
            }
        }
    }

    package nonisolated func report(source: String, _ error: some Error) {
        report(source: source, message: error.localizedDescription)
    }

    package func clear() {
        issues.removeAll()
    }
}
