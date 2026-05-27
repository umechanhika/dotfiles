// make-icon.swift
// AgentManager のアプリアイコンを CoreGraphics でベクター描画し、
// .iconset 用の各サイズ PNG を出力する（外部依存なし）。
//
// 使い方: swift make-icon.swift <出力する .iconset ディレクトリ>
//
// デザイン: macOS 風の角丸スクエア（ダークなグラデーション）に、アプリの本質である
//   「セッションのステータス一覧」を表す 3 行（色付きドット＋ラベルバー）を配置。
//   黄=要対応 / 緑=応答完了 / 青=処理中 に対応。

import Cocoa
import ImageIO
import UniformTypeIdentifiers

func drawIcon(_ ctx: CGContext, _ S: CGFloat) {
    ctx.setAllowsAntialiasing(true)
    ctx.interpolationQuality = .high

    // 角丸スクエアの領域（外周に透明マージン）。
    let margin = S * 0.085
    let rect = CGRect(x: margin, y: margin, width: S - 2 * margin, height: S - 2 * margin)
    let art = rect.width
    let radius = art * 0.2237   // Apple 風の連続角丸に近い比率
    let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

    // 背景グラデーション（ダーク）。
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    let cs = CGColorSpaceCreateDeviceRGB()
    let bg = [CGColor(red: 0.27, green: 0.29, blue: 0.34, alpha: 1),
              CGColor(red: 0.11, green: 0.12, blue: 0.15, alpha: 1)] as CFArray
    let grad = CGGradient(colorsSpace: cs, colors: bg, locations: [0, 1])!
    ctx.drawLinearGradient(grad,
                           start: CGPoint(x: rect.midX, y: rect.maxY),
                           end: CGPoint(x: rect.midX, y: rect.minY),
                           options: [])
    ctx.restoreGState()

    // 上端のかすかなハイライト（立体感）。
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.06))
    ctx.fill(CGRect(x: rect.minX, y: rect.midY, width: rect.width, height: rect.height / 2))
    ctx.restoreGState()

    // 3 行（ドット＋バー）。
    let dotColors = [CGColor(red: 1.00, green: 0.80, blue: 0.00, alpha: 1),  // 黄: 要対応
                     CGColor(red: 0.20, green: 0.78, blue: 0.35, alpha: 1),  // 緑: 応答完了
                     CGColor(red: 0.04, green: 0.52, blue: 1.00, alpha: 1)]  // 青: 処理中
    let inset = art * 0.21
    let content = rect.insetBy(dx: inset, dy: inset)
    let n = 3
    let rowH = content.height / CGFloat(n)
    let dotR = rowH * 0.19
    let barLenFactors: [CGFloat] = [1.00, 0.78, 0.88]  // バー長を少し変えて単調さを回避

    for i in 0..<n {
        let cy = content.maxY - rowH * (CGFloat(i) + 0.5)   // i=0 を上段に
        let cx = content.minX + dotR

        // ドット
        ctx.setFillColor(dotColors[i])
        ctx.fillEllipse(in: CGRect(x: cx - dotR, y: cy - dotR, width: dotR * 2, height: dotR * 2))

        // ラベルバー
        let barX = cx + dotR + art * 0.07
        let barH = dotR * 1.35
        let maxBarW = content.maxX - barX
        let barW = max(maxBarW * barLenFactors[i], art * 0.08)
        let barRect = CGRect(x: barX, y: cy - barH / 2, width: barW, height: barH)
        let barPath = CGPath(roundedRect: barRect, cornerWidth: barH / 2, cornerHeight: barH / 2, transform: nil)
        ctx.addPath(barPath)
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.90))
        ctx.fillPath()
    }
}

func render(_ pixels: Int) -> CGImage {
    let cs = CGColorSpaceCreateDeviceRGB()
    let ctx = CGContext(data: nil, width: pixels, height: pixels,
                        bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    drawIcon(ctx, CGFloat(pixels))
    return ctx.makeImage()!
}

func savePNG(_ image: CGImage, to url: URL) {
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
}

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("usage: swift make-icon.swift <iconset-dir>\n".data(using: .utf8)!)
    exit(1)
}
let outDir = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

// iconset に必要なファイル名とピクセルサイズ。
let entries: [(String, Int)] = [
    ("icon_16x16.png", 16),     ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),     ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),  ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),  ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),  ("icon_512x512@2x.png", 1024),
]
var cache: [Int: CGImage] = [:]
for (name, px) in entries {
    let img = cache[px] ?? render(px)
    cache[px] = img
    savePNG(img, to: outDir.appendingPathComponent(name))
}
print("icon pngs written to \(outDir.path)")
