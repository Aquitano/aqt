import Foundation
import UniformTypeIdentifiers

enum TrayRepresentationKind: String, Equatable, Sendable {
    case fileURLs
    case image
    case webURL
    case plainText
}

enum TrayDropCapabilities {
    static let acceptedTypes: [UTType] = [
        .fileURL, .image, .url, .plainText, .utf8PlainText
    ]

    static let acceptedTypeIdentifiers = acceptedTypes.map(\.identifier)

    static func preferredKind(for typeIdentifiers: [String]) -> TrayRepresentationKind? {
        let types = typeIdentifiers.compactMap(UTType.init)
        if types.contains(where: { $0.conforms(to: .fileURL) }) { return .fileURLs }
        if types.contains(where: { $0.conforms(to: .image) }) { return .image }
        if types.contains(where: { $0.conforms(to: .url) }) { return .webURL }
        if types.contains(where: {
            $0.conforms(to: .plainText) || $0.conforms(to: .utf8PlainText)
        }) { return .plainText }
        return nil
    }

    static func preferredTypeIdentifier(
        for kind: TrayRepresentationKind,
        in typeIdentifiers: [String]
    ) -> String? {
        let target: UTType
        switch kind {
        case .fileURLs: target = .fileURL
        case .image: target = .image
        case .webURL: target = .url
        case .plainText: target = .plainText
        }
        return typeIdentifiers.first { identifier in
            UTType(identifier)?.conforms(to: target) == true
        }
    }
}

enum TrayFileNamePolicy {
    static func validated(_ proposed: String) -> String? {
        let name = proposed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != ".", name != "..",
              !name.contains("/"), !name.contains(":"),
              !name.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        else { return nil }
        return name
    }

    static func availableName(_ proposed: String, existing: Set<String>) -> String? {
        guard let valid = validated(proposed) else { return nil }
        let folded = Set(existing.map { $0.folding(
            options: [.caseInsensitive, .diacriticInsensitive], locale: .current
        ) })
        if !folded.contains(valid.folding(
            options: [.caseInsensitive, .diacriticInsensitive], locale: .current
        )) { return valid }

        let url = URL(fileURLWithPath: valid)
        let ext = url.pathExtension
        let stem = url.deletingPathExtension().lastPathComponent
        for index in 2...9_999 {
            let candidate = ext.isEmpty ? "\(stem) \(index)" : "\(stem) \(index).\(ext)"
            let key = candidate.folding(
                options: [.caseInsensitive, .diacriticInsensitive], locale: .current
            )
            if !folded.contains(key) { return candidate }
        }
        return nil
    }
}
