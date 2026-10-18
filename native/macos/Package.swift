// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Murmur",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "Murmur", targets: ["Murmur"])],
    targets: [
        .executableTarget(
            name: "Murmur",
            path: "Sources/Murmur",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("EventKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("Security"),
                .linkedFramework("ServiceManagement"),
                .linkedFramework("UserNotifications"),
            ]
        ),
        .testTarget(name: "MurmurTests", dependencies: ["Murmur"], path: "Tests/MurmurTests"),
    ]
)
