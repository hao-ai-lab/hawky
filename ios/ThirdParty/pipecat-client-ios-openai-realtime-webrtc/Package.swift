// swift-tools-version:5.5
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "PipecatClientIOSOpenAIRealtimeWebrtc",
    platforms: [
        .iOS(.v13)
    ],
    products: [
        .library(
            name: "PipecatClientIOSOpenAIRealtimeWebrtc",
            targets: ["PipecatClientIOSOpenAIRealtimeWebrtc"]),
    ],
    dependencies: [
        // Local dependency
        //.package(path: "../pipecat-client-ios"),
        .package(url: "https://github.com/pipecat-ai/pipecat-client-ios.git", from: "0.3.4"),
        .package(url: "https://github.com/stasel/WebRTC", from: "134.0.0"),
    ],
    targets: [
        .target(
            name: "PipecatClientIOSOpenAIRealtimeWebrtc",
            dependencies: [
                .product(name: "PipecatClientIOS", package: "pipecat-client-ios"),
                .product(name: "WebRTC", package: "WebRTC")
            ]),
    ]
)
