import Cocoa
import ApplicationServices

/// Accessibility API のラッパ。
///
/// 座標は全て CG global(左上原点・Y下) でやり取りする。AX の position/size も同じ系なので、
/// カーソル座標・ウィンドウ位置・set する矩形まで Cocoa を経由せずに扱える（変換不要＝事故が少ない）。
enum AXWindow {
    /// タイトルバー帯の高さ(pt)。掴み判定（上端からこの帯にカーソルがあれば「タイトルバー掴み」）。
    static let TITLEBAR_HEIGHT: CGFloat = 32

    private static let systemWide = AXUIElementCreateSystemWide()

    /// カーソル直下の UI 要素から、所属するウィンドウを取得する。
    static func windowUnderCursor(at globalPoint: CGPoint) -> AXUIElement? {
        var element: AXUIElement?
        let err = AXUIElementCopyElementAtPosition(
            systemWide, Float(globalPoint.x), Float(globalPoint.y), &element)
        guard err == .success, let el = element else { return nil }
        return enclosingWindow(of: el)
    }

    /// 要素から所属ウィンドウへ昇格する。要素自身がウィンドウならそのまま返す。
    private static func enclosingWindow(of element: AXUIElement) -> AXUIElement? {
        if role(of: element) == (kAXWindowRole as String) { return element }
        if let w = copyElement(element, kAXWindowAttribute) { return w }
        if let t = copyElement(element, kAXTopLevelUIElementAttribute) { return t }
        return nil
    }

    /// フォールバック: 最前面アプリの focused window。
    /// （カーソル直下からウィンドウを辿れないアプリ向けの保険）
    static func frontmostFocusedWindow() -> AXUIElement? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let appEl = AXUIElementCreateApplication(app.processIdentifier)
        return copyElement(appEl, kAXFocusedWindowAttribute)
    }

    /// globalPoint がウィンドウ上端のタイトルバー帯に入っているか。
    /// position/size も AX 系(左上原点)なので globalPoint と同系で比較できる。
    static func isTitlebarHit(_ window: AXUIElement, globalPoint: CGPoint) -> Bool {
        guard let pos = position(of: window) else { return false }
        return globalPoint.y >= pos.y && globalPoint.y <= pos.y + TITLEBAR_HEIGHT
    }

    /// ウィンドウを移動＆リサイズする。
    /// size→position→size の3手で「大→小に動かすときのはみ出し補正」と
    /// 「最小サイズ制約を持つウィンドウ（端末等）での1手目無視」の両方を吸収する。
    static func setFrame(_ window: AXUIElement, position p: CGPoint, size s: CGSize) {
        setSize(window, s)
        setPosition(window, p)
        setSize(window, s)
    }

    // MARK: - 属性の取得

    static func position(of window: AXUIElement) -> CGPoint? {
        guard let v = copyValue(window, kAXPositionAttribute) else { return nil }
        var point = CGPoint.zero
        AXValueGetValue(v, .cgPoint, &point)
        return point
    }

    static func size(of window: AXUIElement) -> CGSize? {
        guard let v = copyValue(window, kAXSizeAttribute) else { return nil }
        var sz = CGSize.zero
        AXValueGetValue(v, .cgSize, &sz)
        return sz
    }

    // MARK: - 内部ヘルパ

    private static func setPosition(_ window: AXUIElement, _ p: CGPoint) {
        var point = p
        guard let value = AXValueCreate(.cgPoint, &point) else { return }
        AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value)
    }

    private static func setSize(_ window: AXUIElement, _ s: CGSize) {
        var sz = s
        guard let value = AXValueCreate(.cgSize, &sz) else { return }
        AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, value)
    }

    private static func role(of element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) == .success
        else { return nil }
        return value as? String
    }

    /// 属性値を AXUIElement として取り出す（型が AXUIElement のときのみ）。
    private static func copyElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let v = value, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    /// 属性値を AXValue として取り出す（position/size 用）。
    private static func copyValue(_ element: AXUIElement, _ attribute: String) -> AXValue? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let v = value, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        return (v as! AXValue)
    }
}
