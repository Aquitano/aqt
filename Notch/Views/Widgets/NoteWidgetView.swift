import SwiftUI

/// One persistent scratch note. The overlay panel is non-activating and only
/// key-capable on demand, so the editor latches the panel key while focused
/// (mirroring the share-sheet latch) — without that, keystrokes never arrive.
struct NoteWidgetView: View {
    @EnvironmentObject private var env: AppEnvironment
    @EnvironmentObject private var note: NoteManager
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "note.text")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.7))
                Text("Note")
                    .font(.headline)
                    .foregroundStyle(.white)
                Spacer(minLength: 0)
            }

            TextEditor(text: $note.text)
                .font(.callout)
                .foregroundStyle(.white)
                .scrollContentBackground(.hidden)
                .focused($focused)
                .overlay(alignment: .topLeading) {
                    if note.text.isEmpty && !focused {
                        Text("Jot something down…")
                            .font(.callout)
                            .foregroundStyle(.white.opacity(0.35))
                            .padding(.top, 1)
                            .padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                }
        }
        .notchCard()
        .onChange(of: focused) { _, isFocused in
            if isFocused {
                env.windowController?.beginTextEditing()
            } else {
                env.windowController?.endTextEditing()
            }
        }
        .onDisappear {
            env.windowController?.endTextEditing()
        }
    }
}
