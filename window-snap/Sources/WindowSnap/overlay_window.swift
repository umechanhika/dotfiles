import Cocoa

/// スナップ先を予告表示する半透明オーバーレイ（BTT の白いハイライト相当）。
///
/// borderless / クリックスルー / floating の NSWindow を1枚使い回し、ドラッグ中に
/// スナップ先矩形へ移動して表示する。差分更新（同じ矩形なら何もしない）で、
/// ドラッグイベントごとの再描画コストを抑える（イベントタップのタイムアウト無効化対策）。
///
/// 注意: NSWindow は Cocoa 座標(左下原点)。受け取る矩形は CG global(左上原点)なので、
/// Geometry.cgGlobalRectToCocoa で一度だけ変換してから配置する。
final class SnapOverlay {
    private var window: NSWindow?
    private var currentRectCG: CGRect?   // 表示中の矩形(CG global)。差分更新の基準。

    /// 指定矩形(CG global)にオーバーレイを表示する。同じ矩形なら何もしない。
    func show(rectCGGlobal rect: CGRect) {
        if currentRectCG == rect { return }
        currentRectCG = rect
        let cocoaRect = Geometry.cgGlobalRectToCocoa(rect)
        let win = window ?? makeWindow()
        win.setFrame(cocoaRect, display: false)
        win.orderFrontRegardless()   // .accessory アプリでも前面に出す
        window = win
    }

    /// オーバーレイを隠す。既に隠れているなら何もしない。
    func hide() {
        guard currentRectCG != nil else { return }
        currentRectCG = nil
        window?.orderOut(nil)
    }

    private func makeWindow() -> NSWindow {
        let win = NSWindow(contentRect: .zero, styleMask: .borderless,
                           backing: .buffered, defer: false)
        win.isOpaque = false
        win.backgroundColor = .clear
        win.ignoresMouseEvents = true   // ドラッグ操作を一切邪魔しない（クリックスルー）
        win.level = .floating
        // .transient: Mission Control / App Exposé が起動すると OS が自動で隠す一時 UI 扱い。
        // これにより上端ドラッグで Mission Control が出てもプレビューが前面に残らない。
        // （以前の .canJoinAllSpaces は HUD のように最前面に残り続け、残留の原因だった）
        win.collectionBehavior = [.transient, .ignoresCycle]
        // スクリーンショット／画面収録にプレビューが写り込まないようにする。
        // ※ Mission Control のスペース・サムネイルはウィンドウサーバー側の合成のため
        //   sharingType を尊重せず、上端ドラッグ時はサムネイルが薄く白むことがある（OS の制約）。
        win.sharingType = .none
        win.hasShadow = false

        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.28).cgColor
        view.layer?.borderColor = NSColor.white.withAlphaComponent(0.9).cgColor
        view.layer?.borderWidth = 2
        view.layer?.cornerRadius = 8
        win.contentView = view
        return win
    }
}
