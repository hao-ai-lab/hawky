import Testing
import Foundation
import CoreLocation
@testable import hawky

/// Tests for #481: significant-location reprojection of the CoreLocation
/// ≤20-region budget. These exercise the pure selection logic
/// (`AmbientLocationManager.selectNearest`) without a live CLLocationManager.
///
/// Scenario framing: a user has many `where` reminders (e.g. "remind me to buy
/// milk when I get to Trader Joe's"). CoreLocation only monitors ~20 regions at
/// once, so the budget must track the NEAREST reminders as the user moves —
/// otherwise a reminder for a far-away store would arm and a nearby one wouldn't.
@Suite struct AmbientRegionProjectionTests {

    private func region(_ id: String, _ lat: Double, _ lon: Double, isHard: Bool = true) -> AmbientRegion {
        AmbientRegion(
            id: id,
            center: CLLocationCoordinate2D(latitude: lat, longitude: lon),
            radiusMeters: 150,
            isHard: isHard,
            label: id,
            content: "Buy milk"
        )
    }

    private func ids(_ regions: [AmbientRegion]) -> Set<String> {
        Set(regions.map { $0.id })
    }

    // MARK: - Below / at the cap

    @Test func keepsAllWhenWithinCap() {
        let regions = [region("a", 37.0, -122.0), region("b", 40.0, -74.0)]
        let selected = AmbientLocationManager.selectNearest(
            from: regions,
            around: CLLocationCoordinate2D(latitude: 0, longitude: 0),
            limit: 20
        )
        #expect(ids(selected) == ["a", "b"])
    }

    @Test func keepsAllExactlyAtCap() {
        let regions = (0..<20).map { region("r\($0)", Double($0), 0) }
        let selected = AmbientLocationManager.selectNearest(from: regions, around: nil, limit: 20)
        #expect(selected.count == 20)
    }

    // MARK: - Over the cap: nearest wins

    @Test func selectsNearestWhenOverCap() {
        // 22 reminders strung out along a line; user sits at lat 0.
        // The two farthest (lat 20, 21) must be dropped.
        let regions = (0..<22).map { region("r\($0)", Double($0), 0) }
        let selected = AmbientLocationManager.selectNearest(
            from: regions,
            around: CLLocationCoordinate2D(latitude: 0, longitude: 0),
            limit: 20
        )
        #expect(selected.count == 20)
        #expect(!ids(selected).contains("r20"))
        #expect(!ids(selected).contains("r21"))
        #expect(ids(selected).contains("r0"))
    }

    /// The core #481 guarantee: a reminder dropped by the cap COMES BACK once the
    /// user moves toward it. This is the bug the issue describes — a stale budget
    /// that never reprojects. "Trader Joe's" is r21 here: far away at first, then
    /// the nearest reminder after the user travels to it.
    @Test func droppedRegionReturnsAfterMovingToward() {
        let traderJoes = region("trader-joes", 21.0, 0)
        let others = (0..<21).map { region("r\($0)", Double($0), 0) }
        let all = others + [traderJoes]

        // Start at lat 0 — Trader Joe's (lat 21) is the farthest, gets dropped.
        let atHome = AmbientLocationManager.selectNearest(
            from: all,
            around: CLLocationCoordinate2D(latitude: 0, longitude: 0),
            limit: 20
        )
        #expect(!ids(atHome).contains("trader-joes"))

        // User drives across town to lat 20.5 — now Trader Joe's is among the
        // nearest and must be monitored; the far-away r0/r1 drop out instead.
        let nearStore = AmbientLocationManager.selectNearest(
            from: all,
            around: CLLocationCoordinate2D(latitude: 20.5, longitude: 0),
            limit: 20
        )
        #expect(ids(nearStore).contains("trader-joes"))
        #expect(!ids(nearStore).contains("r0"))
    }

    // MARK: - No location fix yet

    @Test func deterministicPrefixWithoutOrigin() {
        let regions = (0..<25).map { region(String(format: "r%02d", $0), Double($0), 0) }
        let a = AmbientLocationManager.selectNearest(from: regions, around: nil, limit: 20)
        let b = AmbientLocationManager.selectNearest(from: regions, around: nil, limit: 20)
        #expect(a.count == 20)
        // Stable across calls (id-sorted), so arming doesn't churn before a fix.
        #expect(a.map { $0.id } == b.map { $0.id })
        #expect(ids(a).contains("r00"))
        #expect(!ids(a).contains("r24"))
    }

    // MARK: - Determinism on distance ties

    @Test func tieBreaksDeterministicallyById() {
        // Two reminders equidistant from the user (mirror image across lat 0),
        // plus 19 closer ones — exactly one of the tied pair must be dropped, and
        // the choice must be stable (id tie-break), not random.
        var regions = (1...19).map { region("near\($0)", 0.001 * Double($0), 0) }
        regions.append(region("tieB", 5.0, 0))
        regions.append(region("tieA", -5.0, 0))

        let first = AmbientLocationManager.selectNearest(
            from: regions,
            around: CLLocationCoordinate2D(latitude: 0, longitude: 0),
            limit: 20
        )
        let second = AmbientLocationManager.selectNearest(
            from: regions.reversed(),
            around: CLLocationCoordinate2D(latitude: 0, longitude: 0),
            limit: 20
        )
        // Same input set in different order → same selection.
        #expect(ids(first) == ids(second))
        #expect(first.count == 20)
        // tieA sorts before tieB, so when one of the equidistant pair must go,
        // tieA is kept and tieB dropped — deterministically.
        #expect(ids(first).contains("tieA"))
        #expect(!ids(first).contains("tieB"))
    }
}
