import StarboardCore
import SwiftUI

/// The sheet the Stages leader then `=` opens: a name, a letter, and which of
/// the visible apps belong to the Stage.
struct StageSaveView: View {
    let apps: [AppCandidate]
    let takenLetters: Set<Character>
    /// The name, the letter, and the apps left checked.
    let onSave: (String, Character, [AppCandidate]) -> Void
    let onCancel: () -> Void

    @State private var name = ""
    @State private var letter: Character = "a"
    @State private var included: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Metrics.grid * 2) {
            Text("Save Stage")
                .font(.system(size: 15, weight: .semibold))

            HStack(spacing: Theme.Metrics.grid) {
                TextField("Name (e.g. Writing)", text: $name)
                    .textFieldStyle(.roundedBorder)
                Picker("", selection: $letter) {
                    ForEach(letterOptions, id: \.self) { option in
                        Text(option.uppercased()).tag(option)
                    }
                }
                .labelsHidden()
                .frame(width: 64)
            }

            VStack(alignment: .leading, spacing: 4) {
                ForEach(apps, id: \.bundleID) { app in
                    Toggle(isOn: binding(for: app.bundleID)) {
                        HStack(spacing: Theme.Metrics.grid) {
                            if let icon = AppIcons.icon(for: app.bundleID) {
                                Image(nsImage: icon)
                                    .resizable()
                                    .frame(width: 18, height: 18)
                            }
                            Text(app.name).font(.system(size: 13))
                        }
                    }
                    .toggleStyle(.checkbox)
                }
            }

            HStack {
                Spacer()
                Button("Cancel", action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button("Save") { onSave(name, letter, apps.filter { included.contains($0.bundleID) }) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(included.isEmpty)
            }
        }
        .padding(Theme.Metrics.grid * 3)
        .frame(width: 380)
        .onAppear {
            included = Set(apps.map(\.bundleID))
            letter = letterOptions.first ?? "a"
        }
    }

    /// Free letters first so replacing an existing Stage is deliberate.
    private var letterOptions: [Character] {
        let all = LetterAssigner.alphabet
        return all.filter { !takenLetters.contains($0) } + all.filter(takenLetters.contains)
    }

    private func binding(for bundleID: String) -> Binding<Bool> {
        Binding(
            get: { included.contains(bundleID) },
            set: { isOn in
                if isOn {
                    included.insert(bundleID)
                } else {
                    included.remove(bundleID)
                }
            }
        )
    }
}
