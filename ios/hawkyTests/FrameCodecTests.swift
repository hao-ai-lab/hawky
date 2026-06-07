import Testing
import Foundation
@testable import hawky

@Suite struct FrameCodecTests {

    private func encodeToDict<T: Encodable>(_ v: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(v)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func encodesConnectRequest() throws {
        let params: [String: JSONValue] = [
            "version": .string("hawky/0.1"),
            "platform": .string("mobile"),
            "token": .string("jwt.token.here"),
            "sessionKey": .string("ios:main"),
            "role": .string("client")
        ]
        let req = RequestFrame(id: "req-1", method: "connect", params: params)
        let dict = try encodeToDict(req)
        #expect(dict["type"] as? String == "req")
        #expect(dict["id"] as? String == "req-1")
        #expect(dict["method"] as? String == "connect")
        let got = try #require(dict["params"] as? [String: Any])
        #expect(got["token"] as? String == "jwt.token.here")
        #expect(got["sessionKey"] as? String == "ios:main")
        #expect(got["role"] as? String == "client")
    }

    @Test func encodesChatSendRequest() throws {
        let params: [String: JSONValue] = [
            "message": .string("hello"),
            "sessionKey": .string("ios:main")
        ]
        let req = RequestFrame(id: "req-2", method: "chat.send", params: params)
        let dict = try encodeToDict(req)
        #expect(dict["method"] as? String == "chat.send")
        let got = try #require(dict["params"] as? [String: Any])
        #expect(got["message"] as? String == "hello")
    }

    @Test func connectParamsOmitsNilRole() throws {
        let p = ConnectParams(version: "hawky/0.1", platform: "mobile", token: "t", sessionKey: "k")
        let data = try JSONEncoder().encode(p)
        let dict = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(dict["role"] == nil)
        #expect(dict["token"] as? String == "t")
    }

    @Test func decodesResponseFrameHappy() throws {
        let json = #"{"type":"res","id":"x","ok":true,"payload":{"foo":"bar","n":42}}"#
        let data = Data(json.utf8)
        let res = try JSONDecoder().decode(ResponseFrame.self, from: data)
        #expect(res.ok)
        #expect(res.id == "x")
        #expect(res.error == nil)
        guard case .object(let o) = res.payload else { Issue.record("payload not object"); return }
        #expect(o["foo"] == .string("bar"))
    }

    @Test func decodesResponseFrameUnauthorized() throws {
        let json = #"{"type":"res","id":"x","ok":false,"error":{"code":"UNAUTHORIZED","message":"Invalid or missing device token"}}"#
        let res = try JSONDecoder().decode(ResponseFrame.self, from: Data(json.utf8))
        #expect(!res.ok)
        let err = try #require(res.error)
        #expect(err.code == "UNAUTHORIZED")
        #expect(GatewayErrorCode(rawValue: err.code) == .unauthorized)
    }

    @Test func decodesUnknownErrorCodeFallback() {
        let code = GatewayErrorCode(rawValue: "SOMETHING_NEW")
        #expect(code == .unknown("SOMETHING_NEW"))
        #expect(code.rawValue == "SOMETHING_NEW")
    }

    @Test func decodesEventFrameAgentText() throws {
        let json = #"{"type":"event","event":"agent.text","seq":7,"payload":{"delta":"hel"}}"#
        let ev = try JSONDecoder().decode(EventFrame.self, from: Data(json.utf8))
        #expect(ev.event == "agent.text")
        #expect(ev.seq == 7)
        guard case .object(let o) = ev.payload else { Issue.record("no payload"); return }
        #expect(o["delta"] == .string("hel"))
    }

    @Test func incomingFrameRoutesResponseAndEvent() throws {
        let resData = Data(#"{"type":"res","id":"a","ok":true}"#.utf8)
        let evData = Data(#"{"type":"event","event":"agent.done","payload":{}}"#.utf8)
        let r = try JSONDecoder().decode(IncomingFrame.self, from: resData)
        let e = try JSONDecoder().decode(IncomingFrame.self, from: evData)
        guard case .response = r else { Issue.record("not response"); return }
        guard case .event = e else { Issue.record("not event"); return }
    }

    @Test func incomingFrameUnknownTypeDoesNotThrow() throws {
        let json = #"{"type":"mystery","foo":"bar"}"#
        let frame = try JSONDecoder().decode(IncomingFrame.self, from: Data(json.utf8))
        guard case .unknown(let raw) = frame else {
            Issue.record("expected .unknown, got \(frame)")
            return
        }
        #expect(raw.contains("\"mystery\""))
        #expect(raw.contains("\"bar\""))
    }

    @Test func malformedJSONThrows() {
        let bad = Data("{not json".utf8)
        #expect(throws: (any Error).self) {
            _ = try JSONDecoder().decode(IncomingFrame.self, from: bad)
        }
    }

    @Test func decodesHelloResponseFixture() throws {
        let bundle = Bundle(for: BundleMarker.self)
        let url = try #require(
            bundle.url(forResource: "hello-response", withExtension: "json", subdirectory: "Fixtures")
                ?? bundle.url(forResource: "hello-response", withExtension: "json")
        )
        let data = try Data(contentsOf: url)
        let res = try JSONDecoder().decode(ResponseFrame.self, from: data)
        #expect(res.ok)
        let payloadData = try JSONEncoder().encode(res.payload)
        let hello = try JSONDecoder().decode(HelloPayload.self, from: payloadData)
        #expect(hello.connId == "conn-abc-123")
        #expect(hello.serverVersion == "hawky/0.9.0")
        #expect(hello.methods.contains("chat.send"))
    }
}

private final class BundleMarker {}
