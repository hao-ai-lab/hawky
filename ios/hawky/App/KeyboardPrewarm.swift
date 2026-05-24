import UIKit

// Warms the iOS keyboard subsystem on app launch so the user's first tap on the
// chat composer doesn't pay the one-time ~200-800ms cost UIKit spends lazily
// initializing UITextInputMode / remote keyboard processes on first focus.
//
// This is a one-shot: ContentView gates the call with `didPrewarmKeyboard` so it
// runs exactly once per process. The hidden text field is added off-screen,
// briefly made first responder, then removed — the user never sees it and their
// own focus state is unaffected because nothing else is first responder yet.
//
// NOTE: Does not silence unrelated iOS-private warnings ("sandbox extension",
// "containerToPush is nil", "Reporter disconnected", "System gesture gate timed
// out") — those originate inside UIKit/RemoteTextInput and are not suppressible
// from app code.
@MainActor
enum KeyboardPrewarm {
    static func run() {
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })?
            .windows.first(where: { $0.isKeyWindow }) ?? UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first?.windows.first
        else { return }

        let tf = UITextField(frame: CGRect(x: -100, y: -100, width: 1, height: 1))
        tf.autocorrectionType = .no
        tf.spellCheckingType = .no
        tf.inputAssistantItem.leadingBarButtonGroups = []
        tf.inputAssistantItem.trailingBarButtonGroups = []
        window.addSubview(tf)
        tf.becomeFirstResponder()
        tf.resignFirstResponder()
        tf.removeFromSuperview()
    }
}
