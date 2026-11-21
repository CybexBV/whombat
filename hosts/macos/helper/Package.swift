// swift-tools-version: 6.0
// Whombat Helper: the small app that lets whombat-agent find and press buttons on a Mac's screen by name
// (README.md). HelperCore holds everything that can be tested without a screen: the socket, the protocol, name and
// role matching, the limits. WhombatHelper is the app itself: Accessibility, keyboard and mouse events, apps.
import PackageDescription

let package = Package(
    name: "WhombatHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "HelperCore"),
        .executableTarget(name: "WhombatHelper", dependencies: ["HelperCore"]),
        .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore"]),
    ]
)
