import Foundation
import PipecatClientIOS

extension LLMFunctionCallData {
    var asString: String {
        do {
            let jsonData = try JSONEncoder().encode(self)
            return String(data: jsonData, encoding: .utf8)!
        } catch {
            return ""
        }
    }
}
