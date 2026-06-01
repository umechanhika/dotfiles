import Cocoa
import CoreGraphics

/// 全画面のマウスイベントを listenOnly(観測のみ)で監視する CGEventTap のラッパ。
///
/// listenOnly はイベントを書き換えないので、他アプリの操作を一切邪魔しない（遅延も最小）。
/// アクセシビリティ権限が無いとタップは作れない/即無効化されるため、権限付与後に生成すること。
final class EventTap {
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private let onEvent: (CGEventType, CGEvent) -> Void

    /// 監視対象: 左ボタンの down / drag / up。
    private static let mask: CGEventMask =
        (1 << CGEventType.leftMouseDown.rawValue) |
        (1 << CGEventType.leftMouseDragged.rawValue) |
        (1 << CGEventType.leftMouseUp.rawValue)

    /// 生成。権限が無い等でタップを作れなければ nil を返す。
    init?(onEvent: @escaping (CGEventType, CGEvent) -> Void) {
        self.onEvent = onEvent
        // callback は C 関数ポインタ（コンテキストをキャプチャできない）。
        // refcon に self の生ポインタを渡し、callback 内で取り出して委譲する。
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: EventTap.mask,
            callback: EventTap.callback,
            userInfo: refcon
        ) else {
            return nil
        }
        self.tap = tap
    }

    /// runloop に登録してタップを有効化する。
    func start() {
        guard let tap = tap else { return }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        runLoopSource = source
    }

    func stop() {
        if let tap = tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
        }
        runLoopSource = nil
    }

    /// C コールバック。非キャプチャなので C 関数ポインタに変換できる。
    /// refcon から self を取り出して Swift メソッドへ委譲する。
    private static let callback: CGEventTapCallBack = { _, type, event, refcon in
        if let refcon = refcon {
            let me = Unmanaged<EventTap>.fromOpaque(refcon).takeUnretainedValue()
            me.handle(type: type, event: event)
        }
        // listenOnly なのでイベントはそのまま素通しする。
        return Unmanaged.passUnretained(event)
    }

    private func handle(type: CGEventType, event: CGEvent) {
        // タップが無効化されたら必ず張り直す。
        // 重い処理でのタイムアウト(.tapDisabledByTimeout)やシステム入力(.tapDisabledByUserInput;
        // Mission Control 等)で OS が勝手に無効化することがあるため、再有効化しないと以後反応しない。
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = tap { CGEvent.tapEnable(tap: tap, enable: true) }
            // 無効化はドラッグの中断（Mission Control 起動など）を意味するので、
            // ハンドラにも通知してプレビューを片付けさせる（残留対策）。
            onEvent(type, event)
            return
        }
        onEvent(type, event)
    }
}
