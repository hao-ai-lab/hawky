import Foundation

// =============================================================================
// LivePerson — a person record returned by the DeepFace service (#627).
//
// DeepFace owns the database + matching; iOS just renders/relays these. Parsed
// from the gateway tool's result.metadata.person JSON ({id,name,facts,recaps,…}).
// =============================================================================

enum FaceIdentifyResult: Equatable {
    case noMatch
    case person(LivePerson)
    case suppressed(candidateID: String?, reason: String?)
}

struct LivePerson: Equatable, Identifiable {
    let id: String
    /// Identity candidate id (cand_face_...) when this record represents a
    /// provisional Unknown candidate. `id` stays the legacy person/profile id so
    /// existing UI and add-crop flows keep working.
    var candidateID: String?
    var name: String
    var facts: [String]
    /// Most recent conversation recap, if any (newest summary from `recaps`).
    var lastRecap: String?
    /// Base64 JPEG thumbnail (face crop) for the Profile Database UI, when provided
    /// by the /people listing. nil for identify/enroll responses (no thumbnail there).
    var thumbnailBase64: String?

    init(id: String, name: String, facts: [String] = [], lastRecap: String? = nil, thumbnailBase64: String? = nil, candidateID: String? = nil) {
        self.id = id
        self.candidateID = candidateID
        self.name = name
        self.facts = facts
        self.lastRecap = lastRecap
        self.thumbnailBase64 = thumbnailBase64
    }

    /// Parse an identity candidate returned for a matched provisional Unknown face.
    /// This is intentionally not a named person; CocktailPartyController suppresses
    /// Unknown recall while the recognizer uses the non-nil result to avoid
    /// repeatedly enrolling the same candidate.
    init?(candidate: JSONValue?) {
        guard case let .object(obj)? = candidate,
              case let .string(id)? = obj["id"]
        else { return nil }
        self.candidateID = id
        self.id = Self.legacyProfileID(from: obj) ?? id
        if case let .string(label)? = obj["label"], !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.name = label
        } else {
            self.name = "Unknown"
        }
        self.facts = []
        self.lastRecap = nil
        self.thumbnailBase64 = nil
    }

    /// Parse from a JSONValue person object (from the gateway tool metadata).
    init?(metadata: JSONValue?) {
        guard case let .object(obj)? = metadata,
              case let .string(id)? = obj["id"]
        else { return nil }
        self.id = id
        self.candidateID = nil
        if case let .string(name)? = obj["name"] { self.name = name } else { self.name = "Unknown" }
        if case let .array(factsArr)? = obj["facts"] {
            self.facts = factsArr.compactMap { if case let .string(s) = $0 { return s } else { return nil } }
        } else {
            self.facts = []
        }
        // recaps: [{ summary, at }] — take the last summary.
        if case let .array(recaps)? = obj["recaps"], let last = recaps.last,
           case let .object(recapObj) = last, case let .string(summary)? = recapObj["summary"] {
            self.lastRecap = summary
        } else {
            self.lastRecap = nil
        }
        if case let .string(thumb)? = obj["thumbnail"] { self.thumbnailBase64 = thumb } else { self.thumbnailBase64 = nil }
    }

    private static func legacyProfileID(from candidate: [String: JSONValue]) -> String? {
        if case let .object(metadata)? = candidate["metadata"],
           let id = nonEmptyString(metadata["deepfaceProfileId"]) {
            return id
        }
        if case let .array(refs)? = candidate["legacyRefs"] {
            for ref in refs {
                guard case let .object(obj) = ref,
                      case let .string(system)? = obj["system"],
                      system == "deepface",
                      let id = nonEmptyString(obj["profileId"])
                else { continue }
                return id
            }
        }
        return nil
    }

    private static func nonEmptyString(_ value: JSONValue?) -> String? {
        guard case let .string(text)? = value else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
