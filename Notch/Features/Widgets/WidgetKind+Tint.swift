import SwiftUI
import NotchCore

extension WidgetKind {
    var tint: Color {
        switch self {
        case .battery: .green
        case .clock: .indigo
        case .focus: .blue
        case .bluetooth: .teal
        case .weather: .cyan
        case .calendar: .red
        case .shortcuts: .purple
        case .note: .yellow
        }
    }
}
