#!/usr/bin/env swift

import AppKit

let outputDirectory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("Starboard/Resources/Assets.xcassets/AppIcon.appiconset")
try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

func point(_ x: CGFloat, _ y: CGFloat, size: CGFloat) -> NSPoint {
    NSPoint(x: x * size, y: y * size)
}

func drawIcon(pixels: Int) throws {
    let size = CGFloat(pixels)
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixels,
        pixelsHigh: pixels,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
        throw CocoaError(.fileWriteUnknown)
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    defer { NSGraphicsContext.restoreGraphicsState() }
    context.imageInterpolation = .high
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: size, height: size).fill()

    let outer = NSBezierPath(
        roundedRect: NSRect(x: size * 0.055, y: size * 0.055, width: size * 0.89, height: size * 0.89),
        xRadius: size * 0.22,
        yRadius: size * 0.22
    )
    NSColor(red: 1.0, green: 0.478, blue: 0.349, alpha: 1).setFill()
    outer.fill()

    let inset = NSBezierPath(
        roundedRect: NSRect(x: size * 0.17, y: size * 0.17, width: size * 0.66, height: size * 0.66),
        xRadius: size * 0.15,
        yRadius: size * 0.15
    )
    NSColor(red: 0.118, green: 0.122, blue: 0.133, alpha: 1).setFill()
    inset.fill()

    let compass = NSBezierPath()
    compass.move(to: point(0.50, 0.25, size: size))
    compass.line(to: point(0.575, 0.425, size: size))
    compass.line(to: point(0.75, 0.50, size: size))
    compass.line(to: point(0.575, 0.575, size: size))
    compass.line(to: point(0.50, 0.75, size: size))
    compass.line(to: point(0.425, 0.575, size: size))
    compass.line(to: point(0.25, 0.50, size: size))
    compass.line(to: point(0.425, 0.425, size: size))
    compass.close()
    NSColor.white.setFill()
    compass.fill()

    let needle = NSBezierPath()
    needle.move(to: point(0.50, 0.25, size: size))
    needle.line(to: point(0.575, 0.50, size: size))
    needle.line(to: point(0.50, 0.50, size: size))
    needle.close()
    NSColor(red: 1.0, green: 0.478, blue: 0.349, alpha: 1).setFill()
    needle.fill()

    context.flushGraphics()
    guard let png = bitmap.representation(using: .png, properties: [:])
    else { throw CocoaError(.fileWriteUnknown) }
    try png.write(to: outputDirectory.appendingPathComponent("AppIcon-\(pixels).png"))
}

for pixels in [16, 32, 64, 128, 256, 512, 1024] {
    try drawIcon(pixels: pixels)
}
