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

    /// 表示対象状態（waiting=対応待ち / done=結果確認）にあるセッションの ID 集合。
    /// どちらもユーザーがウィンドウを開いて対応・確認しに行く状態。新規出現/全解消のエッジ検出に使う。
    /// 空で開始するので、起動時に既存の対象があれば最初の reload で newlyActionable として
    /// 検出され表示される（＝起動時に対象があれば表示、無ければ初期非表示のまま）。
    /// sink 初回は必ず空配列なので、ベースライン確立ガードのような特殊分岐は不要。
    private var knownActionableIDs: Set<String> = []

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
        // sessions の変化を購読して、ウィンドウの表示制御（waiting 連動）とメニューバー描画を更新する。
        // （ContentView の @ObservedObject と同じデータ源。書き込む状態が別なので順序非依存。）
        store.$sessions
            .receive(on: RunLoop.main)
            .sink { [weak self] sessions in
                self?.updateVisibility(for: sessions)
                self?.render(for: sessions)
            }
            .store(in: &cancellables)
        render(for: store.sessions)
    }

    deinit {
        // プロセス終了時は自動で消えるが、行儀よく明示的に破棄する。
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    // MARK: - 表示状態の制御

    /// メニューバーアイコンのクリック。表示/非表示トグルは廃止し、前面化のみ行う。
    /// （隠すのはウィンドウの最小化/閉じる、または waiting 全解消による自動非表示で行う。）
    @objc private func statusItemClicked(_ sender: Any?) {
        setWindowVisible?(true)
    }

    /// Dock アイコンのクリック等からの確実な前面化口。
    func forceShow() {
        setWindowVisible?(true)
    }

    /// 表示対象（waiting / done）の発生・全解消エッジに連動してウィンドウを出し入れする。
    /// - 新規に waiting/done になったセッション（known に無い ID。起動時の既存も含む）→ 表示。
    /// - 対象が全て解消（waiting も done も無くなる＝全て processing/idle）→ 非表示。
    /// - 継続中（同じ対象のまま・新規なし）→ 何もしない＝ユーザーが最小化/閉じた状態を尊重。
    ///   30秒ポーリングの再評価でも勝手に復活させないため、件数ではなく ID 集合のエッジで判定する。
    /// 表示パス（orderFrontRegardless）はフォーカスを奪わない。
    private func updateVisibility(for sessions: [Session]) {
        // waiting（対応待ち）と done（結果確認）は、どちらもユーザーがウィンドウを開いて
        // 対応・確認しに行く状態。これらを「表示対象」とする。
        let current = Set(sessions.filter { $0.category == .waiting || $0.category == .done }
                                  .map { $0.id })
        let newlyActionable = current.subtracting(knownActionableIDs)
        let hadActionable = !knownActionableIDs.isEmpty
        knownActionableIDs = current

        if !newlyActionable.isEmpty {
            setWindowVisible?(true)          // 新規の waiting/done → 表示
        } else if hadActionable && current.isEmpty {
            setWindowVisible?(false)         // 対象が全解消 → 非表示
        }
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
