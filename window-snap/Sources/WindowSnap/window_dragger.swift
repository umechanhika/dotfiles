import Cocoa
import CoreGraphics

/// マウスドラッグの状態機械。EventTap から down/drag/up を受け取り、
/// 端ゾーンでの離上時に対象ウィンドウをスナップする。
///
/// 重要な設計判断:
///   - 対象ウィンドウは leftMouseDown 時点で確定して保持する（drag/up 中に再取得しない）。
///     途中で別ウィンドウに化けるのを防ぐため。
///   - listenOnly のタップから呼ばれるので、down/drag では重い AX 呼び出しをしない。
///     実際の snap（AX への set）は up のとき一度だけ行う。
final class WindowDragger {
    /// 「単なるクリック」と区別するための最小移動量(pt)。これ未満の移動では snap しない。
    /// 修飾キー無しで使うため、端付近で少し動かしただけの誤スナップをこれで防ぐ。
    private static let MOVE_THRESHOLD: CGFloat = 8

    private let overlay = SnapOverlay()
    private var dragging = false
    private var target: AXUIElement?
    private var titlebarDrag = false
    private var downPointGlobal: CGPoint = .zero

    init() {
        // スペース切替（Mission Control で別スペースへドロップ等）でもプレビューを残さない。
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            self?.cancelDrag()
        }
    }

    /// EventTap からの単一窓口。
    func handle(_ type: CGEventType, _ event: CGEvent) {
        switch type {
        case .leftMouseDown:
            beginDrag(at: event.location)
        case .leftMouseDragged:
            updateDrag(at: event.location)
        case .leftMouseUp:
            endDrag(at: event.location)
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            // ドラッグ中に Mission Control 等で入力が奪われタップが無効化された。
            // プレビューを残さないよう即座に片付ける（snap はしない）。
            cancelDrag()
        default:
            break
        }
    }

    /// ドラッグを中断して状態とプレビューを片付ける（snap はしない）。
    private func cancelDrag() {
        overlay.hide()
        reset()
    }

    private func beginDrag(at p: CGPoint) {
        downPointGlobal = p
        // 対象ウィンドウを down 時点で確定。直下→失敗時 最前面 focused の2段構え。
        let window = AXWindow.windowUnderCursor(at: p) ?? AXWindow.frontmostFocusedWindow()
        target = window
        titlebarDrag = window.map { AXWindow.isTitlebarHit($0, globalPoint: p) } ?? false
        dragging = true
    }

    /// ドラッグ中: 現在のゾーンに応じてスナップ先プレビューを出す（軽い計算のみ）。
    /// AX 呼び出しはせず、ゾーン判定と差分付きのオーバーレイ更新だけ行う。
    private func updateDrag(at p: CGPoint) {
        guard dragging, titlebarDrag else { return }
        guard let (zone, screen) = zoneAndScreen(at: p) else { overlay.hide(); return }
        let rect = Geometry.snapRect(for: zone, visibleFrameCocoa: ScreenUtil.visibleFrame(of: screen))
        overlay.show(rectCGGlobal: rect)
    }

    private func endDrag(at p: CGPoint) {
        defer { reset() }
        overlay.hide()
        guard dragging, titlebarDrag, let window = target else { return }

        // 移動量が小さい（≒クリック）なら誤爆防止で snap しない。
        let dx = p.x - downPointGlobal.x
        let dy = p.y - downPointGlobal.y
        guard (dx * dx + dy * dy).squareRoot() >= WindowDragger.MOVE_THRESHOLD else { return }

        guard let (zone, screen) = zoneAndScreen(at: p) else { return }
        let rect = Geometry.snapRect(for: zone, visibleFrameCocoa: ScreenUtil.visibleFrame(of: screen))
        AXWindow.setFrame(window, position: rect.origin, size: rect.size)
    }

    /// カーソル位置(CG global)から (ゾーン, 画面) を返す。端に達していなければ nil。
    private func zoneAndScreen(at p: CGPoint) -> (SnapZone, NSScreen)? {
        guard let screen = ScreenUtil.screenContainingCursorGlobal(p) else { return nil }
        let frameGlobal = ScreenUtil.frameCGGlobal(of: screen)
        guard let zone = SnapZone.zone(forCursorGlobal: p, screenFrameGlobal: frameGlobal) else { return nil }
        return (zone, screen)
    }

    private func reset() {
        dragging = false
        target = nil
        titlebarDrag = false
    }
}
