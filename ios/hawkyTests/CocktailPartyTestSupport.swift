import Foundation
@testable import hawky

// =============================================================================
// Test support for Cocktail Party Mode (#627, server-matching architecture).
//
// DeepFace owns matching, so iOS tests fake two seams:
//   - FakeFaceCropper: returns canned FaceCrops for a frame (no Vision needed).
//   - FakeRecognitionClient: an in-memory "DeepFace": identify() matches by an
//     identity tag carried in the crop bytes; enroll() mints a new identity.
// Together they drive the full crop→identify→(recall|enroll) flow deterministically.
// =============================================================================

/// A crop whose bytes encode an identity tag the fake client reads ("id:<tag>").
enum FakeCropFactory {
    static func crop(identity: String) -> FaceCrop {
        FaceCrop(jpeg: Data("id:\(identity)".utf8), boundingBox: CGRect(x: 0.3, y: 0.3, width: 0.4, height: 0.4), confidence: 0.95)
    }
    static func identity(ofCrop base64: String) -> String? {
        guard let data = Data(base64Encoded: base64), let s = String(data: data, encoding: .utf8),
              s.hasPrefix("id:") else { return nil }
        return String(s.dropFirst(3))
    }
}

final class FakeFaceCropper: FaceCropper, @unchecked Sendable {
    private let cropsFor: @Sendable (Data) -> [FaceCrop]
    init(cropsFor: @escaping @Sendable (Data) -> [FaceCrop]) { self.cropsFor = cropsFor }
    func cropFaces(in jpeg: Data) async -> [FaceCrop] { cropsFor(jpeg) }
    /// Best crop = the original frame bytes when a face is present (so tests' identity
    /// tag in the frame still reaches the fake client), nil when no face.
    func bestFaceCrop(in jpeg: Data) async -> Data? {
        cropsFor(jpeg).isEmpty ? nil : jpeg
    }
}

/// In-memory stand-in for DeepFace: identity tag → person. identify() returns the
/// enrolled person for that tag (or nil); enroll() creates one. Records calls so
/// tests can assert enroll/update behavior.
final class FakeRecognitionClient: FaceRecognitionClient, @unchecked Sendable {
    struct Stored { var person: LivePerson }
    private let lock = NSLock()
    private var byTag: [String: LivePerson] = [:]
    private(set) var enrollCount = 0

    /// Pre-seed a known identity (as if previously enrolled).
    func seed(tag: String, person: LivePerson) {
        lock.lock(); byTag[tag] = person; lock.unlock()
    }
    func person(tag: String) -> LivePerson? { lock.lock(); defer { lock.unlock() }; return byTag[tag] }

    func identify(cropBase64: String) async -> LivePerson? {
        guard let tag = FakeCropFactory.identity(ofCrop: cropBase64) else { return nil }
        lock.lock(); defer { lock.unlock() }
        return byTag[tag]
    }

    func enroll(cropBase64: String, name: String) async -> LivePerson? {
        guard let tag = FakeCropFactory.identity(ofCrop: cropBase64) else { return nil }
        lock.lock(); defer { lock.unlock() }
        enrollCount += 1
        let p = LivePerson(id: "person-\(tag)", name: name)
        byTag[tag] = p
        return p
    }
}
