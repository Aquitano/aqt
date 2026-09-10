// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "TrackerCore",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "TrackerCore", targets: ["TrackerCore"]),
    ],
    targets: [
        .target(name: "TrackerCore"),
        .testTarget(name: "TrackerCoreTests", dependencies: ["TrackerCore"]),
    ],
    swiftLanguageModes: [.v6]
)
