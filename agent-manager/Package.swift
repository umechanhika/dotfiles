// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AgentManager",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "AgentManager",
            path: "Sources/AgentManager"
        )
    ]
)
