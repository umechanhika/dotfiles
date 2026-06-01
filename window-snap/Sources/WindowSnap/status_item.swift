import Cocoa

/// メニューバー常駐アイコン。動作中であることを示し、終了とアクセシビリティ設定を提供する。
/// （Dock 非表示の .accessory アプリなので、ユーザーが触れる唯一の UI）
final class StatusItem: NSObject {
    private let item: NSStatusItem

    override init() {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        if let button = item.button {
            // テンプレート画像（メニューバーの明暗に自動追従）。左右分割のアイコンで「スナップ」を示す。
            button.image = NSImage(systemSymbolName: "rectangle.split.2x1",
                                   accessibilityDescription: "WindowSnap")
            button.image?.isTemplate = true
        }

        let menu = NSMenu()
        let header = menu.addItem(withTitle: "WindowSnap", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(.separator())

        let accessibility = menu.addItem(
            withTitle: "アクセシビリティ設定を開く",
            action: #selector(openAccessibility), keyEquivalent: "")
        accessibility.target = self

        menu.addItem(.separator())

        let quit = menu.addItem(
            withTitle: "WindowSnap を終了",
            action: #selector(quit), keyEquivalent: "q")
        quit.target = self

        item.menu = menu
    }

    /// 「システム設定 → プライバシーとセキュリティ → アクセシビリティ」を直接開く。
    @objc private func openAccessibility() {
        guard let url = URL(string:
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
