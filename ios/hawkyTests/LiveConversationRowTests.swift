import Foundation
import Testing
@testable import hawky

// =============================================================================
// Tests for LiveConversationRow.group — the system-entry grouping that drives the
// transcript. Safety Check (#648): hazard warnings (eventType "safety.warning")
// must ALWAYS render as their own standalone row (red bubble), never folded into
// the collapsible "Intermediate messages" group where the user can't see them.
// This regressed once (warnings were grouped + hidden), so it's pinned here.
// =============================================================================

private func entry(_ role: LiveConversationRole, _ text: String, eventType: String? = nil) -> LiveConversationEntry {
    LiveConversationEntry(role: role, text: text, level: .info, isStreaming: false, eventType: eventType)
}

@Suite struct LiveConversationRowTests {
    @Test func safetyWarningIsStandaloneNotGrouped() {
        let rows = LiveConversationRow.group([
            entry(.system, "Listening"),
            entry(.system, "Streaming Back camera at 1 fps"),
            entry(.system, "Careful — the pan is hot.", eventType: "safety.warning"),
            entry(.system, "Audio route: …"),
        ])
        // The two leading system lines group; the safety warning stands alone; the
        // trailing system line forms its own group.
        #expect(rows.count == 3)
        guard case .systemGroup(_, let firstGroup) = rows[0] else { Issue.record("row0 should be a group"); return }
        #expect(firstGroup.count == 2)
        guard case .entry(let safety) = rows[1] else { Issue.record("row1 should be a standalone entry"); return }
        #expect(safety.eventType == "safety.warning")
        guard case .systemGroup = rows[2] else { Issue.record("row2 should be a group"); return }
    }

    @Test func consecutiveSafetyWarningsEachStandAlone() {
        let rows = LiveConversationRow.group([
            entry(.system, "Careful — the pan is hot.", eventType: "safety.warning"),
            entry(.system, "Careful — knife near the edge.", eventType: "safety.warning"),
        ])
        #expect(rows.count == 2)
        for row in rows {
            guard case .entry(let e) = row else { Issue.record("safety warnings must not group"); return }
            #expect(e.eventType == "safety.warning")
        }
    }

    @Test func bootContextAlsoStandsAlone() {
        let rows = LiveConversationRow.group([
            entry(.system, "memory loaded", eventType: "hawky.boot_context.loaded"),
            entry(.system, "Listening"),
        ])
        #expect(rows.count == 2)
        guard case .entry = rows[0] else { Issue.record("boot context should stand alone"); return }
        guard case .systemGroup = rows[1] else { Issue.record("trailing system should group"); return }
    }

    @Test func plainSystemRunStaysGrouped() {
        let rows = LiveConversationRow.group([
            entry(.system, "Connecting"),
            entry(.system, "Connected"),
            entry(.system, "Listening"),
        ])
        #expect(rows.count == 1)
        guard case .systemGroup(_, let g) = rows[0] else { Issue.record("should be one group"); return }
        #expect(g.count == 3)
    }

    // Safety Check (#648): a hazard warning is a .system entry but must ALWAYS be
    // visible — even when the Show-system-messages toggle is OFF. This was the bug
    // behind "warning shows in the system log but no red bubble when it's off".
    @Test func safetyWarningVisibleEvenWhenSystemLogOff() {
        let warn = entry(.system, "⚠️ Careful — the pan is hot.", eventType: "safety.warning")
        #expect(LiveConversationVisibility.isVisible(entry: warn, devMode: false, showSystem: false, showFrames: false, imageOnly: false))
        #expect(LiveConversationVisibility.isVisible(entry: warn, devMode: true, showSystem: true, showFrames: false, imageOnly: false))
    }

    @Test func plainSystemHiddenWhenSystemLogOff() {
        let sys = entry(.system, "Listening")
        #expect(!LiveConversationVisibility.isVisible(entry: sys, devMode: false, showSystem: false, showFrames: false, imageOnly: false))
        #expect(!LiveConversationVisibility.isVisible(entry: sys, devMode: true, showSystem: false, showFrames: false, imageOnly: false))
        #expect(LiveConversationVisibility.isVisible(entry: sys, devMode: true, showSystem: true, showFrames: false, imageOnly: false))
    }

    @Test func assistantAlwaysVisible() {
        let a = entry(.assistant, "Hi there")
        #expect(LiveConversationVisibility.isVisible(entry: a, devMode: false, showSystem: false, showFrames: false, imageOnly: false))
    }

    @Test func assistantBreaksTheSystemRun() {
        let rows = LiveConversationRow.group([
            entry(.system, "Connecting"),
            entry(.assistant, "Hi there"),
            entry(.system, "Listening"),
        ])
        #expect(rows.count == 3)
        guard case .systemGroup = rows[0] else { Issue.record("row0 group"); return }
        guard case .entry(let a) = rows[1] else { Issue.record("row1 assistant entry"); return }
        #expect(a.role == .assistant)
        guard case .systemGroup = rows[2] else { Issue.record("row2 group"); return }
    }
}
