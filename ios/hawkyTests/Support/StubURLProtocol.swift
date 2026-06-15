import Foundation

final class StubURLProtocol: URLProtocol {
    struct Stub {
        let statusCode: Int
        let body: Data
        let headers: [String: String]
    }

    // Keyed by absolute URL string. Tests set before issuing requests; reset via `reset()`.
    // Access serialized through `lock` since Swift Testing runs tests in parallel.
    private static var _stubs: [String: Stub] = [:]
    private static let lock = NSLock()

    static func reset() { lock.lock(); _stubs = [:]; lock.unlock() }

    static func set(url: URL, statusCode: Int, body: Data, headers: [String: String] = ["Content-Type": "application/json"]) {
        lock.lock()
        _stubs[url.absoluteString] = Stub(statusCode: statusCode, body: body, headers: headers)
        lock.unlock()
    }

    static func lookup(_ url: URL) -> Stub? {
        lock.lock(); defer { lock.unlock() }
        return _stubs[url.absoluteString]
    }

    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let stub = StubURLProtocol.lookup(url) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let resp = HTTPURLResponse(url: url, statusCode: stub.statusCode, httpVersion: "HTTP/1.1", headerFields: stub.headers)!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
