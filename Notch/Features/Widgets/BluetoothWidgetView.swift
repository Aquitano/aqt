import SwiftUI
import NotchCore

/// Glass card listing connected Bluetooth devices and whatever battery info we
/// could resolve. Lives inside the expanded panel, so glass on the card is fine.
struct BluetoothWidgetView: View {
    @Environment(BluetoothBatteryManager.self) private var bluetooth

    private let maxDevices = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header

            ForEach(devices) { device in
                row(for: device)
            }
        }
        .notchCard()
    }

    private var devices: [BluetoothDevice] {
        Array(bluetooth.devices.prefix(maxDevices))
    }

    // MARK: - Header

    private var header: some View {
        TileHeader(title: "Bluetooth", systemImage: "dot.radiowaves.right")
    }

    // MARK: - Device row

    private func row(for device: BluetoothDevice) -> some View {
        HStack(spacing: 8) {
            PixelIcon(systemName: device.symbol, size: 16,
                      tint: .white.opacity(0.75))
                .frame(width: 18)

            Text(device.name)
                .font(.caption)
                .lineLimit(1)

            Spacer(minLength: 4)

            Text(batteryText(for: device))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    // MARK: - Helpers

    /// Prefer a single main reading; otherwise stitch together whichever of the
    /// left / right / case cells reported a value.
    private func batteryText(for device: BluetoothDevice) -> String {
        if let main = device.batteryMain {
            return "\(main)%"
        }

        var parts: [String] = []
        if let left = device.batteryLeft { parts.append("L \(left)%") }
        if let right = device.batteryRight { parts.append("R \(right)%") }
        if let caseLevel = device.batteryCase { parts.append("C \(caseLevel)%") }
        return parts.joined(separator: "  ")
    }
}
