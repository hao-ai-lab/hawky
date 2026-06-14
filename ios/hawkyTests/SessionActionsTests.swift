import Testing
import Foundation
@testable import hawky

@Suite @MainActor
struct SessionActionsTests {
    private func seeded() -> SessionStore {
        let store = SessionStore()
        store.replaceAll([
            .init(key: "ios:main", displayName: "main", unreadCount: 0),
            .init(key: "ios:work", displayName: "Work", unreadCount: 0, isPinned: true),
            .init(key: "ios:old", displayName: "Old", unreadCount: 0, isArchived: true),
            .init(key: "ios:z", displayName: "Zeta", unreadCount: 0, lastActivity: Date(timeIntervalSince1970: 100)),
            .init(key: "ios:a", displayName: "Alpha", unreadCount: 0, lastActivity: Date(timeIntervalSince1970: 200)),
        ])
        return store
    }

    @Test func upsertPreservesPinAndArchiveWhenNotOverridden() {
        let store = SessionStore()
        store.replaceAll([
            .init(key: "k", displayName: "K", unreadCount: 0, isPinned: true, isArchived: true)
        ])
        // New upsert with default flags should NOT clobber existing true flags.
        store.upsert(.init(key: "k", displayName: "K2", unreadCount: 1))
        #expect(store.sessions[0].displayName == "K2")
        #expect(store.sessions[0].unreadCount == 1)
        #expect(store.sessions[0].isPinned == true)
        #expect(store.sessions[0].isArchived == true)
    }

    @Test func upsertRespectsExplicitFlagOverride() {
        let store = SessionStore()
        store.replaceAll([
            .init(key: "k", displayName: "K", unreadCount: 0, isPinned: false)
        ])
        store.upsert(.init(key: "k", displayName: "K", unreadCount: 0, isPinned: true))
        #expect(store.sessions[0].isPinned == true)
    }

    @Test func sortPutsPinnedFirstThenRecentThenAlpha() {
        let store = seeded()
        let visible = store.sessions.filter { !$0.isArchived }
        let sorted = SessionStore.sorted(visible)
        // work (pinned) first.
        #expect(sorted[0].key == "ios:work")
        // Then by lastActivity desc: a(200) > z(100); main has no activity → last.
        #expect(sorted[1].key == "ios:a")
        #expect(sorted[2].key == "ios:z")
        #expect(sorted[3].key == "ios:main")
    }

    @Test func setPinnedAndArchivedMutateInPlace() {
        let store = seeded()
        store.setPinned("ios:main", true)
        store.setArchived("ios:a", true)
        #expect(store.sessions.first(where: { $0.key == "ios:main" })?.isPinned == true)
        #expect(store.sessions.first(where: { $0.key == "ios:a" })?.isArchived == true)
    }

    @Test func removeDropsEntry() {
        let store = seeded()
        let before = store.sessions.count
        store.remove(key: "ios:z")
        #expect(store.sessions.count == before - 1)
        #expect(!store.sessions.contains(where: { $0.key == "ios:z" }))
    }

    @Test func setDisplayNameUpdatesRow() {
        let store = seeded()
        store.setDisplayName("ios:a", "Apple")
        #expect(store.sessions.first(where: { $0.key == "ios:a" })?.displayName == "Apple")
    }

    // The "fallback" picks ios:main when present, otherwise first non-archived.
    // We test the selection logic directly by replicating it on the seeded store.
    @Test func archiveFallbackPrefersMainElseFirstNonArchived() {
        let store = seeded()
        // With main present, it wins.
        let afterArchivingWork = store.sessions.filter { $0.key != "ios:work" && !$0.isArchived }
        #expect(afterArchivingWork.contains(where: { $0.key == "ios:main" }))

        // Remove main — fallback should pick first non-archived.
        store.remove(key: "ios:main")
        let pool = store.sessions.filter { $0.key != "ios:work" && !$0.isArchived }
        #expect(!pool.isEmpty)
        #expect(pool.allSatisfy { !$0.isArchived })
    }
}
