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
    /// メニューバー常駐（ステータス別件数の表示／窓の表示トグル）。
    private var statusBar: StatusBarController?

    /// 上端固定リサイズの基準（窓の上端 y = frame.maxY）。中身追従で高さが変わっても
    /// この上端を保つよう origin.y を詰め直し、左下原点リサイズによる上下動を防ぐ。
    private var anchorTopY: CGFloat?
    /// 自前の setFrame 起因の didResize 通知を無視する再入ガード。
    private var isAdjustingFrame = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenu()
        // 全セッションが終了したらアプリ自体を終了する。
        // 次回の SessionStart フックでまた起動するため、常駐し続ける必要はない。
        store.onAllSessionsEnded = { NSApp.terminate(nil) }
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

        // 初期表示はしない（waiting 連動）。waiting があれば StatusBarController が表示側へ倒す。
        self.panel = panel

        // 上端固定の基準を、初期配置後の実フレーム上端に合わせる（表示前でも setFrameOrigin 済みで有効）。
        anchorTopY = panel.frame.maxY
        // 中身追従で高さが変わったとき上端(maxY)を保つようフレームを張り直す。
        NotificationCenter.default.addObserver(
            self, selector: #selector(panelDidResize(_:)),
            name: NSWindow.didResizeNotification, object: panel)
        // ユーザーがドラッグで窓を動かしたら、その位置を新しい上端基準として採用する。
        NotificationCenter.default.addObserver(
            self, selector: #selector(panelDidMove(_:)),
            name: NSWindow.didMoveNotification, object: panel)

        // メニューバー常駐を起動。窓の表示/非表示はクロージャ経由で AppDelegate に委ねる。
        let sb = StatusBarController(store: store)
        sb.setWindowVisible = { [weak self] visible in
            guard let panel = self?.panel else { return }
            if visible {
                if panel.isMiniaturized { panel.deminiaturize(nil) }
                panel.orderFrontRegardless()
            } else {
                panel.orderOut(nil)
            }
        }
        self.statusBar = sb
    }

    /// 中身追従で高さが変わったとき、上端(maxY)を固定したままリサイズする。
    /// NSPanel は左下原点なので、何もしないと高さ変化で窓が上下にずれて見える。
    @objc private func panelDidResize(_ note: Notification) {
        guard let panel = panel, !isAdjustingFrame else { return }
        guard let top = anchorTopY else { anchorTopY = panel.frame.maxY; return }
        let newOriginY = top - panel.frame.height
        if abs(panel.frame.origin.y - newOriginY) < 0.5 { return }  // 既に上端維持済み
        var frame = panel.frame
        frame.origin.y = newOriginY
        isAdjustingFrame = true
        panel.setFrame(frame, display: true)   // animate せず即時反映
        isAdjustingFrame = false
    }

    /// ドラッグ等で窓を動かしたら、以降のリサイズ基準を現在の上端に更新する。
    /// （isMovableByWindowBackground=true なので背景ドラッグ移動が日常的に起こる）
    @objc private func panelDidMove(_ note: Notification) {
        guard let panel = panel, !isAdjustingFrame else { return }
        anchorTopY = panel.frame.maxY
    }

    /// Dock アイコンのクリックで（閉じた/最小化した後も、メニューバーで非表示にした後も）小窓を再表示する。
    /// 状態の二重管理を避けるため StatusBarController 経由（userWantsWindow=true）で表示する。
    /// メニューバーがはみ出して押せない状況からの確実な復帰口でもある。
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        statusBar?.forceShow()
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
