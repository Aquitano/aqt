import Carbon.HIToolbox
import Foundation
import NotchCore

/// One global hotkey via Carbon `RegisterEventHotKey`. Unlike an event tap this
/// needs no Input Monitoring grant and consumes the chord system-wide, which is
/// exactly right for a "toggle the notch" shortcut.
final class HotKey: @unchecked Sendable {
    /// Fired on the main queue.
    var onPress: (() -> Void)?

    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?

    private static let signature: OSType = 0x4E54_4348 // "NTCH"

    /// Replace any current registration with `keyCode` + Carbon `modifiers`.
    func register(keyCode: UInt32, modifiers: UInt32) {
        unregister()
        installHandlerIfNeeded()
        let id = EventHotKeyID(signature: Self.signature, id: 1)
        let status = RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef)
        if status != noErr {
            Log.app.error("Hotkey registration failed: \(status)")
        }
    }

    func unregister() {
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
    }

    private func installHandlerIfNeeded() {
        guard eventHandler == nil else { return }
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, refcon in
            guard let event, let refcon else { return noErr }
            var id = EventHotKeyID()
            GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &id
            )
            guard id.signature == HotKey.signature else { return noErr }
            let hotKey = Unmanaged<HotKey>.fromOpaque(refcon).takeUnretainedValue()
            DispatchQueue.main.async { hotKey.onPress?() }
            return noErr
        }, 1, &eventType, refcon, &eventHandler)
    }

    deinit {
        unregister()
        if let handler = eventHandler {
            RemoveEventHandler(handler)
        }
    }
}
