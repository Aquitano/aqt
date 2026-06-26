import IOBluetooth
import Foundation
import Combine

/// Bluetooth device battery via `system_profiler SPBluetoothDataType -json`
/// (off-main, cached). Connect events come from IOBluetooth notifications and
/// emit a "device connected" activity, then trigger a rescan for battery levels.
@MainActor
final class BluetoothBatteryManager: NSObject, ObservableObject {

    @Published private(set) var devices: [BluetoothDevice] = []

    private unowned let activities: ActivityManager
    private var connectNotification: IOBluetoothUserNotification?
    private var scanning = false

    init(activities: ActivityManager) {
        self.activities = activities
        super.init()
    }

    func start() {
        refresh()
        connectNotification = IOBluetoothDevice.register(
            forConnectNotifications: self,
            selector: #selector(deviceConnected(_:fromDevice:))
        )
    }

    /// View-driven (e.g. on expand) so battery is fresh without polling.
    func refresh() {
        guard !scanning else { return }
        scanning = true
        Task.detached(priority: .utility) { [weak self] in
            let scanned = BluetoothBatteryManager.scan()
            await MainActor.run { self?.apply(scanned) }
        }
    }

    @objc private func deviceConnected(_ notification: IOBluetoothUserNotification, fromDevice device: IOBluetoothDevice) {
        let name = device.name ?? "Bluetooth Device"
        activities.publish(Activity(
            kind: .deviceConnected(name: name, symbol: Self.symbol(forName: name, minorType: nil), battery: nil),
            priority: .normal, createdAt: Date(), ttl: 4
        ))
        refresh()
    }

    private func apply(_ scanned: [BluetoothDevice]) {
        scanning = false
        devices = scanned
    }

    // MARK: - system_profiler

    nonisolated private static func scan() -> [BluetoothDevice] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/system_profiler")
        process.arguments = ["SPBluetoothDataType", "-json"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
        } catch {
            return []
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return parse(data)
    }

    nonisolated private static func parse(_ data: Data) -> [BluetoothDevice] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let section = (root["SPBluetoothDataType"] as? [[String: Any]])?.first else { return [] }

        let connectedGroups = section["device_connected"] as? [[String: Any]] ?? []
        var result: [BluetoothDevice] = []

        for group in connectedGroups {
            for (name, value) in group {
                guard let props = value as? [String: Any] else { continue }
                let minor = props["device_minorType"] as? String
                result.append(BluetoothDevice(
                    id: (props["device_address"] as? String) ?? name,
                    name: name,
                    symbol: symbol(forName: name, minorType: minor),
                    batteryMain: percent(props["device_batteryLevelMain"]),
                    batteryLeft: percent(props["device_batteryLevelLeft"]),
                    batteryRight: percent(props["device_batteryLevelRight"]),
                    batteryCase: percent(props["device_batteryLevelCase"]),
                    isConnected: true
                ))
            }
        }
        return result
    }

    nonisolated private static func percent(_ value: Any?) -> Int? {
        guard let string = value as? String else { return nil }
        return Int(string.replacingOccurrences(of: "%", with: "").trimmingCharacters(in: .whitespaces))
    }

    nonisolated private static func symbol(forName name: String, minorType: String?) -> String {
        let lowered = (name + " " + (minorType ?? "")).lowercased()
        if lowered.contains("airpods max") { return "airpods.max" }
        if lowered.contains("airpods pro") { return "airpods.pro" }
        if lowered.contains("airpods") { return "airpods" }
        if lowered.contains("homepod") { return "homepod.fill" }
        if lowered.contains("mouse") { return "magicmouse.fill" }
        if lowered.contains("keyboard") { return "keyboard.fill" }
        if lowered.contains("headphone") || lowered.contains("buds") { return "headphones" }
        return "wave.3.right.circle.fill"
    }
}
