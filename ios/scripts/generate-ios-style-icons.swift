#!/usr/bin/env swift

import AppKit
import Foundation

private enum IconKind {
    case tile
    case tab
}

private struct IconPalette {
    let primary: NSColor
    let secondary: NSColor
    let tint: NSColor
}

private struct IconSpec {
    let assetName: String
    let symbol: String
    let fallbackSymbol: String
    let kind: IconKind
    let palette: IconPalette
}

private func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(calibratedRed: red / 255, green: green / 255, blue: blue / 255, alpha: alpha)
}

private func mixed(_ color: NSColor, with overlay: NSColor, amount: CGFloat) -> NSColor {
    let base = color.usingColorSpace(.deviceRGB) ?? color
    let top = overlay.usingColorSpace(.deviceRGB) ?? overlay
    let keep = 1 - amount
    return NSColor(
        calibratedRed: base.redComponent * keep + top.redComponent * amount,
        green: base.greenComponent * keep + top.greenComponent * amount,
        blue: base.blueComponent * keep + top.blueComponent * amount,
        alpha: base.alphaComponent
    )
}

private let amber = IconPalette(
    primary: color(206, 135, 34),
    secondary: color(21, 116, 120),
    tint: color(246, 221, 164)
)

private let teal = IconPalette(
    primary: color(18, 126, 132),
    secondary: color(218, 160, 44),
    tint: color(181, 224, 221)
)

private let blue = IconPalette(
    primary: color(41, 112, 216),
    secondary: color(18, 126, 132),
    tint: color(199, 222, 255)
)

private let purple = IconPalette(
    primary: color(130, 91, 214),
    secondary: color(218, 160, 44),
    tint: color(222, 210, 248)
)

private let green = IconPalette(
    primary: color(42, 142, 78),
    secondary: color(18, 126, 132),
    tint: color(197, 232, 209)
)

private let pink = IconPalette(
    primary: color(198, 77, 142),
    secondary: color(218, 160, 44),
    tint: color(246, 207, 226)
)

private let orange = IconPalette(
    primary: color(210, 116, 39),
    secondary: color(18, 126, 132),
    tint: color(248, 213, 181)
)

private let red = IconPalette(
    primary: color(205, 70, 68),
    secondary: color(218, 160, 44),
    tint: color(247, 204, 202)
)

private let indigo = IconPalette(
    primary: color(78, 96, 210),
    secondary: color(18, 126, 132),
    tint: color(207, 212, 249)
)

private let gray = IconPalette(
    primary: color(102, 108, 116),
    secondary: color(218, 160, 44),
    tint: color(222, 225, 228)
)

private let tileSpecs: [IconSpec] = [
    IconSpec(assetName: "LiveMoreIconSettings", symbol: "gearshape", fallbackSymbol: "gear", kind: .tile, palette: teal),
    IconSpec(assetName: "LiveMoreIconPeople", symbol: "person.2.fill", fallbackSymbol: "person.2", kind: .tile, palette: blue),
    IconSpec(assetName: "LiveMoreIconMockLocation", symbol: "location.viewfinder", fallbackSymbol: "location", kind: .tile, palette: green),
    IconSpec(assetName: "LiveMoreIconMemory", symbol: "brain.head.profile", fallbackSymbol: "brain", kind: .tile, palette: purple),

    IconSpec(assetName: "SettingsIconSetup", symbol: "wand.and.sparkles", fallbackSymbol: "sparkles", kind: .tile, palette: amber),
    IconSpec(assetName: "SettingsIconConnection", symbol: "network", fallbackSymbol: "antenna.radiowaves.left.and.right", kind: .tile, palette: blue),
    IconSpec(assetName: "SettingsIconAgent", symbol: "brain.head.profile", fallbackSymbol: "brain", kind: .tile, palette: purple),
    IconSpec(assetName: "SettingsIconLive", symbol: "waveform", fallbackSymbol: "waveform.circle", kind: .tile, palette: teal),
    IconSpec(assetName: "SettingsIconPrompt", symbol: "text.quote", fallbackSymbol: "quote.bubble", kind: .tile, palette: green),
    IconSpec(assetName: "SettingsIconAppearance", symbol: "paintpalette.fill", fallbackSymbol: "paintpalette", kind: .tile, palette: pink),
    IconSpec(assetName: "SettingsIconNotifications", symbol: "bell.badge.fill", fallbackSymbol: "bell", kind: .tile, palette: orange),
    IconSpec(assetName: "SettingsIconLayout", symbol: "rectangle.grid.2x2", fallbackSymbol: "square.grid.2x2", kind: .tile, palette: indigo),
    IconSpec(assetName: "SettingsIconAbout", symbol: "info.circle.fill", fallbackSymbol: "info.circle", kind: .tile, palette: gray),
    IconSpec(assetName: "SettingsIconDeveloperLab", symbol: "hammer", fallbackSymbol: "wrench.and.screwdriver", kind: .tile, palette: gray),
    IconSpec(assetName: "SettingsIconGatewayProbes", symbol: "testtube.2", fallbackSymbol: "waveform.path.ecg", kind: .tile, palette: amber),
    IconSpec(assetName: "SettingsIconWebRTCLab", symbol: "dot.radiowaves.left.and.right", fallbackSymbol: "antenna.radiowaves.left.and.right", kind: .tile, palette: teal),
    IconSpec(assetName: "SettingsIconRecordingLab", symbol: "record.circle.fill", fallbackSymbol: "record.circle", kind: .tile, palette: red),
    IconSpec(assetName: "SettingsIconTranscriptLab", symbol: "text.bubble", fallbackSymbol: "captions.bubble", kind: .tile, palette: blue),
    IconSpec(assetName: "SettingsIconExperimentalLive", symbol: "sparkles.tv", fallbackSymbol: "sparkles", kind: .tile, palette: purple),
]

private let tabSpecs: [IconSpec] = [
    IconSpec(assetName: "TabIconProbes", symbol: "testtube.2", fallbackSymbol: "waveform.path.ecg", kind: .tab, palette: amber),
    IconSpec(assetName: "TabIconLive", symbol: "camera.fill", fallbackSymbol: "camera", kind: .tab, palette: teal),
    IconSpec(assetName: "TabIconSettings", symbol: "gearshape", fallbackSymbol: "gear", kind: .tab, palette: gray),
]

private func makeBitmap(size: Int, draw: (NSRect) -> Void) throws -> NSBitmapImageRep {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw NSError(domain: "IconGeneration", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unable to create bitmap"])
    }

    NSGraphicsContext.saveGraphicsState()
    let context = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current = context
    context?.cgContext.setShouldAntialias(true)
    context?.cgContext.setAllowsAntialiasing(true)
    draw(NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()

    return rep
}

private func drawRoundedTile(in canvas: NSRect, palette: IconPalette) {
    let tileRect = canvas.insetBy(dx: canvas.width * 0.095, dy: canvas.height * 0.095)
    let radius = canvas.width * 0.205
    let path = NSBezierPath(roundedRect: tileRect, xRadius: radius, yRadius: radius)

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.16)
    shadow.shadowBlurRadius = canvas.width * 0.040
    shadow.shadowOffset = NSSize(width: 0, height: -canvas.height * 0.014)
    shadow.set()
    NSGradient(colors: [
        color(255, 253, 247),
        color(244, 248, 248),
        color(226, 232, 232)
    ])?.draw(in: path, angle: 315)
    NSGraphicsContext.restoreGraphicsState()

    palette.tint.withAlphaComponent(0.22).setFill()
    path.fill()

    NSGraphicsContext.saveGraphicsState()
    path.addClip()
    NSGradient(colors: [
        NSColor.clear,
        NSColor.black.withAlphaComponent(0.042)
    ])?.draw(in: tileRect.insetBy(dx: canvas.width * 0.026, dy: canvas.height * 0.026), angle: 270)
    NSGraphicsContext.restoreGraphicsState()

    let fold = NSBezierPath()
    fold.move(to: NSPoint(x: tileRect.maxX - canvas.width * 0.12, y: tileRect.maxY))
    fold.line(to: NSPoint(x: tileRect.maxX, y: tileRect.maxY))
    fold.line(to: NSPoint(x: tileRect.maxX, y: tileRect.maxY - canvas.width * 0.12))
    fold.close()
    NSGraphicsContext.saveGraphicsState()
    path.addClip()
    NSColor.white.withAlphaComponent(0.12).setFill()
    fold.fill()
    NSGraphicsContext.restoreGraphicsState()

    NSGraphicsContext.saveGraphicsState()
    path.addClip()
    palette.secondary.withAlphaComponent(0.055).setStroke()
    let detail = NSBezierPath()
    detail.lineWidth = canvas.width * 0.006
    detail.move(to: NSPoint(x: tileRect.minX + canvas.width * 0.10, y: tileRect.minY + canvas.width * 0.13))
    detail.line(to: NSPoint(x: tileRect.maxX - canvas.width * 0.14, y: tileRect.maxY - canvas.width * 0.10))
    detail.stroke()

    let gloss = NSBezierPath(roundedRect: NSRect(
        x: tileRect.minX + canvas.width * 0.045,
        y: tileRect.midY + canvas.height * 0.09,
        width: tileRect.width - canvas.width * 0.09,
        height: tileRect.height * 0.40
    ), xRadius: radius * 0.72, yRadius: radius * 0.72)
    NSColor.white.withAlphaComponent(0.24).setFill()
    gloss.fill()
    NSGraphicsContext.restoreGraphicsState()

    palette.primary.withAlphaComponent(0.62).setStroke()
    path.lineWidth = canvas.width * 0.014
    path.stroke()

    NSColor.white.withAlphaComponent(0.44).setStroke()
    let highlight = NSBezierPath(roundedRect: tileRect.insetBy(dx: canvas.width * 0.030, dy: canvas.height * 0.030), xRadius: radius * 0.78, yRadius: radius * 0.78)
    highlight.lineWidth = canvas.width * 0.005
    highlight.stroke()

    NSColor.black.withAlphaComponent(0.035).setStroke()
    let innerShade = NSBezierPath(roundedRect: tileRect.insetBy(dx: canvas.width * 0.026, dy: canvas.height * 0.026), xRadius: radius * 0.80, yRadius: radius * 0.80)
    innerShade.lineWidth = canvas.width * 0.006
    innerShade.stroke()
}

private func configuredSymbol(named name: String, fallback: String, color: NSColor, pointSize: CGFloat, weight: NSFont.Weight) -> NSImage {
    let symbolName = NSImage(systemSymbolName: name, accessibilityDescription: nil) == nil ? fallback : name
    guard let base = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) else {
        return NSImage(size: NSSize(width: pointSize, height: pointSize))
    }
    let sizeConfig = NSImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
    let colorConfig = NSImage.SymbolConfiguration(hierarchicalColor: color)
    let config = sizeConfig.applying(colorConfig)
    return base.withSymbolConfiguration(config) ?? base
}

private func drawTintedSymbol(named name: String, fallback: String, in targetRect: NSRect, color: NSColor, pointSize: CGFloat, weight: NSFont.Weight) {
    let symbol = configuredSymbol(named: name, fallback: fallback, color: color, pointSize: pointSize, weight: weight)
    let symbolSize = symbol.size.width > 0 && symbol.size.height > 0
        ? symbol.size
        : NSSize(width: pointSize, height: pointSize)
    let scale = min(targetRect.width / symbolSize.width, targetRect.height / symbolSize.height)
    let drawSize = NSSize(width: symbolSize.width * scale, height: symbolSize.height * scale)
    let drawRect = NSRect(
        x: targetRect.midX - drawSize.width / 2,
        y: targetRect.midY - drawSize.height / 2,
        width: drawSize.width,
        height: drawSize.height
    )

    NSGraphicsContext.saveGraphicsState()
    symbol.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
}

private func drawTileIcon(_ spec: IconSpec, into canvas: NSRect) {
    drawRoundedTile(in: canvas, palette: spec.palette)

    let isHeadSymbol = spec.symbol == "brain.head.profile"
    let tileInset = isHeadSymbol ? canvas.width * 0.125 : canvas.width * 0.165
    let tilePointSize = canvas.width * (isHeadSymbol ? 0.68 : 0.60)
    let symbolBox = canvas.insetBy(dx: tileInset, dy: tileInset)
    let shadowBox = symbolBox.offsetBy(dx: canvas.width * 0.014, dy: -canvas.height * 0.014)
    drawTintedSymbol(
        named: spec.symbol,
        fallback: spec.fallbackSymbol,
        in: shadowBox,
        color: NSColor.black.withAlphaComponent(0.14),
        pointSize: tilePointSize,
        weight: .semibold
    )
    drawTintedSymbol(
        named: spec.symbol,
        fallback: spec.fallbackSymbol,
        in: symbolBox.offsetBy(dx: -canvas.width * 0.006, dy: canvas.height * 0.006),
        color: NSColor.white.withAlphaComponent(0.24),
        pointSize: tilePointSize,
        weight: .semibold
    )
    drawTintedSymbol(
        named: spec.symbol,
        fallback: spec.fallbackSymbol,
        in: symbolBox,
        color: spec.palette.primary,
        pointSize: tilePointSize,
        weight: .semibold
    )

    spec.palette.secondary.withAlphaComponent(0.92).setFill()
    let dotSize = canvas.width * 0.064
    let dotRect = NSRect(
        x: canvas.midX + canvas.width * 0.205,
        y: canvas.midY - canvas.height * 0.265,
        width: dotSize,
        height: dotSize
    )
    NSBezierPath(ovalIn: dotRect).fill()
    NSColor.white.withAlphaComponent(0.34).setFill()
    NSBezierPath(ovalIn: NSRect(
        x: dotRect.minX + dotSize * 0.20,
        y: dotRect.midY + dotSize * 0.08,
        width: dotSize * 0.30,
        height: dotSize * 0.30
    )).fill()
}

private func drawTabIcon(_ spec: IconSpec, into canvas: NSRect) {
    let tabPrimary = mixed(spec.palette.primary, with: .white, amount: 0.18)
    let tabSecondary = mixed(spec.palette.secondary, with: .white, amount: 0.08)
    let badgeRect = NSRect(
        x: canvas.midX - canvas.width * 0.30,
        y: canvas.midY - canvas.height * 0.30,
        width: canvas.width * 0.60,
        height: canvas.height * 0.60
    )
    spec.palette.tint.withAlphaComponent(0.28).setFill()
    NSBezierPath(ovalIn: badgeRect).fill()

    let symbolBox = canvas.insetBy(dx: canvas.width * 0.050, dy: canvas.height * 0.050)
    let shadowBox = symbolBox
        .offsetBy(dx: canvas.width * 0.014, dy: -canvas.height * 0.014)
    drawTintedSymbol(
        named: spec.symbol,
        fallback: spec.fallbackSymbol,
        in: shadowBox,
        color: NSColor.black.withAlphaComponent(0.18),
        pointSize: canvas.width * 0.84,
        weight: .semibold
    )
    drawTintedSymbol(
        named: spec.symbol,
        fallback: spec.fallbackSymbol,
        in: symbolBox.insetBy(dx: -canvas.width * 0.030, dy: -canvas.height * 0.030),
        color: NSColor.white.withAlphaComponent(0.24),
        pointSize: canvas.width * 0.86,
        weight: .semibold
    )
    drawTintedSymbol(
        named: spec.symbol,
        fallback: spec.fallbackSymbol,
        in: symbolBox.offsetBy(dx: -canvas.width * 0.006, dy: canvas.height * 0.006),
        color: NSColor.white.withAlphaComponent(0.16),
        pointSize: canvas.width * 0.84,
        weight: .semibold
    )

    drawTintedSymbol(
        named: spec.symbol,
        fallback: spec.fallbackSymbol,
        in: symbolBox,
        color: tabPrimary,
        pointSize: canvas.width * 0.84,
        weight: .semibold
    )

    tabSecondary.withAlphaComponent(0.98).setFill()
    NSBezierPath(ovalIn: NSRect(
        x: canvas.maxX - canvas.width * 0.285,
        y: canvas.maxY - canvas.height * 0.305,
        width: canvas.width * 0.135,
        height: canvas.height * 0.135
    )).fill()
    NSColor.white.withAlphaComponent(0.34).setFill()
    NSBezierPath(ovalIn: NSRect(
        x: canvas.maxX - canvas.width * 0.268,
        y: canvas.maxY - canvas.height * 0.272,
        width: canvas.width * 0.040,
        height: canvas.height * 0.040
    )).fill()
}

private func contentsJSON(for spec: IconSpec, filename: String, scale: String) -> String {
    if spec.assetName.hasPrefix("SettingsIcon") {
        return """
        {
          "images": [
            {
              "filename": "\(filename)",
              "idiom": "universal",
              "scale": "1x"
            },
            {
              "idiom": "universal",
              "scale": "2x"
            },
            {
              "idiom": "universal",
              "scale": "3x"
            }
          ],
          "info": {
            "author": "xcode",
            "version": 1
          }
        }
        """ + "\n"
    }

    let json = """
    {
      "images" : [
        {
          "filename" : "\(filename)",
          "idiom" : "universal",
          "scale" : "\(scale)"
        }
      ],
      "info" : {
        "author" : "xcode",
        "version" : 1
      }
    }
    """
    return spec.kind == .tab ? json + "\n" : json
}

private func writeIcon(_ spec: IconSpec, assetsRoot: URL) throws {
    let pixelSize = spec.kind == .tab ? 96 : 512
    let scale = spec.kind == .tab ? "3x" : "1x"
    let filename = "\(spec.assetName).png"
    let directory = assetsRoot.appendingPathComponent("\(spec.assetName).imageset", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    let bitmap = try makeBitmap(size: pixelSize) { rect in
        switch spec.kind {
        case .tile:
            drawTileIcon(spec, into: rect)
        case .tab:
            drawTabIcon(spec, into: rect)
        }
    }

    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "IconGeneration", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unable to encode \(filename)"])
    }

    try data.write(to: directory.appendingPathComponent(filename), options: .atomic)
    try contentsJSON(for: spec, filename: filename, scale: scale)
        .data(using: .utf8)?
        .write(to: directory.appendingPathComponent("Contents.json"), options: .atomic)
}

let repoRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
let assetsRoot = repoRoot.appendingPathComponent("ios/hawky/Assets.xcassets", isDirectory: true)

for spec in tileSpecs + tabSpecs {
    try writeIcon(spec, assetsRoot: assetsRoot)
}

print("Generated \(tileSpecs.count + tabSpecs.count) iOS-style icon assets.")
