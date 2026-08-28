import CoreAudio
import AudioToolbox
import Foundation

/// Reads system output volume + mute and pushes changes (no polling) via
/// CoreAudio property listeners. Re-binds when the default output device changes.
///
/// All access to `deviceID` and the address structs is confined to `queue`
/// (listener blocks dispatch there too), so the synchronous `snapshot()` reads
/// can't race the rebind that the default-device listener performs.
final class AudioHardware: @unchecked Sendable {

    /// volume 0...1, muted flag. Always delivered on the main queue.
    var onChange: ((Float, Bool) -> Void)?

    /// Default output device changed: (display name, SF Symbol). Delivered on main.
    /// Skips the initial bind so launch doesn't read as a route change.
    var onRouteChange: ((String, String) -> Void)?

    private var deviceID = AudioObjectID(kAudioObjectUnknown)
    private var previousDeviceID = AudioObjectID(kAudioObjectUnknown)
    private var hasBoundOnce = false
    private let queue = DispatchQueue(label: "com.aquitano.notch.audio")

    private var volumeAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    private var muteAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    private var defaultDeviceAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    private var deviceListener: AudioObjectPropertyListenerBlock?
    private var systemListener: AudioObjectPropertyListenerBlock?

    func start() {
        queue.async { [weak self] in
            guard let self, self.systemListener == nil else { return }
            self.rebindDeviceLocked()

            let systemObject = AudioObjectID(kAudioObjectSystemObject)
            let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
                self?.rebindDeviceLocked()
            }
            self.systemListener = listener
            AudioObjectAddPropertyListenerBlock(systemObject, &self.defaultDeviceAddress, self.queue, listener)
        }
    }

    // MARK: - Reads (serialized on `queue`)

    /// Current (volume 0...1, muted). Safe to call from any thread.
    func snapshot() -> (volume: Float, muted: Bool) {
        queue.sync { (readVolumeLocked(), readMutedLocked()) }
    }

    private func readVolumeLocked() -> Float {
        var value = Float32(0)
        var size = UInt32(MemoryLayout<Float32>.size)
        let status = AudioObjectGetPropertyData(deviceID, &volumeAddress, 0, nil, &size, &value)
        return status == noErr ? value : 0
    }

    private func readMutedLocked() -> Bool {
        var value = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(deviceID, &muteAddress, 0, nil, &size, &value)
        return status == noErr && value != 0
    }

    private func readNameLocked() -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &name)
        guard status == noErr, let name else { return "Output" }
        return name.takeRetainedValue() as String
    }

    private func readTransportLocked() -> UInt32 {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var transport = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &transport)
        return status == noErr ? transport : 0
    }

    /// Pick a glyph from the device name first (AirPods variants), then the
    /// transport type for everything else.
    private static func routeSymbol(name: String, transport: UInt32) -> String {
        let lowered = name.lowercased()
        if lowered.contains("airpods max") { return "airpods.max" }
        if lowered.contains("airpods pro") { return "airpods.pro" }
        if lowered.contains("airpods") { return "airpods" }
        if lowered.contains("homepod") { return "homepod.fill" }
        if lowered.contains("headphone") { return "headphones" }

        switch transport {
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE:
            return "headphones"
        case kAudioDeviceTransportTypeUSB:
            return "hifispeaker.fill"
        case kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeDisplayPort:
            return "display"
        case kAudioDeviceTransportTypeAirPlay:
            return "airplayaudio"
        default:
            return "speaker.wave.2.fill"
        }
    }

    // MARK: - Binding (always on `queue`)

    private func rebindDeviceLocked() {
        removeListenersLocked(from: deviceID)

        var newDevice = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        let status = AudioObjectGetPropertyData(systemObject, &defaultDeviceAddress, 0, nil, &size, &newDevice)
        guard status == noErr else { return }
        deviceID = newDevice

        if hasBoundOnce, newDevice != previousDeviceID {
            let name = readNameLocked()
            let symbol = Self.routeSymbol(name: name, transport: readTransportLocked())
            DispatchQueue.main.async { [weak self] in self?.onRouteChange?(name, symbol) }
        }
        previousDeviceID = newDevice
        hasBoundOnce = true

        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.emitLocked()
        }
        deviceListener = listener
        AudioObjectAddPropertyListenerBlock(deviceID, &volumeAddress, queue, listener)
        AudioObjectAddPropertyListenerBlock(deviceID, &muteAddress, queue, listener)
        emitLocked()
    }

    private func removeListenersLocked(from device: AudioObjectID) {
        guard device != kAudioObjectUnknown, let listener = deviceListener else { return }
        AudioObjectRemovePropertyListenerBlock(device, &volumeAddress, queue, listener)
        AudioObjectRemovePropertyListenerBlock(device, &muteAddress, queue, listener)
    }

    private func emitLocked() {
        let volume = readVolumeLocked()
        let muted = readMutedLocked()
        DispatchQueue.main.async { [weak self] in
            self?.onChange?(volume, muted)
        }
    }
}
