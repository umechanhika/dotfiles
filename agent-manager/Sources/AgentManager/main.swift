import Cocoa
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: NSPanel?
    private let store = SessionStore()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let hosting = NSHostingView(rootView: ContentView(store: store))
        hosting.translatesAutoresizingMaskIntoConstraints = false

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 230, height: 120),
            styleMask: [.nonactivatingPanel, .titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        // タイトルバーを隠してドラッグ可能な小窓に。
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.isMovableByWindowBackground = true

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
        NSApp.activate(ignoringOtherApps: true)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // Dock に出さず常駐
app.run()
