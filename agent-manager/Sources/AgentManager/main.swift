import Cocoa
import SwiftUI

/// 非アクティブなフローティング窓でも「最初のクリック」を中身に届けるための
/// NSHostingView サブクラス。これがないと、窓が key でないときの1クリック目が
/// ウィンドウ活性化に吸われ、2クリック目でやっとタップが反応してしまう。
final class ClickThroughHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    required init(rootView: Content) { super.init(rootView: rootView) }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: NSPanel?
    private let store = SessionStore()

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenu()
        let hosting = ClickThroughHostingView(rootView: ContentView(store: store))
        hosting.translatesAutoresizingMaskIntoConstraints = false

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 220, height: 120),
            styleMask: [.nonactivatingPanel, .titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        // 標準タイトルバーに "AgentManager" を表示。トラフィックライト（赤=閉じる/黄=最小化）は左上。
        // 緑(zoom)はリサイズ不可なので自動的にグレーアウトする。
        // ※ fullSizeContentView は使わない（コンテンツ高さにタイトルバーが上乗せされ上部が分厚くなるため）。
        panel.title = "AgentManager"
        panel.titleVisibility = .visible
        panel.titlebarSeparatorStyle = .none   // タイトルバー下の濃い区切り線を消す
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false   // 赤で閉じても解放しない（Dockクリックで再表示するため）

        // 常時最前面・全 Space・半透明。
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false

        panel.contentView = hosting
        // レイアウトを確定させてから内容に合うサイズへ（起動直後は fittingSize が 0 になりうる）。
        hosting.layoutSubtreeIfNeeded()
        var size = hosting.fittingSize
        if size.width < 50 || size.height < 30 { size = NSSize(width: 230, height: 120) }
        panel.setContentSize(size)

        // 右上あたりに初期配置。
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: f.maxX - size.width - 20, y: f.maxY - size.height - 20))
        }

        panel.orderFrontRegardless()
        self.panel = panel
    }

    /// Dock アイコンのクリックで（閉じた/最小化した後も）小窓を再表示する。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if let panel = panel {
            if panel.isMiniaturized { panel.deminiaturize(nil) }
            panel.orderFrontRegardless()
        }
        return true
    }

    /// 最小限のメインメニュー（⌘H 非表示 / ⌘Q 終了）。
    private func setupMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "非表示", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "AgentManager を終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        NSApp.mainMenu = mainMenu
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)   // Dock アイコンを表示
app.run()
