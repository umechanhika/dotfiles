import Cocoa

/// 画面（NSScreen）に関する補助。座標系の出入りは Geometry に委譲する。
enum ScreenUtil {
    /// カーソル(CG global)がどの画面上にあるかを返す。
    ///
    /// 注意: `NSScreen.main` は「キーウィンドウのある画面」であってカーソルのいる画面ではない。
    /// そのため frame.contains で自前判定する。どの画面にも入らなければ main にフォールバック。
    static func screenContainingCursorGlobal(_ pCG: CGPoint) -> NSScreen? {
        let cocoa = Geometry.cgGlobalToCocoa(pCG)
        if let hit = NSScreen.screens.first(where: { $0.frame.contains(cocoa) }) {
            return hit
        }
        return NSScreen.main
    }

    /// 画面全体の frame を CG global(左上原点) で返す。ゾーン判定（端への到達）に使う。
    static func frameCGGlobal(of screen: NSScreen) -> CGRect {
        Geometry.cocoaRectToCGGlobal(screen.frame)
    }

    /// menubar/Dock を除いた可視領域（Cocoa）。スナップ先のサイズ計算に使う。
    static func visibleFrame(of screen: NSScreen) -> CGRect {
        screen.visibleFrame
    }
}
