import Testing
import UIKit
@testable import hawky

@Suite struct LaunchIconTests {

    // The launch intro renders LaunchBranding.icon. Guard that the asset is
    // actually present and usable so the intro never floats a blank square.
    @Test func launchIconResolves() throws {
        let icon = try #require(LaunchBranding.icon,
                                "LaunchIcon asset must ship in the app bundle")
        #expect(icon.size.width > 0 && icon.size.height > 0)
    }

    // LaunchIcon is a relative symlink to AppIcon's source, so it must stay
    // square and high-resolution — the intro zooms it well past 1× scale.
    @Test func launchIconIsSquareAndHighRes() throws {
        let icon = try #require(LaunchBranding.icon)
        #expect(icon.size.width == icon.size.height, "launch icon should be square")
        #expect(min(icon.size.width, icon.size.height) >= 512,
                "launch icon should be high-resolution, got \(icon.size)")
    }
}
