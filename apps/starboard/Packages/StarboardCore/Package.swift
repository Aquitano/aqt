// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "StarboardCore",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "StarboardCore", targets: ["StarboardCore"]),
    ],
    targets: [
        .target(name: "StarboardCore"),
        .testTarget(name: "StarboardCoreTests", dependencies: ["StarboardCore"]),
    ],
    swiftLanguageModes: [.v6]
)
