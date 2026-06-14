import Testing
import Foundation
@testable import hawky

@Suite @MainActor
struct SessionFilterTests {
    private func sample() -> [SessionStore.SessionSummary] {
        [
            .init(key: "ios:main", displayName: "Main", unreadCount: 0),
            .init(key: "ios:work-42", displayName: "Work 42", unreadCount: 0),
            .init(key: "ios:notes", displayName: "Scratch Notes", unreadCount: 0),
            .init(key: "other:misc", displayName: "Misc", unreadCount: 0),
        ]
    }

    @Test func plainSubstringMatchesNameOrKey_positive() {
        let out = SessionListView.filter(sample(), query: "notes", useRegex: false)
        #expect(out.count == 1)
        #expect(out.first?.key == "ios:notes")
    }

    @Test func plainSubstringMatchesNameOrKey_negative() {
        let out = SessionListView.filter(sample(), query: "nomatch", useRegex: false)
        #expect(out.isEmpty)
    }

    @Test func plainSubstringIsCaseInsensitive() {
        let out = SessionListView.filter(sample(), query: "WORK", useRegex: false)
        #expect(out.count == 1)
        #expect(out.first?.key == "ios:work-42")
    }

    @Test func regexAnchorStart() {
        let out = SessionListView.filter(sample(), query: "^ios:", useRegex: true)
        #expect(out.count == 3)
        #expect(out.allSatisfy { $0.key.hasPrefix("ios:") })
    }

    @Test func regexDigitsAtEnd() {
        let out = SessionListView.filter(sample(), query: "\\d+$", useRegex: true)
        #expect(out.count == 1)
        #expect(out.first?.key == "ios:work-42")
    }

    @Test func invalidRegexReturnsAllAndFlagsInvalid() {
        let bad = "["
        let out = SessionListView.filter(sample(), query: bad, useRegex: true)
        #expect(out.count == sample().count)
        #expect(SessionListView.isValidRegex(bad) == false)
        #expect(SessionListView.isValidRegex("^ok$") == true)
    }

    @Test func emptyQueryReturnsAll() {
        let out = SessionListView.filter(sample(), query: "", useRegex: false)
        #expect(out.count == sample().count)
    }
}
