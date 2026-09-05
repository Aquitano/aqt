import AppKit
import NotchCore
import SwiftUI

/// App-wide retro icon renderer. Existing semantic/SF-symbol names remain the
/// input API, but every visible glyph is drawn from the same crisp 7×7 grid.
struct PixelIcon: View {
    let systemName: String
    var size: CGFloat = 16
    var tint: Color = .primary

    private var glyph: PixelGlyph {
        .resolve(systemName)
    }

    var body: some View {
        Canvas(rendersAsynchronously: false) { context, canvasSize in
            let cell = max(1, floor(min(canvasSize.width, canvasSize.height) / 7))
            let content = cell * 7
            let opticalOffset = glyph.opticalOffset
            let origin = CGPoint(
                // Preserve the true center when an icon size leaves an odd point
                // outside the integer-cell grid. On Retina displays the half-point
                // lands on a physical pixel; flooring here biased every such icon
                // toward the leading/top edge of its control.
                x: (canvasSize.width - content) / 2 + opticalOffset.x * cell,
                y: (canvasSize.height - content) / 2 + opticalOffset.y * cell
            )
            for (row, bits) in glyph.rows.enumerated() {
                for column in 0 ..< 7 where bits & UInt8(1 << (6 - column)) != 0 {
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
            let opticalOffset = glyph.opticalOffset
            let x = (rect.width - content) / 2 + opticalOffset.x * cell
            let y = (rect.height - content) / 2 + opticalOffset.y * cell
            for (row, bits) in glyph.rows.enumerated() {
                for column in 0 ..< 7 where bits & UInt8(1 << (6 - column)) != 0 {
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
    case spark, code, braces, shell, battery, eye, clipboard, link
    case plus, pause, folder, open, photo, power, xmark

    static func resolve(_ rawName: String) -> PixelGlyph {
        let name = rawName.lowercased()
        if name.contains("rectangle.tophalf") {
            return .notch
        }
        if name.contains("speaker.slash") {
            return .mute
        }
        if name.contains("speaker") || name.contains("homepod") {
            return .speaker
        }
        if name.contains("cloud.bolt") {
            return .storm
        }
        if name.contains("cloud.snow") {
            return .snow
        }
        if name.contains("cloud.rain") || name.contains("cloud.drizzle") || name.contains("heavyrain") {
            return .rain
        }
        if name.contains("cloud.fog") {
            return .fog
        }
        if name.contains("cloud") {
            return .cloud
        }
        if name.contains("moon") {
            return .moon
        }
        if name.contains("sun") || name.contains("brightness") {
            return .sun
        }
        if name.contains("music") {
            return .music
        }
        if name.contains("pause") {
            return .pause
        }
        if name.contains("backward") {
            return .backward
        }
        if name.contains("arrow.up.forward") {
            return .open
        }
        if name.contains("forward") || name.contains("play") {
            return .play
        }
        if name.contains("tray") {
            return .tray
        }
        if name.contains("folder") {
            return .folder
        }
        if name.contains("photo") {
            return .photo
        }
        if name.contains("power") {
            return .power
        }
        if name.contains("plus") {
            return .plus
        }
        if name.contains("square.2.layers") {
            return .layers
        }
        if name.contains("square.grid") {
            return .grid
        }
        if name.contains("gear") {
            return .gear
        }
        if name.contains("exclamation") {
            return .warning
        }
        if name.contains("xmark") || name.contains("stop") {
            return .xmark
        }
        if name.contains("checkmark") {
            return .check
        }
        if name.contains("hourglass") {
            return .hourglass
        }
        if name.contains("minus") {
            return .minus
        }
        if name.contains("trash") {
            return .trash
        }
        if name.contains("terminal") {
            return .terminal
        }
        if name.contains("shuffle") {
            return .shuffle
        }
        if name.contains("repeat") {
            return .repeatMode
        }
        if name.contains("note") {
            return .note
        }
        if name.contains("leaf") {
            return .leaf
        }
        if name.contains("clock") || name.contains("timer") {
            return .clock
        }
        if name.contains("calendar") {
            return .calendar
        }
        if name.contains("battery") {
            return .battery
        }
        if name.contains("clipboard") {
            return .clipboard
        }
        if name.contains("eye") {
            return .eye
        }
        if name.contains("link") {
            return .link
        }
        if name.contains("bolt") {
            return .bolt
        }
        if name.contains("airdrop") || name.contains("paperplane") {
            return .share
        }
        if name.contains("wifi") {
            return .wifi
        }
        if name.contains("location") {
            return .location
        }
        if name.contains("radiowave") || name.contains("wave.3") {
            return .radio
        }
        if name.contains("airpods") || name.contains("headphone") {
            return .headphones
        }
        if name.contains("keyboard") {
            return .keyboard
        }
        if name.contains("mouse") {
            return .mouse
        }
        if name.contains("sparkle") {
            return .spark
        }
        if name.contains("chevron.left") {
            return .code
        }
        if name.contains("curly") {
            return .braces
        }
        if name.contains("fossil") {
            return .shell
        }
        return .spark
    }

    /// Seven 7-bit rows, top to bottom.
    var rows: [UInt8] {
        switch self {
        case .notch: bits("#######", "#######", "##...##", "#.....#", "#.###.#", "#.###.#", ".......")
        case .music: bits("....##.", "....##.", "..####.", "..#..#.", "..#..#.", ".##.###", ".#..##.")
        case .play: bits("..#....", "..##...", "..###..", "..####.", "..###..", "..##...", "..#....")
        case .backward: bits("....#..", "...##..", "..###..", ".####..", "..###..", "...##..", "....#..")
        case .tray: bits("...#...", "..###..", "...#...", "...#...", ".#...#.", ".#####.", "..###..")
        case .grid: bits(".......", ".##.##.", ".##.##.", ".......", ".##.##.", ".##.##.", ".......")
        case .gear: bits("..#.#..", ".#####.", "##.#.##", ".#.###.", "##.#.##", ".#####.", "..#.#..")
        case .warning: bits("...#...", "..###..", "..#.#..", ".##.##.", ".#...#.", "##.#.##", "#######")
        case .check: bits("......#", ".....##", "#...##.", ".#.##..", "..##...", "..#....", ".......")
        case .hourglass: bits(".#####.", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", ".#####.")
        case .minus: bits(".......", ".......", ".......", ".#####.", ".......", ".......", ".......")
        case .trash: bits("..###..", ".#####.", ".#...#.", ".#.#.#.", ".#.#.#.", ".#...#.", ".#####.")
        case .terminal: bits(".......", ".#.....", "..#....", "...#...", "..#....", ".#..##.", "....##.")
        case .shuffle: bits(".##...#", "...#.#.", "....#..", "...#...", "..#....", ".#.###.", "#......")
        case .repeatMode: bits("..####.", ".#....#", "#.....#", "#..#..#", "#.....#", ".#....#", ".####..")
        case .note: bits("....##.", "....##.", "....##.", "..####.", "..#..#.", ".##.##.", ".#..#..")
        case .moon: bits("...###.", ".#####.", "##.....", "##.....", "##.....", ".#####.", "...###.")
        case .leaf: bits("....##.", "..####.", ".####..", ".###...", "..##...", "...#...", "...#...")
        case .clock: bits("..###..", ".#...#.", "#..#..#", "#..##.#", "#.....#", ".#...#.", "..###..")
        case .calendar: bits(".#...#.", ".#...#.", ".#####.", "#.....#", "#.#.#.#", "#.....#", ".#####.")
        case .bolt: bits("....#..", "...##..", "..###..", ".#####.", "...##..", "..##...", "..#....")
        case .share: bits("...#...", "..###..", ".#.#.#.", "#..#..#", "...#...", "..###..", ".#####.")
        case .radio: bits("...#...", "..#.#..", ".#...#.", "#..#..#", ".#...#.", "..#.#..", "...#...")
        case .wifi: bits(".......", ".#####.", "#.....#", "..###..", ".#...#.", "...#...", "...#...")
        case .location: bits("..###..", ".#...#.", "#.....#", "#..#..#", ".#...#.", "..###..", "...#...")
        case .speaker: bits(".......", "..#....", ".##..#.", "###...#", "###...#", ".##..#.", "..#....")
        case .mute: bits("..#...#", ".##..#.", "###.#..", "###....", "###.#..", ".##..#.", "..#...#")
        case .sun: bits("..#.#..", "...#...", ".#.#.#.", "..###..", ".#####.", "..###..", "...#...")
        case .cloud: bits(".......", "..###..", ".#...#.", "#######", "#######", ".#####.", ".......")
        case .rain: bits("..###..", ".#...#.", "#######", ".#####.", ".#.#.#.", "#.#.#..", ".......")
        case .snow: bits("..###..", ".#...#.", "#######", ".#####.", "..#.#..", ".#.#.#.", "..#.#..")
        case .fog: bits("..###..", ".#...#.", "#######", ".#####.", ".......", ".#####.", "..###..")
        case .storm: bits("..###..", ".#...#.", "#######", ".#####.", "...##..", "..##...", "..#....")
        case .headphones: bits("..###..", ".#...#.", "#.....#", "#.....#", "##...##", "##...##", ".#...#.")
        case .keyboard: bits(".......", ".#####.", "#.#.#.#", "#.#.#.#", "#.....#", ".#####.", ".......")
        case .mouse: bits("..###..", ".#.#.#.", "#..#..#", "#..#..#", "#.....#", ".#...#.", "..###..")
        case .layers: bits("..###..", ".#...#.", "..###..", ".#...#.", "..###..", ".#####.", ".......")
        case .spark: bits("...#...", "#..#..#", "..###..", ".#####.", "..###..", "#..#..#", "...#...")
        case .code: bits(".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", "....###", "....###")
        case .braces: bits("..##.##", ".#...#.", ".#...#.", "##...##", ".#...#.", ".#...#.", "..##.##")
        case .shell: bits("..###..", ".#...#.", "#.#.#.#", "#.....#", ".#.#.#.", "..###..", "...#...")
        case .battery: bits(".......", ".#####.", "#.....#", "#.###.#", "#.###.#", "#.....#", ".#####.")
        case .eye: bits(".......", "..###..", ".#...#.", "#..#..#", ".#...#.", "..###..", ".......")
        case .clipboard: bits("..###..", ".#####.", ".#...#.", ".#.###.", ".#...#.", ".#####.", ".......")
        case .link: bits(".......", ".###...", "#...#..", "..###..", ".#...#.", "..###..", ".......")
        case .plus: bits(".......", "...#...", "...#...", ".#####.", "...#...", "...#...", ".......")
        case .pause: bits(".......", ".##.##.", ".##.##.", ".##.##.", ".##.##.", ".##.##.", ".......")
        case .folder: bits(".......", ".##....", ".#####.", ".#....#", ".#....#", ".#####.", ".......")
        case .open: bits("...#...", "..###..", ".#.#.#.", "...#...", "##.#.##", "#.....#", "#######")
        case .photo: bits(".......", "..#....", ".#####.", "#.....#", "#.#.#.#", "#..#..#", "#######")
        case .power: bits("...#...", "...#...", ".#.#.#.", "#.....#", "#.....#", ".#...#.", "..###..")
        case .xmark: bits(".......", ".#...#.", "..#.#..", "...#...", "..#.#..", ".#...#.", ".......")
        }
    }

    /// Sub-cell optical corrections for glyphs whose silhouettes cannot be
    /// balanced on an odd 7×7 grid using whole rows alone. Values are expressed
    /// in grid cells so the adjustment scales with every requested icon size.
    var opticalOffset: CGPoint {
        switch self {
        case .terminal:
            CGPoint(x: 0, y: -0.5)
        case .clipboard:
            CGPoint(x: 0, y: 0.5)
        default:
            .zero
        }
    }

    private func bits(_ rows: String...) -> [UInt8] {
        rows.map { row in
            row.reduce(UInt8(0)) { ($0 << 1) | ($1 == "#" ? 1 : 0) }
        }
    }
}
