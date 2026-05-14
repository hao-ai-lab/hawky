import Foundation
import PipecatClientIOS

extension [ServiceConfig] {
    var apiKey: String? {
        let apiKeyOption = llmConfig?.options.first { $0.name == "api_key" }
        if case let .string(apiKey) = apiKeyOption?.value {
            return apiKey
        }
        return nil
    }
    
    var model: String? {
        let modelOption = llmConfig?.options.first { $0.name == "model" }
        if case let .string(model) = modelOption?.value {
            return model
        }
        return nil
    }
    
    var initialMessages: [OpenAIMessages.Outbound.Conversation] {
        let initialMessagesKeyOption = llmConfig?.options.first { $0.name == "initial_messages" }
        return initialMessagesKeyOption?.value.toConversationArray() ?? []
    }
    
    var sessionConfig: Value? {
        llmConfig?.options.first { $0.name == "session_config" }?.value
    }
    
    var llmConfig: ServiceConfig? {
        first { $0.service == "llm" }
    }
}

extension Value {
    // convenient method to make it easy to extract the messages
    func toConversationArray() -> [OpenAIMessages.Outbound.Conversation] {
        var messages: [OpenAIMessages.Outbound.Conversation] = []
        if case let .array(messageValues) = self {
            for messageValue in messageValues {
                if case let .object(messageObject)? = messageValue {
                    let roleValue = messageObject["role"]
                    let contentValue = messageObject["content"]
                    if case let .string(role)? = roleValue {
                        let content = conversationContent(from: contentValue ?? nil, role: role)
                        if !content.isEmpty {
                            messages.append(.init(item: OpenAIMessages.Outbound.MessageContent(contents: content, role: role)))
                        } else if case let .string(text)? = contentValue {
                            messages.append(.init(item: OpenAIMessages.Outbound.MessageContent(text: text, role: role)))
                        }
                    }
                }
            }
        }
        return messages
    }

    private func conversationContent(from value: Value?, role: String) -> [OpenAIMessages.Outbound.MessageContent.Content] {
        switch value {
        case .string(let text):
            let type = (role == "assistant") ? "output_text" : "input_text"
            return [OpenAIMessages.Outbound.MessageContent.Content(text: text, type: type)]
        case .array(let blocks):
            return blocks.compactMap { blockValue in
                guard case let .object(block)? = blockValue,
                      case let .string(type)? = block["type"] else {
                    return nil
                }
                switch type {
                case "input_image":
                    if case let .string(imageURL)? = block["image_url"] {
                        return OpenAIMessages.Outbound.MessageContent.Content(imageURL: imageURL)
                    }
                case "input_text", "output_text", "text":
                    let normalizedType = type == "text"
                        ? ((role == "assistant") ? "output_text" : "input_text")
                        : type
                    if case let .string(text)? = block["text"] {
                        return OpenAIMessages.Outbound.MessageContent.Content(text: text, type: normalizedType)
                    }
                    if case let .string(text)? = block["content"] {
                        return OpenAIMessages.Outbound.MessageContent.Content(text: text, type: normalizedType)
                    }
                default:
                    return nil
                }
                return nil
            }
        default:
            return []
        }
    }
    
    var asObject: [String: Value] {
        if case .object(let dict) = self {
            return dict
        }
        return [:]
    }
    
    var asString: String {
        if case .object = self {
            do {
                let jsonData = try JSONEncoder().encode(self)
                return String(data: jsonData, encoding: .utf8)!
            } catch {}
        } else if case .string(let stringValue) = self {
            return stringValue
        }
        return ""
    }

    var asBool: Bool? {
        if case .boolean(let boolValue) = self {
            return boolValue
        }
        return nil
    }
}
