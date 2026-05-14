import Foundation
import PipecatClientIOS

public struct OpenAIFunctionTool: Encodable {
    let type = "function"
    var name: String
    var description: String
    var parameters: Value?
    
    public init(name: String, description: String, parameters: Value? = nil) {
        self.name = name
        self.description = description
        self.parameters = parameters
    }
}
