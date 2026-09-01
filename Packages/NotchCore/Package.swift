// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "NotchCore",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "NotchCore", targets: ["NotchCore"]),
    ],
    targets: [
        .target(name: "NotchCore"),
        .testTarget(name: "NotchCoreTests", dependencies: ["NotchCore"]),
    ],
    swiftLanguageModes: [.v6]
)
