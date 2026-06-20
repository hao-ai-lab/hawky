import Foundation
import XCTest

struct DeepLinkScreenCase {
    let id: String
    let url: String
    let expectedIdentifier: String
    var maxSwipes: Int = 0

    var spec: TestSpec {
        TestSpec(
            id: "deeplink.screen.\(id)",
            title: "Deep link reaches \(id)",
            purpose: "Verify \(url) reaches \(expectedIdentifier) without brittle tab or row tapping.",
            screens: [id],
            steps: [
                .init(action: "Open \(url)", expect: "\(expectedIdentifier) appears")
            ]
        )
    }
}

struct ScreenManifest: Decodable {
    struct Screen: Decodable {
        let id: String
        let title: String
        let catalog: String?
        let url: String?
        let expectedIdentifier: String
        let maxSwipes: Int?
    }

    private final class BundleToken {}

    let version: Int
    let screens: [Screen]

    static let shared = load()

    var screenIDs: Set<String> {
        Set(screens.map(\.id))
    }

    var primaryDeepLinkScreenCases: [DeepLinkScreenCase] {
        deepLinkScreenCases(catalog: "primary")
    }

    var secondaryDeepLinkScreenCases: [DeepLinkScreenCase] {
        deepLinkScreenCases(catalog: "secondary")
    }

    var allDeepLinkScreenCases: [DeepLinkScreenCase] {
        primaryDeepLinkScreenCases + secondaryDeepLinkScreenCases
    }

    func validateManifest(file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(version, 1, "Unexpected screen manifest version", file: file, line: line)
        XCTAssertFalse(screens.isEmpty, "Screen manifest must not be empty", file: file, line: line)

        let duplicateIDs = duplicates(in: screens.map(\.id))
        XCTAssertTrue(
            duplicateIDs.isEmpty,
            "Duplicate screen manifest ids: \(duplicateIDs.sorted().joined(separator: ", "))",
            file: file,
            line: line
        )

        for screen in screens {
            XCTAssertFalse(screen.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "Screen id is empty", file: file, line: line)
            XCTAssertFalse(screen.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "Screen \(screen.id) has empty title", file: file, line: line)
            XCTAssertFalse(
                screen.expectedIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                "Screen \(screen.id) has empty expectedIdentifier",
                file: file,
                line: line
            )
            if screen.catalog != nil {
                XCTAssertFalse(
                    (screen.url ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                    "Catalog screen \(screen.id) must define a deep-link url",
                    file: file,
                    line: line
                )
            }
        }
    }

    func validate(spec: TestSpec, file: StaticString = #filePath, line: UInt = #line) {
        let unknownScreens = spec.screens.filter { !screenIDs.contains($0) }
        XCTAssertTrue(
            unknownScreens.isEmpty,
            "TestSpec \(spec.id) references unknown screen ids: \(unknownScreens.joined(separator: ", ")). Add them to ScreenManifest.json or fix spec.screens.",
            file: file,
            line: line
        )
    }

    func assertAllScreensCovered(by specs: [TestSpec], file: StaticString = #filePath, line: UInt = #line) {
        let coveredIDs = Set(specs.flatMap(\.screens))
        let missingIDs = screenIDs.subtracting(coveredIDs)
        XCTAssertTrue(
            missingIDs.isEmpty,
            "ScreenManifest screens without TestSpec coverage: \(missingIDs.sorted().joined(separator: ", "))",
            file: file,
            line: line
        )
    }

    private func deepLinkScreenCases(catalog: String) -> [DeepLinkScreenCase] {
        screens
            .filter { $0.catalog == catalog }
            .map { screen in
                DeepLinkScreenCase(
                    id: screen.id,
                    url: screen.url ?? "",
                    expectedIdentifier: screen.expectedIdentifier,
                    maxSwipes: screen.maxSwipes ?? 0
                )
            }
    }

    private static func load() -> ScreenManifest {
        let bundle = Bundle(for: BundleToken.self)
        guard let url = bundle.url(forResource: "ScreenManifest", withExtension: "json") else {
            fatalError("Missing ScreenManifest.json in hawkyUITests bundle")
        }

        do {
            let data = try Data(contentsOf: url)
            return try JSONDecoder().decode(ScreenManifest.self, from: data)
        } catch {
            fatalError("Failed to load ScreenManifest.json: \(error)")
        }
    }

    private func duplicates(in values: [String]) -> Set<String> {
        var seen = Set<String>()
        var duplicates = Set<String>()
        for value in values {
            if !seen.insert(value).inserted {
                duplicates.insert(value)
            }
        }
        return duplicates
    }
}
