import AppKit
import ImageIO
import NotchCore
import UniformTypeIdentifiers

/// Downsamples artwork with ImageIO (never decodes full-res into an NSImage) and
/// keeps results in a cost-limited cache. A 3000x3000 cover is ~36 MB decoded vs
/// ~0.5 MB downsampled, so this is the single biggest RAM lever in the app.
final class ImageCache: @unchecked Sendable {
    private let cache = NSCache<NSString, NSImage>()
    private let session: URLSession

    init() {
        cache.totalCostLimit = 48 * 1024 * 1024 // ~48 MB of decoded thumbnails

        let config = URLSessionConfiguration.default
        config.urlCache = URLCache(
            memoryCapacity: 8 * 1024 * 1024,
            diskCapacity: 64 * 1024 * 1024
        )
        config.requestCachePolicy = .returnCacheDataElseLoad
        self.session = URLSession(configuration: config)
    }

    // MARK: - Cache

    func image(forKey key: String) -> NSImage? {
        cache.object(forKey: key as NSString)
    }

    func store(_ image: NSImage, forKey key: String) {
        cache.setObject(image, forKey: key as NSString, cost: image.estimatedCost)
    }

    // MARK: - Decoding

    /// Decode `data` to a thumbnail no larger than `maxDimension` points.
    func downsample(data: Data, maxDimension: CGFloat, scale: CGFloat = 2) -> NSImage? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }

        let maxPixel = Int((maxDimension * scale).rounded())
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let size = NSSize(width: CGFloat(cg.width) / scale, height: CGFloat(cg.height) / scale)
        return NSImage(cgImage: cg, size: size)
    }

    /// Decode + cache under `key`. Safe to call off the main actor.
    func makeArtwork(from data: Data, key: String, maxDimension: CGFloat) -> NSImage? {
        if let cached = image(forKey: key) {
            return cached
        }
        guard let image = downsample(data: data, maxDimension: maxDimension) else { return nil }
        store(image, forKey: key)
        return image
    }

    /// Fetch + downsample remote artwork, fronted by the session's URLCache.
    func remoteImage(from url: URL, maxDimension: CGFloat) async -> NSImage? {
        let key = url.absoluteString
        if let cached = image(forKey: key) {
            return cached
        }
        do {
            let (data, _) = try await session.data(from: url)
            guard let image = downsample(data: data, maxDimension: maxDimension) else { return nil }
            store(image, forKey: key)
            return image
        } catch {
            return nil
        }
    }
}

private extension NSImage {
    var estimatedCost: Int {
        guard let rep = representations.first else { return 1 }
        return rep.pixelsWide * rep.pixelsHigh * 4
    }
}
