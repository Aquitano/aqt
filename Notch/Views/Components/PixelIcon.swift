import AppKit
import SwiftUI

/// App-wide retro icon renderer. Existing semantic/SF-symbol names remain the
/// input API, but every visible glyph is drawn from the same crisp 7×7 grid.
struct PixelIcon: View {
    let systemName: String
    var size: CGFloat = 16
    var tint: Color = .primary

    private var glyph: PixelGlyph { .resolve(systemName) }

    var body: some View {
        Canvas(rendersAsynchronously: false) { context, canvasSize in
            let cell = max(1, floor(min(canvasSize.width, canvasSize.height) / 7))
            let content = cell * 7
            let origin = CGPoint(
                x: floor((canvasSize.width - content) / 2),
                y: floor((canvasSize.height - content) / 2)
            )
            for (row, bits) in glyph.rows.enumerated() {
                for column in 0..<7 where bits & UInt8(1 << (6 - column)) != 0 {
                    let rect = CGRect(
                        x: origin.x + CGFloat(column) * cell,
                        y: origin.y + CGFloat(row) * cell,
                        width: cell,
                        height: cell
                    )
                    context.fill(Path(rect), with: .color(tint))
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Pixel counterpart to `Label(_:systemImage:)` for status and Settings rows.
struct PixelLabel: View {
    let title: String
    let systemName: String
    var size: CGFloat = 14
    var tint: Color = .primary

    var body: some View {
        HStack(spacing: 6) {
            PixelIcon(systemName: systemName, size: size, tint: tint)
            Text(title)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Produces the same pixel mark for the AppKit menu-bar status item.
@MainActor
enum PixelIconImage {
    static func image(systemName: String, size: CGFloat = 18) -> NSImage {
        let glyph = PixelGlyph.resolve(systemName)
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            NSGraphicsContext.current?.shouldAntialias = false
            NSColor.black.setFill()
            let cell = max(1, floor(min(rect.width, rect.height) / 7))
            let content = cell * 7
            let x = floor((rect.width - content) / 2)
            let y = floor((rect.height - content) / 2)
            for (row, bits) in glyph.rows.enumerated() {
                for column in 0..<7 where bits & UInt8(1 << (6 - column)) != 0 {
                    NSRect(
                        x: x + CGFloat(column) * cell,
                        y: rect.height - y - CGFloat(row + 1) * cell,
                        width: cell,
                        height: cell
                    ).fill()
                }
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Notch"
        return image
    }
}

/// Compact semantic set; related weather/device/SF names intentionally converge
/// on one family instead of carrying dozens of visually unrelated silhouettes.
private enum PixelGlyph {
    case notch, music, play, backward, tray, grid, gear, warning, check, hourglass
    case minus, trash, terminal, shuffle, repeatMode, note, moon, leaf, clock
    case calendar, bolt, share, radio, wifi, location, speaker, mute, sun
    case cloud, rain, snow, fog, storm, headphones, keyboard, mouse, layers
    case spark, code, braces, shell, battery

    static func resolve(_ rawName: String) -> PixelGlyph {
        let name = rawName.lowercased()
        if name.contains("rectangle.tophalf") { return .notch }
        if name.contains("speaker.slash") { return .mute }
        if name.contains("speaker") || name.contains("homepod") { return .speaker }
        if name.contains("cloud.bolt") { return .storm }
        if name.contains("cloud.snow") { return .snow }
        if name.contains("cloud.rain") || name.contains("cloud.drizzle") || name.contains("heavyrain") { return .rain }
        if name.contains("cloud.fog") { return .fog }
        if name.contains("cloud") { return .cloud }
        if name.contains("moon") { return .moon }
        if name.contains("sun") || name.contains("brightness") { return .sun }
        if name.contains("music") { return .music }
        if name.contains("backward") { return .backward }
        if name.contains("forward") || name.contains("play") { return .play }
        if name.contains("tray") { return .tray }
        if name.contains("square.2.layers") { return .layers }
        if name.contains("square.grid") { return .grid }
        if name.contains("gear") { return .gear }
        if name.contains("exclamation") { return .warning }
        if name.contains("checkmark") { return .check }
        if name.contains("hourglass") { return .hourglass }
        if name.contains("minus") { return .minus }
        if name.contains("trash") { return .trash }
        if name.contains("terminal") { return .terminal }
        if name.contains("shuffle") { return .shuffle }
        if name.contains("repeat") { return .repeatMode }
        if name.contains("note") { return .note }
        if name.contains("leaf") { return .leaf }
        if name.contains("clock") || name.contains("timer") { return .clock }
        if name.contains("calendar") { return .calendar }
        if name.contains("battery") { return .battery }
        if name.contains("bolt") { return .bolt }
        if name.contains("airdrop") || name.contains("paperplane") { return .share }
        if name.contains("wifi") { return .wifi }
        if name.contains("location") { return .location }
        if name.contains("radiowave") || name.contains("wave.3") { return .radio }
        if name.contains("airpods") || name.contains("headphone") { return .headphones }
        if name.contains("keyboard") { return .keyboard }
        if name.contains("mouse") { return .mouse }
        if name.contains("sparkle") { return .spark }
        if name.contains("chevron.left") { return .code }
        if name.contains("curly") { return .braces }
        if name.contains("fossil") { return .shell }
        return .spark
    }

    /// Seven 7-bit rows, top to bottom.
    var rows: [UInt8] {
        switch self {
        case .notch: return bits("#######", "#######", "##...##", "#.....#", "#.###.#", "#.###.#", ".......")
        case .music: return bits("....##.", "....##.", "..####.", "..#..#.", "..#..#.", ".##.###", ".#..##.")
        case .play: return bits("..#....", "..##...", "..###..", "..####.", "..###..", "..##...", "..#....")
        case .backward: return bits("....#..", "...##..", "..###..", ".####..", "..###..", "...##..", "....#..")
        case .tray: return bits("...#...", "..###..", "...#...", "...#...", ".#...#.", ".#####.", "..###..")
        case .grid: return bits(".......", ".##.##.", ".##.##.", ".......", ".##.##.", ".##.##.", ".......")
        case .gear: return bits("..#.#..", ".#####.", "##.#.##", ".#.###.", "##.#.##", ".#####.", "..#.#..")
        case .warning: return bits("...#...", "..###..", "..#.#..", ".##.##.", ".#...#.", "##.#.##", "#######")
        case .check: return bits("......#", ".....##", "#...##.", ".#.##..", "..##...", "..#....", ".......")
        case .hourglass: return bits(".#####.", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", ".#####.")
        case .minus: return bits(".......", ".......", ".......", ".#####.", ".......", ".......", ".......")
        case .trash: return bits("..###..", ".#####.", ".#...#.", ".#.#.#.", ".#.#.#.", ".#...#.", ".#####.")
        case .terminal: return bits(".......", ".#.....", "..#....", "...#...", "..#....", ".#..##.", "....##.")
        case .shuffle: return bits(".##...#", "...#.#.", "....#..", "...#...", "..#....", ".#.###.", "#......")
        case .repeatMode: return bits("..####.", ".#....#", "#.....#", "#..#..#", "#.....#", ".#....#", ".####..")
        case .note: return bits("....##.", "....##.", "....##.", "..####.", "..#..#.", ".##.##.", ".#..#..")
        case .moon: return bits("...###.", ".#####.", "##.....", "##.....", "##.....", ".#####.", "...###.")
        case .leaf: return bits("....##.", "..####.", ".####..", ".###...", "..##...", "...#...", "...#...")
        case .clock: return bits("..###..", ".#...#.", "#..#..#", "#..##.#", "#.....#", ".#...#.", "..###..")
        case .calendar: return bits(".#...#.", ".#...#.", ".#####.", "#.....#", "#.#.#.#", "#.....#", ".#####.")
        case .bolt: return bits("....#..", "...##..", "..###..", ".#####.", "...##..", "..##...", "..#....")
        case .share: return bits("...#...", "..###..", ".#.#.#.", "#..#..#", "...#...", "..###..", ".#####.")
        case .radio: return bits("...#...", "..#.#..", ".#...#.", "#..#..#", ".#...#.", "..#.#..", "...#...")
        case .wifi: return bits(".......", ".#####.", "#.....#", "..###..", ".#...#.", "...#...", "...#...")
        case .location: return bits("..###..", ".#...#.", "#.....#", "#..#..#", ".#...#.", "..###..", "...#...")
        case .speaker: return bits(".......", "..#....", ".##..#.", "###...#", "###...#", ".##..#.", "..#....")
        case .mute: return bits("..#...#", ".##..#.", "###.#..", "###....", "###.#..", ".##..#.", "..#...#")
        case .sun: return bits("..#.#..", "...#...", ".#.#.#.", "..###..", ".#####.", "..###..", "...#...")
        case .cloud: return bits(".......", "..###..", ".#...#.", "#######", "#######", ".#####.", ".......")
        case .rain: return bits("..###..", ".#...#.", "#######", ".#####.", ".#.#.#.", "#.#.#..", ".......")
        case .snow: return bits("..###..", ".#...#.", "#######", ".#####.", "..#.#..", ".#.#.#.", "..#.#..")
        case .fog: return bits("..###..", ".#...#.", "#######", ".#####.", ".......", ".#####.", "..###..")
        case .storm: return bits("..###..", ".#...#.", "#######", ".#####.", "...##..", "..##...", "..#....")
        case .headphones: return bits("..###..", ".#...#.", "#.....#", "#.....#", "##...##", "##...##", ".#...#.")
        case .keyboard: return bits(".......", ".#####.", "#.#.#.#", "#.#.#.#", "#.....#", ".#####.", ".......")
        case .mouse: return bits("..###..", ".#.#.#.", "#..#..#", "#..#..#", "#.....#", ".#...#.", "..###..")
        case .layers: return bits("..###..", ".#...#.", "..###..", ".#...#.", "..###..", ".#####.", ".......")
        case .spark: return bits("...#...", "#..#..#", "..###..", ".#####.", "..###..", "#..#..#", "...#...")
        case .code: return bits(".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "....###", "....###")
        case .braces: return bits("..##.##", ".#...#.", ".#...#.", "##...##", ".#...#.", ".#...#.", "..##.##")
        case .shell: return bits("..###..", ".#...#.", "#.#.#.#", "#.....#", ".#.#.#.", "..###..", "...#...")
        case .battery: return bits(".......", ".#####.", "#.....#", "#.###.#", "#.###.#", "#.....#", ".#####.")
        }
    }

    private func bits(_ rows: String...) -> [UInt8] {
        rows.map { row in
            row.reduce(UInt8(0)) { ($0 << 1) | ($1 == "#" ? 1 : 0) }
        }
    }
}
