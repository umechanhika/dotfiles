import Cocoa
import ApplicationServices

/// WindowSnap 本体。
/// マウスでウィンドウを画面端へドラッグして離すと、その端に応じてウィンドウをスナップする常駐アプリ。
/// Dock 非表示（.accessory / LSUIElement）。メニューバーに常駐し、launchd で常駐起動する。
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var eventTap: EventTap?
    private let dragger = WindowDragger()
    private var statusItem: StatusItem?
    private var permissionTimer: Timer?
    private var sigtermSource: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = StatusItem()
        installSignalHandler()
        ensureAccessibilityThenStart()
    }

    /// アクセシビリティ権限を確認し、付与済みなら EventTap を開始する。
    /// 未付与ならプロンプトを出し、付与されるまで Timer(2秒間隔)で再確認する。
    /// （権限が無いと CGEventTap は作れない/即無効化されるため、付与を待ってから start する）
    private func ensureAccessibilityThenStart() {
        if isAccessibilityTrusted(prompt: true), startTapping() {
            return
        }
        permissionTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.isAccessibilityTrusted(prompt: false), self.startTapping() {
                self.permissionTimer?.invalidate()
                self.permissionTimer = nil
            }
        }
    }

    private func isAccessibilityTrusted(prompt: Bool) -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    /// EventTap を生成して監視を開始する。成功したら true。
    /// 権限はあるが何らかの理由でタップを作れない場合は false（呼び出し側が再試行する）。
    @discardableResult
    private func startTapping() -> Bool {
        if eventTap != nil { return true }
        guard let tap = EventTap(onEvent: { [weak self] type, event in
            self?.dragger.handle(type, event)
        }) else {
            return false
        }
        tap.start()
        eventTap = tap
        NSLog("WindowSnap: 監視を開始しました。")
        return true
    }

    /// launchd からの SIGTERM で綺麗に終了する（runloop を止める）。
    private func installSignalHandler() {
        signal(SIGTERM, SIG_IGN)   // デフォルトの即時終了を無効化し、下のソースで受ける。
        let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        src.setEventHandler { NSApp.terminate(nil) }
        src.resume()
        sigtermSource = src
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // Dock 非表示（メニューバーのみ）
app.run()
