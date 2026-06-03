import Cocoa
import Combine
import SwiftUI

/// メニューバー（NSStatusBar）に常駐し、ステータス別の件数を色付きドット「●」で表示する。
/// アイコンのクリックでフローティングウィンドウの表示/非表示をトグルする。
///
/// ウィンドウ（NSPanel）の実体は AppDelegate が握っているので、表示制御は
/// `setWindowVisible` クロージャ経由で委譲し、依存方向を一方向（Controller→AppDelegate）に
/// 保つ。これは ITermFocus / SessionStore.onAllSessionsEnded と同じ「制御を呼び出し元へ委ねる」流儀。
final class StatusBarController {
    private let statusItem: NSStatusItem
    private var cancellables = Set<AnyCancellable>()

    /// フローティングウィンドウを表示したいか。初期 true（常に表示のまま）。
    /// メニューバーのクリックでトグルし、値が変わったときだけ `setWindowVisible` を呼ぶ。
    private var userWantsWindow = true { didSet { applyVisibility() } }
    /// 直近で `setWindowVisible` に渡した値。変化時のみ作用させてチラつき・無駄な再描画を防ぐ。
    private var lastApplied: Bool?

    /// AppDelegate が panel を出し入れするためのクロージャ。
    var setWindowVisible: ((Bool) -> Void)?

    /// メニューバーでの表示順：done(緑) → processing(青) → waiting(黄) → idle(灰)。
    private static let displayOrder: [Session.StatusCategory] = [.done, .processing, .waiting, .idle]

    /// メニューバーのアイコン(SF Symbol)とテキストで共有する基準サイズ。
    /// システム標準サイズ(≈13pt)。小さめにしたい/大きくしたい場合はここだけ変える。
    private static let glyphPointSize = NSFont.systemFontSize

    init(store: SessionStore) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.target = self
            button.action = #selector(statusItemClicked(_:))
        }
        // sessions の変化を購読して表示を更新する（ContentView の @ObservedObject と同じデータ源）。
        store.$sessions
            .receive(on: RunLoop.main)
            .sink { [weak self] sessions in self?.render(for: sessions) }
            .store(in: &cancellables)
        render(for: store.sessions)
    }

    deinit {
        // プロセス終了時は自動で消えるが、行儀よく明示的に破棄する。
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    // MARK: - 表示状態の制御

    @objc private func statusItemClicked(_ sender: Any?) {
        userWantsWindow.toggle()
    }

    /// Dock アイコンのクリック等からの確実な復帰口。常に表示側へ倒す。
    func forceShow() {
        userWantsWindow = true
    }

    private func applyVisibility() {
        guard userWantsWindow != lastApplied else { return }
        lastApplied = userWantsWindow
        setWindowVisible?(userWantsWindow)
    }

    // MARK: - 描画

    /// ステータス別の件数を集計し、件数 > 0 のカテゴリだけ「●＋数字」で並べる。
    /// 分類は `Session.category`（= `Session.color` と同一の分類根拠）に従う。
    private func render(for sessions: [Session]) {
        guard let button = statusItem.button else { return }
        let counts = Dictionary(grouping: sessions, by: { $0.category }).mapValues { $0.count }

        // 件数 0 のカテゴリは出さない。
        let visible: [(Session.StatusCategory, Int)] = Self.displayOrder.compactMap { category in
            let count = counts[category] ?? 0
            return count > 0 ? (category, count) : nil
        }

        if visible.isEmpty {
            // セッション 0 件（全終了直前の一瞬）。控えめなプレースホルダにする。
            button.attributedTitle = NSAttributedString(string: "")
            let config = NSImage.SymbolConfiguration(pointSize: Self.glyphPointSize, weight: .regular)
            button.image = NSImage(systemSymbolName: "circle.dotted", accessibilityDescription: "AgentManager")?
                .withSymbolConfiguration(config)
            button.toolTip = "AgentManager"
            return
        }
        button.image = nil

        // メニューバーに馴染むシステム標準サイズのフォント。● は数字よりやや沈むので baselineOffset で微調整。
        let font = NSFont.systemFont(ofSize: Self.glyphPointSize)
        let result = NSMutableAttributedString()
        for (index, pair) in visible.enumerated() {
            let (category, count) = pair
            if index > 0 { result.append(NSAttributedString(string: " ")) }
            result.append(NSAttributedString(
                string: "\u{25CF}",   // ● BLACK CIRCLE
                attributes: [
                    .foregroundColor: NSColor(Session.color(for: category)),
                    .font: font,
                    .baselineOffset: -0.5,
                ]))
            result.append(NSAttributedString(
                string: "\(count)",
                attributes: [
                    .foregroundColor: NSColor.labelColor,   // ダーク/ライト追従
                    .font: font,
                ]))
        }
        button.attributedTitle = result
        button.toolTip = Self.tooltip(counts: counts)
    }

    private static func tooltip(counts: [Session.StatusCategory: Int]) -> String {
        "緑\(counts[.done] ?? 0) 青\(counts[.processing] ?? 0) 黄\(counts[.waiting] ?? 0) 灰\(counts[.idle] ?? 0)"
    }
}
