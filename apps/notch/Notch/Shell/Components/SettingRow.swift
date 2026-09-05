import SwiftUI
import NotchCore

/// A single full-width settings line: title on the left, control on the right.
/// Used by the in-notch settings tab so its rows read like a real settings list
/// instead of a cramped top-left stack.
struct SettingRow<Trailing: View>: View {
    let title: String
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 12) {
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white)
            Spacer(minLength: 8)
            trailing()
        }
        .frame(maxWidth: .infinity, minHeight: 30)
    }
}
