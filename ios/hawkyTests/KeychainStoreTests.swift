import Testing
import Foundation
@testable import hawky

@Suite struct KeychainStoreTests {
    private func uniqueURL() -> URL {
        URL(string: "http://test-\(UUID().uuidString).local")!
    }

    @Test func saveThenLoadRoundtrips() throws {
        let url = uniqueURL()
        defer { try? KeychainStore.delete(for: url) }
        try KeychainStore.save(token: "tkn-1", for: url)
        let loaded = try KeychainStore.load(for: url)
        #expect(loaded == "tkn-1")
    }

    @Test func loadNonexistentReturnsNil() throws {
        let url = uniqueURL()
        let loaded = try KeychainStore.load(for: url)
        #expect(loaded == nil)
    }

    @Test func saveTwiceUpdates() throws {
        let url = uniqueURL()
        defer { try? KeychainStore.delete(for: url) }
        try KeychainStore.save(token: "first", for: url)
        try KeychainStore.save(token: "second", for: url)
        let loaded = try KeychainStore.load(for: url)
        #expect(loaded == "second")
    }

    @Test func deleteThenLoadReturnsNil() throws {
        let url = uniqueURL()
        try KeychainStore.save(token: "ghost", for: url)
        try KeychainStore.delete(for: url)
        let loaded = try KeychainStore.load(for: url)
        #expect(loaded == nil)
    }
}
