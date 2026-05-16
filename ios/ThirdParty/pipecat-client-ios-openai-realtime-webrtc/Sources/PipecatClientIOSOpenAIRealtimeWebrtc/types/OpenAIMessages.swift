// MARK: - Inbound

import Foundation
import PipecatClientIOS

// enums just for namespacing
enum OpenAIMessages {
    
    // MARK: - Outbound
    
    enum Outbound {
        
        struct SessionUpdate: Encodable {
            let type = "session.update"
            var session: Value
            
            init(session: Value) {
                self.session = session
            }
        }
        
        struct CreateResponse: Encodable {
            let type = "response.create"
        }

        /// Cancel the in-progress response. Used by Safety Check hard-quiet to abort an
        /// unsanctioned model turn (greeting/narration) the moment it starts.
        struct ResponseCancel: Encodable {
            let type = "response.cancel"
        }

        /// A `response.create` carrying an explicit `response` body (output_modalities,
        /// tool_choice, instructions, …). Used by Stay Silent to force a single recap
        /// turn on release. When `response` is nil this encodes the same as the bare
        /// `CreateResponse` above.
        struct CreateResponseWithBody: Encodable {
            let type = "response.create"
            var response: Value?

            init(response: Value?) {
                self.response = response
            }
        }

        struct Conversation: Encodable {
            let type = "conversation.item.create"
            var item: ItemProtocol

            enum CodingKeys: String, CodingKey {
                case type, item
            }

            // Custom encoding to handle dynamic types
            func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(type, forKey: .type)
                try container.encode(item, forKey: .item) // Dynamically encode the item
            }

            init(item: ItemProtocol) {
                self.item = item
            }
        }

        protocol ItemProtocol: Encodable {}

        struct MessageContent: ItemProtocol {
            let type = "message"
            var content: [Content]
            var role: String

            struct Content: Encodable {
                let type: String
                var text: String?
                var image_url: String?

                init(text: String, type: String) {
                    self.text = text
                    self.type = type
                }

                init(imageURL: String) {
                    self.type = "input_image"
                    self.image_url = imageURL
                }
            }

            init(text: String, role: String) {
                let type = (role == "assistant") ? "output_text" : "input_text"
                self.content = [Content(text: text, type: type)]
                self.role = role
            }

            init(contents: [Content], role: String) {
                self.content = contents
                self.role = role
            }
        }

        struct FunctionCallOutputContent: ItemProtocol {
            let type = "function_call_output"
            var call_id: String
            var output: String

            init(call_id: String, output: String) {
                self.call_id = call_id
                self.output = output
            }
        }
    }
}
