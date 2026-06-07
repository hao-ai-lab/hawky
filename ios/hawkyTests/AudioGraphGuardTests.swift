import XCTest
@testable import hawky

// =============================================================================
// AudioGraphGuard (#673): AVAudioEngine graph mutations can raise an Objective-C
// NSException (contended voice-processing mic, format mismatch) that a Swift
// do/catch cannot catch — which aborts the whole process (SIGABRT). The guard
// must convert that exception into a thrown Swift error so callers fall back
// instead of crashing. These tests pin that contract; a regression that drops
// the Obj-C @try/@catch would make `testConvertsObjCExceptionToSwiftError` abort
// the test runner rather than fail softly — which is itself the alarm.
//
// Written as XCTest (not Swift Testing) so it runs under the xcodebuild/CI path
// the rest of the UI suite uses.
// =============================================================================
final class AudioGraphGuardTests: XCTestCase {
    func testConvertsObjCExceptionToSwiftError() {
        XCTAssertThrowsError(
            try AudioGraphGuard.run {
                NSException(name: .genericException, reason: "boom", userInfo: nil).raise()
            }
        ) { error in
            XCTAssertTrue(
                error is AudioGraphGuard.ExceptionError,
                "Obj-C NSException should surface as AudioGraphGuard.ExceptionError, got \(error)"
            )
        }
    }

    func testRethrowsSwiftErrorFromBlock() {
        struct Boom: Error {}
        XCTAssertThrowsError(try AudioGraphGuard.run { throw Boom() }) { error in
            XCTAssertTrue(error is Boom)
        }
    }

    func testRunsCleanBlockWithoutThrowing() {
        XCTAssertNoThrow(try AudioGraphGuard.run { _ = 1 + 1 })
    }
}
