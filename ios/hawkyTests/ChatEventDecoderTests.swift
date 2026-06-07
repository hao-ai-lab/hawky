import Testing
import Foundation
@testable import hawky

@Suite struct ChatEventDecoderTests {

    private func frame(event: String, payloadJSON: String) throws -> EventFrame {
        let json = """
        { "type": "event", "event": "\(event)", "payload": \(payloadJSON) }
        """
        return try JSONDecoder().decode(EventFrame.self, from: Data(json.utf8))
    }

    @Test func decodesAgentTextDelta() throws {
        let f = try frame(event: "agent.text",
                          payloadJSON: #"{"type":"text","content":"Hel"}"#)
        #expect(EventFrameDecoder.decode(f) == .text(content: "Hel", replace: false))
    }

    @Test func decodesAgentTextReplacement() throws {
        let f = try frame(event: "agent.text",
                          payloadJSON: #"{"type":"text","content":"Final answer","replace":true}"#)
        #expect(EventFrameDecoder.decode(f) == .text(content: "Final answer", replace: true))
    }

    @Test func decodesAgentDone() throws {
        let f = try frame(event: "agent.done",
                          payloadJSON: #"{"type":"done","usage":{"input_tokens":1,"output_tokens":2}}"#)
        #expect(EventFrameDecoder.decode(f) == .done)
    }

    @Test func decodesAgentError() throws {
        let f = try frame(event: "agent.error",
                          payloadJSON: #"{"type":"error","content":"boom","code":"api_error"}"#)
        #expect(EventFrameDecoder.decode(f) == .error(code: "api_error", message: "boom"))
    }

    @Test func decodesAgentErrorWithoutCode() throws {
        let f = try frame(event: "agent.error",
                          payloadJSON: #"{"type":"error","content":"oops"}"#)
        #expect(EventFrameDecoder.decode(f) == .error(code: "unknown", message: "oops"))
    }

    @Test func decodesSystemMessage() throws {
        let f = try frame(event: "agent.system_message",
                          payloadJSON: #"{"type":"system_message","content":"compacted","subtype":"info"}"#)
        #expect(EventFrameDecoder.decode(f) == .systemMessage("compacted"))
    }

    @Test func decodesToolUseStart() throws {
        let f = try frame(event: "agent.tool_use_start",
                          payloadJSON: #"{"type":"tool_use_start","tool_use_id":"tu1","name":"bash","input":{}}"#)
        #expect(EventFrameDecoder.decode(f) == .toolStart(name: "bash"))
    }

    @Test func decodesToolResultOk() throws {
        let f = try frame(event: "agent.tool_result",
                          payloadJSON: #"{"type":"tool_result","tool_use_id":"tu1","name":"bash","content":"out","is_error":false}"#)
        #expect(EventFrameDecoder.decode(f) == .toolResult(name: "bash", ok: true))
    }

    @Test func decodesPermissionRequestLossy() throws {
        let f = try frame(event: "agent.permission_request",
                          payloadJSON: #"{"type":"permission_request","id":"p1","tool_use_id":"tu1","tool_name":"bash","tool_input":{}}"#)
        if case .permissionRequest = EventFrameDecoder.decode(f) {
            // ok
        } else {
            Issue.record("expected .permissionRequest")
        }
    }

    @Test func unknownEventReturnsNil() throws {
        let f = try frame(event: "agent.mystery",
                          payloadJSON: #"{"type":"mystery"}"#)
        #expect(EventFrameDecoder.decode(f) == nil)
    }

    @Test func nonAgentEventReturnsNil() throws {
        let f = try frame(event: "presence.update",
                          payloadJSON: #"{"connected":true}"#)
        #expect(EventFrameDecoder.decode(f) == nil)
    }

    @Test func malformedTextReturnsNilNoCrash() throws {
        // content missing
        let f = try frame(event: "agent.text",
                          payloadJSON: #"{"type":"text"}"#)
        #expect(EventFrameDecoder.decode(f) == nil)
    }

    @Test func malformedSystemMessageReturnsNil() throws {
        let f = try frame(event: "agent.system_message",
                          payloadJSON: #"{"type":"system_message","subtype":"info"}"#)
        #expect(EventFrameDecoder.decode(f) == nil)
    }

    // -------------------------------------------------------------------------
    // Fix M6 #9: intention_surface with cautious field
    // -------------------------------------------------------------------------

    @Test func decodesSurfaceDeliverWithCautiousTrue() throws {
        let f = try frame(
            event: "agent.intention_surface",
            payloadJSON: #"{"type":"intention_surface","body":"buy coffee","speak":true,"whenBusy":"queue","cautious":true}"#
        )
        guard let event = EventFrameDecoder.decode(f) else {
            Issue.record("expected non-nil event for intention_surface")
            return
        }
        if case .intentionSurface(_, let text, let speak, let whenBusy, let cautious) = event {
            #expect(text == "buy coffee")
            #expect(speak == true)
            #expect(whenBusy == "queue")
            #expect(cautious == true)
        } else {
            Issue.record("expected .intentionSurface, got \(event)")
        }
    }

    @Test func decodesSurfaceDeliverWithCautiousFalse() throws {
        let f = try frame(
            event: "agent.intention_surface",
            payloadJSON: #"{"type":"intention_surface","body":"take out the trash","speak":false,"whenBusy":"cancel","cautious":false}"#
        )
        guard let event = EventFrameDecoder.decode(f) else {
            Issue.record("expected non-nil event for intention_surface")
            return
        }
        if case .intentionSurface(_, let text, let speak, _, let cautious) = event {
            #expect(text == "take out the trash")
            #expect(speak == false)
            #expect(cautious == false)
        } else {
            Issue.record("expected .intentionSurface")
        }
    }

    @Test func decodesSurfaceDeliverWithCautiousOmitted() throws {
        // cautious defaults to false when the field is absent
        let f = try frame(
            event: "agent.intention_surface",
            payloadJSON: #"{"type":"intention_surface","body":"pick up milk","speak":true,"whenBusy":"downgrade"}"#
        )
        guard let event = EventFrameDecoder.decode(f) else {
            Issue.record("expected non-nil event for intention_surface")
            return
        }
        if case .intentionSurface(_, _, _, _, let cautious) = event {
            #expect(cautious == false)
        } else {
            Issue.record("expected .intentionSurface")
        }
    }
}
