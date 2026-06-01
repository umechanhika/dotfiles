import Cocoa

/// 座標変換の単一の真実の置き場所。
///
/// 3つの座標系が登場する:
///   - CGEvent global  : 画面左上が原点・Y は下向き（`CGEvent.location`, `CGEventTap`）
///   - Accessibility   : 画面左上が原点・Y は下向き（`kAXPositionAttribute` 等）※CGEvent と同一系
///   - Cocoa(NSScreen) : メイン画面の左下が原点・Y は上向き（`NSScreen.frame/visibleFrame`）
///
/// 事故防止の方針: AX に関わる経路は全部「CG global(左上原点)」で通し、Cocoa を経由するのは
/// `NSScreen` の frame/visibleFrame を取る一瞬だけにする。反転計算はこの enum に1か所だけ集約する。
enum Geometry {
    /// メインディスプレイ(原点を含む画面)の高さ。Cocoa↔CG global の Y 反転に使う。
    /// `NSScreen.screens[0]` は常にメイン。マルチディスプレイでも各 screen.frame の origin は
    /// 既に「メイン基準のグローバル Cocoa 座標」なので、反転に必要なのは primary の高さだけ。
    private static var primaryHeight: CGFloat {
        NSScreen.screens.first?.frame.height ?? 0
    }

    /// CG global 点(左上原点・Y下) → Cocoa 点(左下原点・Y上)。
    static func cgGlobalToCocoa(_ p: CGPoint) -> CGPoint {
        CGPoint(x: p.x, y: primaryHeight - p.y)
    }

    /// Cocoa 矩形(左下原点) → CG global 矩形(左上原点)。
    /// 矩形は origin が左下なので、左上の y は `primaryHeight - maxY` になる。
    static func cocoaRectToCGGlobal(_ r: CGRect) -> CGRect {
        CGRect(x: r.origin.x,
               y: primaryHeight - r.maxY,
               width: r.width,
               height: r.height)
    }

    /// CG global 矩形(左上原点) → Cocoa 矩形(左下原点)。`cocoaRectToCGGlobal` の逆。
    /// プレビューオーバーレイ（NSWindow は Cocoa 座標）の配置に使う。
    static func cgGlobalRectToCocoa(_ r: CGRect) -> CGRect {
        CGRect(x: r.origin.x,
               y: primaryHeight - r.origin.y - r.height,
               width: r.width,
               height: r.height)
    }

    /// ゾーンに対応するスナップ先矩形を CG global(左上原点) で返す。
    /// `AXUIElementSetAttributeValue` の position/size にそのまま渡せる。
    /// `vf` は対象画面の visibleFrame(Cocoa, menubar/Dock 除外済み)。
    static func snapRect(for zone: SnapZone, visibleFrameCocoa vf: CGRect) -> CGRect {
        let halfW = vf.width / 2
        let halfH = vf.height / 2
        // Cocoa(左下原点) で各ゾーンの矩形を組み立てる。Cocoa では「上」が y の大きい側。
        let cocoaRect: CGRect
        switch zone {
        case .top:
            cocoaRect = vf                                                              // 全面（最大化）
        case .left:
            cocoaRect = CGRect(x: vf.minX,          y: vf.minY,          width: halfW, height: vf.height)
        case .right:
            cocoaRect = CGRect(x: vf.minX + halfW,  y: vf.minY,          width: halfW, height: vf.height)
        case .topLeft:
            cocoaRect = CGRect(x: vf.minX,          y: vf.minY + halfH,  width: halfW, height: halfH)
        case .topRight:
            cocoaRect = CGRect(x: vf.minX + halfW,  y: vf.minY + halfH,  width: halfW, height: halfH)
        case .bottomLeft:
            cocoaRect = CGRect(x: vf.minX,          y: vf.minY,          width: halfW, height: halfH)
        case .bottomRight:
            cocoaRect = CGRect(x: vf.minX + halfW,  y: vf.minY,          width: halfW, height: halfH)
        }
        return cocoaRectToCGGlobal(cocoaRect)
    }
}
