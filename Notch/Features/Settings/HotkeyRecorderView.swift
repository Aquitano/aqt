import SwiftUI
import AppKit
import Carbon.HIToolbox

/// Click-to-record control for the global toggle shortcut. While recording, a
/// local key monitor captures the next chord; the AppDelegate suspends the live
/// registration (via `Settings.isRecordingHotkey`) so the current chord can be
/// re-typed without toggling the notch out from under the recorder.
struct HotkeyRecorderView: View {
    @Environment(Settings.self) private var settings

    @State private var monitor: Any?
    @State private var heldModifiers = ""

    private var isRecording: Bool { monitor != nil }

    var body: some View {
        LabeledContent("Shortcut") {
            Button {
                isRecording ? stopRecording() : startRecording()
            } label: {
                Text(buttonTitle)
                    .monospaced()
                    .frame(minWidth: 110)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel(isRecording ? "Recording shortcut, press a key combination"
                                            : "Change shortcut")
        }
        .onDisappear { stopRecording() }
    }

    private var buttonTitle: String {
        if isRecording {
            return heldModifiers.isEmpty ? "Type shortcut…" : heldModifiers
        }
        return HotKeyChord(keyCode: settings.general.hotkeyKeyCode,
                           carbonModifiers: settings.general.hotkeyModifiers).display
    }

    private func startRecording() {
        settings.isRecordingHotkey = true
        heldModifiers = ""
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged]) { event in
            handle(event)
        }
    }

    private func stopRecording() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        heldModifiers = ""
        settings.isRecordingHotkey = false
    }

    private func handle(_ event: NSEvent) -> NSEvent? {
        let modifiers = HotKeyChord.carbonModifiers(from: event.modifierFlags)
        switch event.type {
        case .flagsChanged:
            heldModifiers = HotKeyChord(keyCode: 0, carbonModifiers: modifiers).modifierSymbols
            return event
        case .keyDown:
            if Int(event.keyCode) == kVK_Escape, modifiers == 0 {
                stopRecording()
                return nil
            }
            let chord = HotKeyChord(keyCode: Int(event.keyCode), carbonModifiers: modifiers)
            guard chord.isValid else {
                NSSound.beep()
                return nil
            }
            settings.general.hotkeyKeyCode = chord.keyCode
            settings.general.hotkeyModifiers = chord.carbonModifiers
            stopRecording()
            return nil
        default:
            return event
        }
    }
}
