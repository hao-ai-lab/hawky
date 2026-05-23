import CoreText
import SwiftUI
import UIKit

struct ConversationScreenshotSnapshot {
    struct Row {
        var role: String
        var text: String
        var timestamp: Date?
    }

    var title: String
    var subtitle: String
    var rows: [Row]
    var generatedAt: Date = Date()
}

final class ConversationScreenshotService: NSObject, UIScreenshotServiceDelegate {
    static let shared = ConversationScreenshotService()

    typealias SnapshotProvider = @MainActor () async -> ConversationScreenshotSnapshot?

    @MainActor private var snapshotProvider: SnapshotProvider?
    @MainActor private weak var installedScene: UIWindowScene?

    @MainActor
    func install(on scene: UIWindowScene, provider: @escaping SnapshotProvider) {
        snapshotProvider = provider
        guard installedScene !== scene else { return }
        installedScene?.screenshotService?.delegate = nil
        installedScene = scene
        scene.screenshotService?.delegate = self
    }

    func screenshotService(
        _ screenshotService: UIScreenshotService,
        generatePDFRepresentationWithCompletion completionHandler: @escaping (Data?, Int, CGRect) -> Void
    ) {
        Task { @MainActor in
            guard let snapshot = await snapshotProvider?(),
                  !snapshot.rows.isEmpty else {
                completionHandler(nil, 0, .zero)
                return
            }
            let renderer = ConversationScreenshotPDFRenderer(snapshot: snapshot)
            let result = renderer.render()
            completionHandler(result.data, 0, result.currentPageRect)
        }
    }
}

struct ConversationScreenshotSceneInstaller: UIViewRepresentable {
    var provider: ConversationScreenshotService.SnapshotProvider

    func makeUIView(context: Context) -> ScreenshotInstallView {
        let view = ScreenshotInstallView()
        view.onWindowSceneChanged = { scene in
            guard let scene else { return }
            ConversationScreenshotService.shared.install(on: scene, provider: provider)
        }
        return view
    }

    func updateUIView(_ uiView: ScreenshotInstallView, context: Context) {
        uiView.onWindowSceneChanged = { scene in
            guard let scene else { return }
            ConversationScreenshotService.shared.install(on: scene, provider: provider)
        }
        if let scene = uiView.window?.windowScene {
            ConversationScreenshotService.shared.install(on: scene, provider: provider)
        }
    }
}

final class ScreenshotInstallView: UIView {
    var onWindowSceneChanged: ((UIWindowScene?) -> Void)?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        onWindowSceneChanged?(window?.windowScene)
    }
}

private struct ConversationScreenshotPDFRenderer {
    private let snapshot: ConversationScreenshotSnapshot

    private let pageBounds = CGRect(x: 0, y: 0, width: 612, height: 792)
    private let inset = UIEdgeInsets(top: 48, left: 48, bottom: 48, right: 48)

    init(snapshot: ConversationScreenshotSnapshot) {
        self.snapshot = snapshot
    }

    func render() -> (data: Data, currentPageRect: CGRect) {
        let textRect = pageBounds.inset(by: inset)
        let attributed = makeAttributedTranscript()
        let framesetter = CTFramesetterCreateWithAttributedString(attributed)
        let format = UIGraphicsPDFRendererFormat()
        format.documentInfo = [
            kCGPDFContextTitle as String: snapshot.title,
            kCGPDFContextCreator as String: "Hawky",
        ]

        let renderer = UIGraphicsPDFRenderer(bounds: pageBounds, format: format)
        let data = renderer.pdfData { context in
            var range = CFRange(location: 0, length: 0)
            repeat {
                context.beginPage()
                let cg = context.cgContext
                Self.paperColor.setFill()
                cg.fill(pageBounds)
                cg.saveGState()
                cg.translateBy(x: 0, y: pageBounds.height)
                cg.scaleBy(x: 1, y: -1)
                cg.textMatrix = .identity

                let path = CGMutablePath()
                path.addRect(textRect)
                let frame = CTFramesetterCreateFrame(framesetter, range, path, nil)
                CTFrameDraw(frame, cg)
                let visible = CTFrameGetVisibleStringRange(frame)
                range.location += max(visible.length, 1)
                cg.restoreGState()
            } while range.location < CFAttributedStringGetLength(attributed)
        }
        return (data, textRect)
    }

    private func makeAttributedTranscript() -> CFAttributedString {
        let output = NSMutableAttributedString()
        appendHeader(to: output)
        for row in snapshot.rows {
            append(row: row, to: output)
        }
        return output as CFAttributedString
    }

    private func appendHeader(to output: NSMutableAttributedString) {
        output.append(NSAttributedString(
            string: "\(snapshot.title)\n",
            attributes: [
                .font: UIFont.systemFont(ofSize: 22, weight: .bold),
                .foregroundColor: Self.primaryTextColor,
            ]
        ))
        output.append(NSAttributedString(
            string: "\(snapshot.subtitle)\nGenerated \(Self.dateFormatter.string(from: snapshot.generatedAt))\n\n",
            attributes: [
                .font: UIFont.systemFont(ofSize: 10, weight: .regular),
                .foregroundColor: Self.secondaryTextColor,
            ]
        ))
    }

    private func append(row: ConversationScreenshotSnapshot.Row, to output: NSMutableAttributedString) {
        let role = row.role.uppercased()
        let time = row.timestamp.map(Self.timeFormatter.string(from:)) ?? ""
        let prefix = time.isEmpty ? "\(role)\n" : "\(role)  \(time)\n"
        output.append(NSAttributedString(
            string: prefix,
            attributes: [
                .font: UIFont.monospacedSystemFont(ofSize: 9, weight: .semibold),
                .foregroundColor: color(for: row.role),
            ]
        ))

        let paragraph = NSMutableParagraphStyle()
        paragraph.paragraphSpacing = 12
        paragraph.lineSpacing = 2
        output.append(NSAttributedString(
            string: "\(row.text.trimmingCharacters(in: .whitespacesAndNewlines))\n\n",
            attributes: [
                .font: UIFont.systemFont(ofSize: 12),
                .foregroundColor: Self.primaryTextColor,
                .paragraphStyle: paragraph,
            ]
        ))
    }

    private func color(for role: String) -> UIColor {
        switch role.lowercased() {
        case "user": return UIColor(red: 0.02, green: 0.20, blue: 0.55, alpha: 1)
        case "assistant": return UIColor(red: 0.00, green: 0.34, blue: 0.18, alpha: 1)
        case "tool": return UIColor(red: 0.30, green: 0.12, blue: 0.55, alpha: 1)
        case "system": return Self.secondaryTextColor
        default: return Self.primaryTextColor
        }
    }

    private static let paperColor = UIColor.white
    private static let primaryTextColor = UIColor(white: 0.08, alpha: 1)
    private static let secondaryTextColor = UIColor(white: 0.34, alpha: 1)

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()
}

extension LiveSessionStore {
    func conversationScreenshotSnapshot() -> ConversationScreenshotSnapshot? {
        let rows = transcript
            .filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .map {
                ConversationScreenshotSnapshot.Row(
                    role: $0.role.rawValue,
                    text: $0.text,
                    timestamp: $0.date
                )
            }
        guard !rows.isEmpty else { return nil }
        let title = localSessions.first(where: { $0.id == currentSessionID })?.title ?? "Live Conversation"
        return ConversationScreenshotSnapshot(
            title: title,
            subtitle: "Live session",
            rows: rows
        )
    }
}
